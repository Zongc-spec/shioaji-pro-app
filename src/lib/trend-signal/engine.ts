// src/lib/trend-signal/engine.ts — Trend Signal Pro 組裝：
//   core    同一份 1m → 已收 1m／5m／15m／60m
//   trend   5m 主訊號（趨勢切換）、1m 微型趨勢、15m／60m 輔助（只註記）
//   trigger 每個 5m 訊號在各進場模式的 1m 時機事件
//   risk    依設定模式的事件產生虛擬部位（不送單）
// 依賴單向：下游只讀上游的輸出，訊號不會因進場或風控參數改變。同一輸入永遠
// 得到同一輸出；任何時點只用該時點以前已收的 K 棒。

import { atr } from '../indicators';
import type { Candle } from '../types/market';
import { alignPoints, buildTf, confirmed1m, lastAtOrBefore } from './core/bars';
import { isSessionOpen, tradingSessionOf, wallTime } from './core/session';
import { entryKey, riskKey, TSP_ALGO_VERSION, configKey, trendKey } from './config';
import { runVirtual } from './risk/virtual';
import { alignmentOf, emaNote, emaSeries, keyLevels, rsiSeries, switchAt, trendAge, trendTrack } from './trend/signals';
import { computeEntries } from './trigger/entries';
import type {
    AuditEvent,
    EntryEvent,
    EntryMode,
    NoteParams,
    TfSeries,
    TfSnapshot,
    TrendDir,
    TrendSignal,
    TrendSignalInput,
    TrendSignalResult,
    TrendTrack,
} from './types';

const pad = (n: number) => String(n).padStart(2, '0');
function isoMinute(t: number): string {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function unknownTrack(s: TfSeries, algo: TrendTrack['algo']): TrendTrack {
    return { tf: s.tf, algo, line: s.bars.map(() => undefined), dir: s.bars.map(() => 'UNKNOWN'), stopLine: false };
}

function tfSnapshot(s: TfSeries, tr: TrendTrack, note: NoteParams, m5Dir: TrendDir | null): TfSnapshot {
    const i = s.bars.length - 1;
    const dir: TrendDir = i >= 0 ? tr.dir[i]! : 'UNKNOWN';
    const bar = i >= 0 ? s.bars[i] : undefined;
    // 只取最後一根的 ATR／RSI：用最近 300 根計算即可（兩者皆為因果遞迴，已收斂）
    const tail = s.bars.slice(Math.max(0, i - 299));
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
    };
}

export function runTrendSignal(input: TrendSignalInput): TrendSignalResult {
    const cfg = input.config;
    const sec = input.securityType;
    const asOf = input.asOf;

    // ---- core ----
    const bars1: Candle[] = confirmed1m(input.bars1m, asOf);
    const m1 = buildTf(bars1, 1, sec, asOf);
    const m5 = buildTf(bars1, 5, sec, asOf);
    const m15 = buildTf(bars1, 15, sec, asOf);
    const m60 = buildTf(bars1, 60, sec, asOf);

    // ---- trend（只讀 core 與趨勢參數）----
    const t5 = trendTrack(m5, cfg.trend);
    // 1m 微型趨勢：一律用 1m SuperTrend（倍數由進場參數決定），與核心演算法的選擇無關
    const t1 = trendTrack(m1, { ...cfg.trend, algo: 'supertrend', stMult: cfg.entry.microMult });
    const t15 = input.skipHtf ? unknownTrack(m15, cfg.trend.algo) : trendTrack(m15, cfg.trend);
    const t60 = input.skipHtf ? unknownTrack(m60, cfg.trend.algo) : trendTrack(m60, cfg.trend);
    const ema5 = emaSeries(m5.bars, cfg.note);
    const atr5 = alignPoints(m5.bars, atr(m5.bars, cfg.note.atrPeriod));

    const idBase = `${trendKey(cfg)}|${input.symbol}|${input.contractMonth}`;
    const signals: TrendSignal[] = [];
    for (let i = 0; i < m5.bars.length; i++) {
        const kind = switchAt(t5.dir, i);
        if (!kind) continue;
        const bar = m5.bars[i]!;
        const sess = tradingSessionOf(sec, m5.lastMinute[i]!);
        const i15 = lastAtOrBefore(m15.bars, bar.time);
        const i60 = lastAtOrBefore(m60.bars, bar.time);
        const d15: TrendDir = i15 >= 0 ? t15.dir[i15]! : 'UNKNOWN';
        const d60: TrendDir = i60 >= 0 ? t60.dir[i60]! : 'UNKNOWN';
        const d5 = t5.dir[i]!;
        signals.push({
            id: `${idBase}|${sess.key}|5m|${isoMinute(bar.time)}|${kind}`,
            kind,
            direction: kind === 'BUY' ? 'LONG' : 'SHORT',
            barTime: bar.time,
            index: i,
            session: sess.key,
            sessionEnd: sess.end,
            close: bar.close,
            line: t5.line[i],
            atr: atr5[i],
            notes: {
                ema: emaNote(m5.bars, ema5, i, kind, cfg.note.emaSlopeBars),
                m15: d15,
                m60: d60,
                m15Align: alignmentOf(d15, d5),
                m60Align: alignmentOf(d60, d5),
                m15BarTime: i15 >= 0 ? m15.bars[i15]!.time : null,
                m60BarTime: i60 >= 0 ? m60.bars[i60]!.time : null,
            },
        });
    }

    // ---- trigger（只讀訊號與已收 1m）----
    const entries = computeEntries({
        signals,
        m1: m1.bars,
        m1Session: m1.session,
        micro: t1.dir,
        asOf,
        p: cfg.entry,
        key: entryKey(cfg),
    });

    // ---- risk（只讀訊號、設定模式的進場事件與 K 棒）----
    const v = runVirtual({
        m1: m1.bars,
        live: input.live ?? null,
        asOf,
        m5,
        t5,
        signals,
        entries: entries.filter((e) => e.mode === cfg.entry.mode),
        cfg: cfg.risk,
        tick: input.tick,
        pointValue: input.pointValue,
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
            text: `5m ${s.kind} @ ${s.close}（趨勢線 ${s.line ?? '—'}；EMA ${n.ema}；15m ${n.m15}／60m ${n.m60}）`,
        });
    }
    events.push(...v.events);
    events.sort((a, b) => a.time - b.time);

    const s5 = tfSnapshot(m5, t5, cfg.note, null);
    const s1 = tfSnapshot(m1, t1, cfg.note, s5.dir);
    const s15 = tfSnapshot(m15, t15, cfg.note, s5.dir);
    const s60 = tfSnapshot(m60, t60, cfg.note, s5.dir);
    const latest = signals[signals.length - 1] ?? null;
    const latestEntries: Partial<Record<EntryMode, EntryEvent>> = {};
    if (latest) for (const e of entries) if (e.signalId === latest.id) latestEntries[e.mode] = e;
    const open = v.open;
    const want = open?.direction === 'LONG' ? 'UP' : 'DOWN';
    const lastBar1 = m1.bars[m1.bars.length - 1];
    return {
        version: TSP_ALGO_VERSION,
        configKey: configKey(cfg),
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
        entries,
        trades: v.trades,
        events,
        snapshot: {
            m1: s1,
            m5: s5,
            m15: s15,
            m60: s60,
            signal: latest,
            entries: latestEntries,
            htfAgainst: s15.align === 'DIVERGE' && s60.align === 'DIVERGE',
            trade: open ?? v.trades[v.trades.length - 1] ?? null,
            pendingEntry: v.pendingEntry,
            pendingExit: v.pendingExit,
            m1Against: !!open && s1.dir !== 'UNKNOWN' && s1.dir !== want,
        },
        dataLagSec: lastBar1 ? asOf - lastBar1.time : null,
        sessionOpen: isSessionOpen(sec, asOf),
    };
}

/** 給 UI 與審計匯出用的時間字串 */
export const fmtWall = wallTime;
