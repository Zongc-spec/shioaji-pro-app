// src/lib/trend-signal/engine.ts — Trend Signal Pro 組裝（V1.1 §2 的四個模組）：
//   core         同一份 1m → 已收 1m／5m／15m／60m
//   TrendCore    5m 狀態與切換（BUY／SELL）、失效；1m 微型趨勢；15m／60m 輔助
//   MtfContext   任一時點當時已知的各週期狀態與是否過期（只註記，不否決 5m）
//   EntryTiming  每段 5m 趨勢內各候選的 1m 提示
//   RiskPlanner  依設定模式的提示產生虛擬部位（不送單）
// 依賴單向：下游只讀上游的輸出，訊號不會因進場或風控參數改變。同一輸入永遠
// 得到同一輸出；任何時點只用該時點以前已收的 K 棒；5m 只用資料完整的桶。
// 「已收」由呼叫端的 asOf 決定（即時運作見 core/feed.ts：以資料進度而非牆鐘確認）。

import { atr } from '../indicators';
import type { Candle } from '../types/market';
import { alignPoints, buildTf, completeOnly, confirmed1m, freshAt, holeBefore } from './core/bars';
import { isSessionOpen, wallHm, wallIso, wallTime } from './core/session';
import { configKey, entryKey, microParams, riskKey, TSP_ALGO_VERSION, trendKey } from './config';
import { runVirtual } from './risk/virtual';
import { tfAt } from './trend/mtf';
import { alignmentOf, emaNote, emaSeries, invalidAt, keyLevels, rsiSeries, switchAt, trendAge, trendTrack } from './trend/signals';
import { computeEntries } from './trigger/entries';
import type {
    AuditEvent,
    NoteParams,
    TfSeries,
    TfSnapshot,
    TrendInvalidation,
    TrendSignal,
    TrendSignalInput,
    TrendSignalResult,
    TrendState,
    TrendTrack,
} from './types';

function unknownTrack(s: TfSeries, algo: TrendTrack['algo']): TrendTrack {
    return { tf: s.tf, algo, line: s.bars.map(() => undefined), dir: s.bars.map(() => 'UNKNOWN'), stopLine: false };
}

/** 最後一根已收 K 棒的狀態（收盤後保留的定盤桶 label 可能晚於 asOf，仍是已收） */
function tfSnapshot(s: TfSeries, tr: TrendTrack, note: NoteParams, m5Dir: TrendState | null, asOf: number, sessionOpen: boolean): TfSnapshot {
    const i = s.bars.length - 1;
    const bar = i >= 0 ? s.bars[i] : undefined;
    const dir: TrendState = i >= 0 ? tr.dir[i]! : 'UNKNOWN';
    // 只取最後一根的 ATR／RSI：用最近 300 根計算即可（兩者皆為因果遞迴，已收斂）
    const tail = s.bars.slice(Math.max(0, i - 299), i + 1);
    const a = tail.length ? alignPoints(tail, atr(tail, note.atrPeriod))[tail.length - 1] : undefined;
    const r = tail.length ? rsiSeries(tail, note)[tail.length - 1] : undefined;
    const line = i >= 0 ? tr.line[i] : undefined;
    const lv = keyLevels(s.bars, i, note.keyBars);
    return {
        tf: s.tf,
        dir,
        barTime: bar?.time ?? null,
        close: bar?.close,
        line,
        age: trendAge(tr.dir, i),
        distAtr: bar && line !== undefined && a !== undefined && a > 0 ? (bar.close - line) / a : undefined,
        atr: a,
        rsi: r,
        align: m5Dir === null ? 'NEUTRAL' : alignmentOf(dir, m5Dir),
        keyHigh: lv?.high,
        keyLow: lv?.low,
        stale: sessionOpen && !freshAt(bar?.time, asOf, s.tf),
        incomplete: i >= 0 && s.missing[i]! > 0,
    };
}

export function runTrendSignal(input: TrendSignalInput): TrendSignalResult {
    const cfg = input.config;
    const sec = input.securityType;
    const asOf = input.asOf;
    const sessionOpen = isSessionOpen(sec, asOf);

    // ---- core ----
    const bars1: Candle[] = confirmed1m(input.bars1m, asOf);
    const m1 = buildTf(bars1, 1, sec, asOf);
    // 5m 只用完整的桶：缺任何正規交易分鐘的 5m 不參與趨勢計算，也不產生訊號、提示或虛擬進場
    const { series: m5, gaps } = completeOnly(buildTf(bars1, 5, sec, asOf));
    const m15 = buildTf(bars1, 15, sec, asOf);
    const m60 = buildTf(bars1, 60, sec, asOf);

    // ---- TrendCore（只讀 core 與趨勢參數）----
    const t5 = trendTrack(m5, cfg.trend);
    const t1 = trendTrack(m1, microParams(cfg));
    const t15 = input.skipHtf ? unknownTrack(m15, cfg.trend.algo) : trendTrack(m15, cfg.trend);
    const t60 = input.skipHtf ? unknownTrack(m60, cfg.trend.algo) : trendTrack(m60, cfg.trend);
    const ema5 = emaSeries(m5.bars, cfg.note);
    const atr5 = alignPoints(m5.bars, atr(m5.bars, cfg.note.atrPeriod));

    const idBase = `${trendKey(cfg)}|${input.symbol}|${input.contractMonth}`;
    const signals: TrendSignal[] = [];
    const invalidations: TrendInvalidation[] = [];
    for (let i = 0; i < m5.bars.length; i++) {
        const bar = m5.bars[i]!;
        const from = invalidAt(t5.dir, i);
        if (from) {
            invalidations.push({ id: `${idBase}|${m5.session[i]}|5m|${wallIso(bar.time)}|INVALID`, barTime: bar.time, index: i, from });
        }
        const kind = switchAt(t5.dir, i);
        if (!kind) continue;
        // ---- MtfContext：訊號當時已知的 15m／60m（只註記）----
        const h15 = tfAt(m15, t15, bar.time);
        const h60 = tfAt(m60, t60, bar.time);
        const d5 = t5.dir[i]!;
        signals.push({
            id: `${idBase}|${m5.session[i]}|5m|${wallIso(bar.time)}|${kind}`,
            kind,
            direction: kind === 'BUY' ? 'LONG' : 'SHORT',
            barTime: bar.time,
            index: i,
            session: m5.session[i]!,
            sessionEnd: m5.sessionEnd[i]!,
            close: bar.close,
            line: t5.line[i],
            atr: atr5[i],
            notes: {
                ema: emaNote(m5.bars, ema5, i, kind, cfg.note.emaSlopeBars),
                m15: h15.state,
                m60: h60.state,
                m15Align: alignmentOf(h15.state, d5),
                m60Align: alignmentOf(h60.state, d5),
                m15BarTime: h15.barTime,
                m60BarTime: h60.barTime,
                m15Stale: h15.stale,
                m60Stale: h60.stale,
                m15Incomplete: h15.incomplete,
                m60Incomplete: h60.incomplete,
            },
        });
    }

    // ---- EntryTiming（只讀 5m 狀態、訊號與已收 1m）----
    const timing = computeEntries({
        signals,
        m1: m1.bars,
        m1Session: m1.session,
        m1SessionEnd: m1.sessionEnd,
        // 5m 桶內出現缺口後的 1m 不提示（缺口所在的 5m 已排除，提示也不能用不完整的資料）
        m1Hole: holeBefore(bars1, sec),
        m5: m5.bars,
        dir5: t5.dir,
        micro: t1.dir,
        asOf,
        p: cfg.entry,
        key: entryKey(cfg),
    });
    const entries = timing.entries;
    const selected = entries.filter((e) => e.mode === cfg.entry.mode);

    // ---- RiskPlanner（只讀訊號、失效、設定模式的提示與 K 棒）----
    const v = runVirtual({
        m1: m1.bars,
        m1SessionEnd: m1.sessionEnd,
        live: input.live ?? null,
        asOf,
        m5,
        t5,
        signals,
        invalidations,
        entries: selected,
        cfg: cfg.risk,
        tick: input.tick,
        pointValue: input.pointValue,
        taxRate: input.taxRate ?? 0,
        key: riskKey(cfg),
    });

    // ---- 審計與快照 ----
    const events: AuditEvent[] = [];
    for (const s of signals) {
        const n = s.notes;
        events.push({
            time: s.barTime,
            kind: 'SIGNAL',
            ref: s.id,
            text: `5m ${s.kind} @ ${s.close}（趨勢線 ${s.line ?? '—'}；EMA ${n.ema}；15m ${n.m15}${n.m15Stale ? '（過期）' : ''}／60m ${n.m60}${n.m60Stale ? '（過期）' : ''}）`,
        });
    }
    for (const x of invalidations) {
        events.push({ time: x.barTime, kind: 'INVALID', ref: x.id, text: `5m ${x.from === 'LONG' ? '多' : '空'}方趨勢失效 → NEUTRAL（不是反向訊號）` });
    }
    for (const e of selected) {
        events.push({ time: e.barTime, kind: 'ENTRY', ref: e.id, text: `1m 進場提示 ${e.mode} 第 ${e.seq} 次 ${e.direction === 'LONG' ? '多' : '空'} @ ${e.refPrice}（${e.reason}）` });
    }
    for (const g of gaps) {
        events.push({
            time: g.label,
            kind: 'DATA',
            ref: `${idBase}|5m|${wallIso(g.label)}|GAP`,
            text: `5m ${wallHm(g.label)} 缺 ${g.missing} 根 1m：資料不完整，已排除（不參與趨勢計算，不產生訊號、提示或虛擬進場）`,
        });
    }
    events.push(...v.events);
    events.sort((a, b) => a.time - b.time);
    const lastGap = gaps[gaps.length - 1];

    const s5 = tfSnapshot(m5, t5, cfg.note, null, asOf, sessionOpen);
    const s1 = tfSnapshot(m1, t1, cfg.note, s5.dir, asOf, sessionOpen);
    const s15 = tfSnapshot(m15, t15, cfg.note, s5.dir, asOf, sessionOpen);
    const s60 = tfSnapshot(m60, t60, cfg.note, s5.dir, asOf, sessionOpen);
    const latest = signals[signals.length - 1] ?? null;
    const lastInvalid = invalidations[invalidations.length - 1] ?? null;
    const open = v.open;
    const lastBar1 = m1.bars[m1.bars.length - 1];
    return {
        version: TSP_ALGO_VERSION,
        configKey: configKey(cfg),
        taxRate: input.taxRate ?? 0,
        asOf,
        securityType: sec,
        symbol: input.symbol,
        contractMonth: input.contractMonth,
        m1,
        m5,
        m15,
        m60,
        t1,
        t5,
        t15,
        t60,
        ema5,
        signals,
        invalidations,
        gaps,
        entries,
        trades: v.trades,
        events,
        snapshot: {
            m1: s1,
            m5: s5,
            m15: s15,
            m60: s60,
            signal: latest,
            invalid: lastInvalid && (!latest || lastInvalid.barTime > latest.barTime) ? lastInvalid : null,
            recentGap: lastGap && asOf - lastGap.label <= 1800 ? lastGap : null,
            entries: timing.states,
            htfAgainst: s15.align === 'DIVERGE' && s60.align === 'DIVERGE',
            trade: open ?? v.trades[v.trades.length - 1] ?? null,
            pendingEntry: v.pendingEntry,
            pendingExit: v.pendingExit,
            m1Against: !!open && (s1.dir === 'LONG' || s1.dir === 'SHORT') && s1.dir !== open.direction,
        },
        dataLagSec: lastBar1 ? asOf - lastBar1.time : null,
        sessionOpen,
    };
}

/** 給 UI 與審計匯出用的時間字串 */
export const fmtWall = wallTime;
