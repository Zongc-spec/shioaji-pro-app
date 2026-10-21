// src/lib/trend-signal/risk/virtual.ts — 虛擬部位（只顯示、不送任何委託）。
// 依設定模式的 1m 提示在下一根 1m 開盤虛擬成交；停損、保本、移動停損與分層停利；
// 5m 反向切換或趨勢失效在下一根 1m 開盤平倉（不等 1m）。同一段趨勢可多次提示：
// 空手時才接受（停損出場後可再進場），持倉或待成交時略過、不加碼。只讀訊號、
// 失效事件、進場提示與已收 K 棒，不回寫任何訊號。
//
// 時間序：逐根已收 1m（label t）
//   1. label < t 尚未處理的已收 5m（那一根之前就已收盤）
//   2. 啟用 barTime < t 的提示
//   3. 這根的開盤：5m 反向／失效平倉 → 待成交進場 → 下一根生效的停損
//   4. 盤中：停損觸價（含跳空）— 保護性停損永遠獨立有效
//   5. 已收 K 棒才判定：+1R 保本、+2R／+3R 停利與移動停損啟動
//   6. label == t 的已收 5m：反向訊號或失效排定平倉、更新移動停損
//   7. 啟用 barTime == t 的提示
// 進行中的 1m 只做 2–4（開盤價與已發生的觸價不會再改變）。
// 時間：成交與出場記成交所在 1m 的收盤 label，並標示 open（開盤，時刻 label − 60）或
// intrabar（盤中觸價）；審計事件的時間一律用實際發生的時刻（見 AuditEvent.time）。

import { atr } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints, lastAtOrBefore } from '../core/bars';
import { wallHm, wallTime } from '../core/session';
import type {
    AuditEvent,
    Direction,
    EntryEvent,
    ExitReason,
    RiskConfig,
    RiskPlan,
    StopChange,
    TfSeries,
    TradeFill,
    TrendInvalidation,
    TrendSignal,
    TrendTrack,
    VirtualTrade,
} from '../types';
import { futuresTax, planRisk, swingPoint, trailStop } from './plan';

export interface VirtualInput {
    /** 本圖週期模式的 K 棒時鐘；省略時精確保留原 1m/5m 模型。 */
    clock?: {
        baseLabel: string;
        trendLabel: string;
        openTime: (label: number) => number;
        isNext: (from: number, to: number) => boolean;
    };
    /** 已收 1m 與每根所屬交易時段的收盤 label */
    m1: Candle[];
    m1SessionEnd: number[];
    live: Candle | null;
    asOf: number;
    m5: TfSeries;
    /** 5m 趨勢（移動停損讀它的線；唯讀） */
    t5: TrendTrack;
    signals: TrendSignal[];
    invalidations: TrendInvalidation[];
    /** 只放風控採用的那一種模式的提示 */
    entries: EntryEvent[];
    cfg: RiskConfig;
    tick: number;
    pointValue: number | null;
    /** 期交稅率（單邊）；0 = 不計 */
    taxRate: number;
    /** 風控參數指紋（虛擬部位 ID 用） */
    key: string;
}

type TrendExit = { ref: string; reason: 'REVERSAL' | 'TREND_INVALID' };

export interface VirtualOutput {
    trades: VirtualTrade[];
    events: AuditEvent[];
    open: VirtualTrade | null;
    pendingEntry: { entry: EntryEvent; plan: RiskPlan } | null;
    pendingExit: TrendExit | null;
}

export function exitText(reason: ExitReason): string {
    switch (reason) {
        case 'STOP': return '初始停損';
        case 'BREAKEVEN_STOP': return '保本停損';
        case 'TRAIL_STOP': return '移動停損';
        case 'TP2R': return '2R 停利';
        case 'TP3R': return '3R 停利';
        case 'REVERSAL': return '5m 反轉平倉';
        case 'TREND_INVALID': return '5m 失效平倉';
    }
}

/** 成交發生在 1m K 棒（收盤 label）的哪裡：開盤＝label − 60 那一刻；盤中＝label − 60 到 label 之間 */
export function fillWhen(label: number, at: TradeFill['at']): string {
    return at === 'open' ? `${wallHm(label - 60)} 開盤` : `${wallHm(label - 60)}–${wallHm(label)} 盤中`;
}

const dirWord = (d: Direction) => (d === 'LONG' ? '多' : '空');

interface PendingEntry {
    entry: EntryEvent;
    plan: RiskPlan;
    swing: number | undefined;
    atr: number;
    sessionEnd: number;
}

export function runVirtual(inp: VirtualInput): VirtualOutput {
    const { m1, m5, t5, cfg, tick } = inp;
    const openTime = inp.clock?.openTime ?? ((t: number) => t - 60);
    const baseLabel = inp.clock?.baseLabel ?? '1m';
    const trendLabel = inp.clock?.trendLabel ?? '5m';
    const clockText = baseLabel.startsWith('1D') ? wallTime : wallHm;
    const when = (t: number, at: TradeFill['at']) => inp.clock
        ? at === 'open' ? `${clockText(openTime(t))} ${baseLabel}開盤` : `${clockText(openTime(t))}–${clockText(t)} ${baseLabel}棒內`
        : fillWhen(t, at);
    const reasonText = (reason: ExitReason) => exitText(reason).replace('5m', trendLabel);
    const slip = cfg.slipTicks * tick;
    const atr1 = alignPoints(m1, atr(m1, 14));
    const atr5 = alignPoints(m5.bars, atr(m5.bars, 14));
    const signalAtIndex = new Map(inp.signals.map((s) => [s.index, s]));
    const invalidAtIndex = new Map(inp.invalidations.map((v) => [v.index, v]));
    const queue = [...inp.entries].sort((a, b) => a.barTime - b.barTime);
    let q = 0;

    const events: AuditEvent[] = [];
    const log = (time: number, kind: AuditEvent['kind'], ref: string, text: string) => events.push({ time, kind, ref, text });
    const trades: VirtualTrade[] = [];
    // 以 as 宣告：這些狀態只在下方的閉包裡改寫，避免 TS 把外層讀取窄化成 null
    let trade = null as VirtualTrade | null;
    let pendingEntry = null as PendingEntry | null;
    let pendingExit = null as TrendExit | null;
    let pendingStop = null as { stop: number; reason: StopChange['reason'] } | null;

    const better = (dir: Direction, a: number, b: number) => (dir === 'LONG' ? Math.max(a, b) : Math.min(a, b));
    const queueStop = (stop: number, reason: StopChange['reason']) => {
        if (!trade) return;
        const base = pendingStop?.stop ?? trade.stop;
        if (better(trade.direction, base, stop) === base) return; // 不比目前（或已排定）的更有利
        pendingStop = { stop, reason };
    };

    const closeQty = (t: number, price: number, qty: number, reason: ExitReason, at: TradeFill['at']) => {
        if (!trade || qty <= 0) return;
        const sign = trade.direction === 'LONG' ? 1 : -1;
        const n = Math.min(qty, trade.openQty);
        const pv = trade.plan.pointValue;
        const previouslyClosedQty = trade.qty - trade.openQty;
        trade.fills.push({ time: t, at, price, qty: n, reason });
        trade.openQty -= n;
        const points = sign * (price - trade.fillPrice) * n;
        trade.realizedPoints += points;
        // 進場稅以累計平倉口數分攤，確保分批加總等於整筆進場口數取整的稅額。
        const entryTax = futuresTax(trade.fillPrice, pv, inp.taxRate, previouslyClosedQty + n) -
            futuresTax(trade.fillPrice, pv, inp.taxRate, previouslyClosedQty);
        const cost = 2 * cfg.feePerSide * n + entryTax + futuresTax(price, pv, inp.taxRate, n);
        trade.costNtd += cost;
        trade.realizedNtd += points * pv - cost;
        log(at === 'open' ? openTime(t) : t, 'EXIT', trade.id, `${reasonText(reason)} ${n} 口 @ ${price}（${when(t, at)}）`);
        if (trade.openQty === 0) {
            trade.status = 'CLOSED';
            trade.exitReason = reason;
            trade.closedAt = t;
            trade = null;
            pendingExit = null;
            pendingStop = null;
        }
    };

    // 提示 → 等待下一根 1m 開盤成交（風控在此以參考價預估計畫）
    const activate = (upTo: number, inclusive: boolean) => {
        while (q < queue.length) {
            const e = queue[q]!;
            const bt = e.barTime;
            if (inclusive ? bt > upTo : bt >= upTo) break;
            q++;
            if (pendingEntry) {
                log(bt, 'WARN', e.id, '已有待成交的虛擬進場，略過這次提示');
                continue;
            }
            // 反向平倉已排定時允許：下一根開盤先平倉、再進場（兩筆獨立紀錄）
            if (trade && !pendingExit) {
                log(bt, 'WARN', e.id, '已有虛擬部位，略過這次提示（不加碼）');
                continue;
            }
            const idx = lastAtOrBefore(m1, bt);
            // 初始停損依 stopTf：5＝提示當下已收的主趨勢 5m 的結構與波動，1＝進場的 1m
            const j5 = cfg.stopTf === 5 ? lastAtOrBefore(m5.bars, bt) : -1;
            const swing = cfg.stopTf === 5
                ? (j5 >= 1 ? swingPoint(m5.bars, j5, cfg.swingBars, e.direction) : undefined)
                : (idx >= 1 ? swingPoint(m1, idx, cfg.swingBars, e.direction) : undefined);
            const a = cfg.stopTf === 5 ? (j5 >= 0 ? atr5[j5] : undefined) : (idx >= 0 ? atr1[idx] : undefined);
            const plan = planRisk({
                direction: e.direction,
                entry: e.refPrice,
                entryBasis: 'estimate',
                swing,
                atr: a,
                tick,
                pointValue: inp.pointValue,
                taxRate: inp.taxRate,
                cfg,
            });
            if (plan.status !== 'OK' || a === undefined || idx < 0) {
                log(bt, 'WARN', e.id, `${e.mode} 提示被風控拒絕：${plan.reason ?? `${baseLabel} ATR 不足`}`);
                continue;
            }
            pendingEntry = { entry: e, plan, swing, atr: a, sessionEnd: inp.m1SessionEnd[idx]! };
            log(bt, 'PLAN', e.id, `${e.mode} 第 ${e.seq} 次${dirWord(e.direction)}單提示（${e.reason}），待下一根 ${baseLabel} 開盤虛擬成交（觀察模式不送單）`);
        }
    };

    const process5m = (j: number) => {
        const bar = m5.bars[j]!;
        const sig = signalAtIndex.get(j);
        const inv = invalidAtIndex.get(j);
        if (trade && sig && trade.direction !== sig.direction) {
            pendingExit = { ref: sig.id, reason: 'REVERSAL' };
            log(bar.time, 'WARN', trade.id, `${trendLabel} 確認反向 ${sig.kind}：下一根 ${baseLabel} 開盤平${dirWord(trade.direction)}${inp.clock ? '' : '（不等 1m）'}`);
        } else if (trade && inv && inv.from === trade.direction) {
            pendingExit = { ref: inv.id, reason: 'TREND_INVALID' };
            log(bar.time, 'WARN', trade.id, `${trendLabel} ${dirWord(inv.from)}方趨勢失效（NEUTRAL）：下一根 ${baseLabel} 開盤平${dirWord(trade.direction)}${inp.clock ? '' : '（不等 1m）'}`);
        }
        if (trade && trade.trailing && !pendingExit) {
            const dir = trade.direction;
            const support = t5.stopLine && t5.dir[j] === dir ? t5.line[j] : undefined;
            const next = trailStop(dir, pendingStop?.stop ?? trade.stop, support, trade.extreme, atr5[j], tick, cfg.trailAtr);
            queueStop(next, 'trail');
            const through = dir === 'LONG' ? next >= bar.close : next <= bar.close;
            if (pendingStop?.reason === 'trail' && pendingStop.stop === next && through) {
                log(bar.time, 'WARN', trade.id, `移動停損 ${next} 已在 ${trendLabel} 收盤 ${bar.close} 的錯誤一側：不建立觸價單，下一根開盤立即處理`);
            }
        }
    };

    const openAt = (t: number, open: number) => {
        if (trade && pendingExit) {
            const px = trade.direction === 'LONG' ? open - slip : open + slip;
            closeQty(t, px, trade.openQty, pendingExit.reason, 'open');
        }
        if (pendingEntry && !trade) {
            const pe = pendingEntry;
            pendingEntry = null;
            if (inp.clock ? openTime(t) >= pe.sessionEnd : t > pe.sessionEnd) {
                log(openTime(t), 'WARN', pe.entry.id, '進場成交 K 棒已跨到下一盤，取消（不跨盤進場）');
            } else if (inp.clock ? !inp.clock.isNext(pe.entry.barTime, t) : t !== pe.entry.barTime + 60) {
                log(openTime(t), 'WARN', pe.entry.id, `下一根 ${baseLabel} 缺資料，取消虛擬進場（不延後到下一根現存 K 棒）`);
            } else {
                const dir = pe.entry.direction;
                const fill = dir === 'LONG' ? open + slip : open - slip;
                // R 在成交後固定：以成交價重新定價，口數維持觸發時的計畫
                const plan = planRisk({
                    direction: dir,
                    entry: fill,
                    entryBasis: 'fill',
                    swing: pe.swing,
                    atr: pe.atr,
                    tick,
                    pointValue: inp.pointValue,
                    taxRate: inp.taxRate,
                    cfg,
                    fixedQty: pe.plan.qty,
                });
                if (plan.status !== 'OK') {
                    log(openTime(t), 'WARN', pe.entry.id, `成交價 ${fill} 無法重新定價（${plan.reason ?? '風控拒絕'}），虛擬單取消`);
                } else {
                    const vt: VirtualTrade = {
                        id: `${pe.entry.id}|VT#${inp.key}`,
                        entryId: pe.entry.id,
                        entryMode: pe.entry.mode,
                        signalId: pe.entry.signalId,
                        direction: dir,
                        signalTime: pe.entry.barTime,
                        fillTime: t,
                        fillAt: openTime(t),
                        fillPrice: fill,
                        plan,
                        qty: plan.qty,
                        openQty: plan.qty,
                        stop: plan.stop,
                        stopKind: 'initial',
                        stopHistory: [{ time: t, stop: plan.stop, reason: 'initial' }],
                        trailing: false,
                        hit: { r1: null, r2: null, r3: null },
                        extreme: fill,
                        fills: [],
                        status: 'OPEN',
                        exitReason: null,
                        closedAt: null,
                        realizedPoints: 0,
                        costNtd: 0,
                        realizedNtd: 0,
                        warnings: [],
                    };
                    if (plan.overBudget) {
                        vt.warnings.push(`成交價重新定價後預估風險 NT$${Math.round(plan.totalRisk)} 超過預算 NT$${cfg.budget}`);
                    }
                    trades.push(vt);
                    trade = vt;
                    log(openTime(t), 'FILL', vt.id, `虛擬${dirWord(dir)}單 ${plan.qty} 口 @ ${fill}（${when(t, 'open')}；${clockText(pe.entry.barTime)} 收棒的提示），停損 ${plan.stop}，R ${plan.riskPoints} 點`);
                    for (const w of vt.warnings) log(openTime(t), 'WARN', vt.id, w);
                }
            }
        }
        if (trade && pendingStop) {
            trade.stop = pendingStop.stop;
            trade.stopKind = pendingStop.reason;
            trade.stopHistory.push({ time: t, stop: pendingStop.stop, reason: pendingStop.reason });
            log(openTime(t), 'STOP_MOVE', trade.id, `${pendingStop.reason === 'breakeven' ? '保本' : '移動'}停損 → ${pendingStop.stop}（${clockText(openTime(t))} 開盤起生效）`);
            pendingStop = null;
        }
    };

    const stopCheck = (t: number, bar: Candle) => {
        if (!trade) return;
        const long = trade.direction === 'LONG';
        if (long ? bar.low > trade.stop : bar.high < trade.stop) return;
        // 開盤就越過停損（跳空）：以開盤價成交；否則是盤中觸價
        const gapped = long ? bar.open <= trade.stop : bar.open >= trade.stop;
        const px = long ? Math.min(trade.stop, bar.open) - slip : Math.max(trade.stop, bar.open) + slip;
        const reason: ExitReason = trade.stopKind === 'initial' ? 'STOP' : trade.stopKind === 'breakeven' ? 'BREAKEVEN_STOP' : 'TRAIL_STOP';
        closeQty(t, px, trade.openQty, reason, gapped ? 'open' : 'intrabar');
    };

    const targetCheck = (t: number, bar: Candle) => {
        if (!trade) return;
        const vt = trade;
        const long = vt.direction === 'LONG';
        vt.extreme = long ? Math.max(vt.extreme, bar.high) : Math.min(vt.extreme, bar.low);
        const reached = (level: number) => (long ? bar.high >= level : bar.low <= level);
        const p = vt.plan;
        if (vt.hit.r1 === null && reached(p.r1)) {
            vt.hit.r1 = t;
            log(t, 'TARGET', vt.id, `+1R ${p.r1} 到價：停損移至保本 ${p.breakevenStop}（下一根生效）`);
            queueStop(p.breakevenStop, 'breakeven');
        }
        if (vt.hit.r2 === null && reached(p.r2)) {
            vt.hit.r2 = t;
            vt.trailing = true;
            log(t, 'TARGET', vt.id, `+2R ${p.r2} 到價：啟動移動停損`);
            if (p.tiers.r2 > 0) closeQty(t, p.r2, p.tiers.r2, 'TP2R', 'intrabar');
        }
        if (trade === vt && vt.hit.r3 === null && reached(p.r3)) {
            vt.hit.r3 = t;
            log(t, 'TARGET', vt.id, `+3R ${p.r3} 到價`);
            if (p.tiers.r3 > 0) closeQty(t, p.r3, p.tiers.r3, 'TP3R', 'intrabar');
        }
    };

    let next5 = 0;
    for (const bar of m1) {
        const t = bar.time;
        while (next5 < m5.bars.length && m5.bars[next5]!.time < t) process5m(next5++);
        activate(t, false);
        openAt(t, bar.open);
        stopCheck(t, bar);
        targetCheck(t, bar);
        while (next5 < m5.bars.length && m5.bars[next5]!.time === t) process5m(next5++);
        activate(t, true);
    }
    while (next5 < m5.bars.length) process5m(next5++);
    activate(inp.asOf, true);

    const live = inp.live;
    const lastConfirmed = m1[m1.length - 1]?.time ?? -Infinity;
    if (live && live.time > inp.asOf && live.time > lastConfirmed) {
        openAt(live.time, live.open);
        stopCheck(live.time, live);
    }
    const open: VirtualTrade | null = trade;
    const pe: PendingEntry | null = pendingEntry;
    const px: TrendExit | null = pendingExit;
    return {
        trades,
        events,
        open,
        pendingEntry: pe ? { entry: pe.entry, plan: pe.plan } : null,
        pendingExit: px && open ? px : null,
    };
}
