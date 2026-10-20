// src/lib/trend-signal/risk/virtual.ts — 虛擬部位（只顯示、不送任何委託）。
// 依設定的進場模式事件在下一根 1m 開盤虛擬成交；停損、保本、移動停損與分層
// 停利；5m 反向切換在下一根 1m 開盤平倉（不等 1m）。只讀訊號、進場事件與
// 已收 K 棒，不回寫任何訊號。
//
// 時間序：逐根已收 1m（label t）
//   1. label < t 尚未處理的已收 5m（那一根之前就已收盤）
//   2. 啟用 barTime < t 的進場事件
//   3. 這根的開盤：5m 反向平倉 → 待成交進場 → 下一根生效的停損
//   4. 盤中：停損觸價（含跳空）— 保護性停損永遠獨立有效
//   5. 已收 K 棒才判定：+1R 保本、+2R／+3R 停利與移動停損啟動
//   6. label == t 的已收 5m：反向訊號排定平倉、更新移動停損
//   7. 啟用 barTime == t 的進場事件
// 進行中的 1m 只做 2–4（開盤價與已發生的觸價不會再改變）。

import { atr } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints, lastAtOrBefore } from '../core/bars';
import { wallTime } from '../core/session';
import type {
    AuditEvent,
    Direction,
    EntryEvent,
    ExitReason,
    RiskConfig,
    RiskPlan,
    StopChange,
    TfSeries,
    TrendSignal,
    TrendTrack,
    VirtualTrade,
} from '../types';
import { planRisk, swingPoint, trailStop } from './plan';

export interface VirtualInput {
    /** 已收 1m */
    m1: Candle[];
    live: Candle | null;
    asOf: number;
    m5: TfSeries;
    /** 5m 趨勢（移動停損讀它的線；唯讀） */
    t5: TrendTrack;
    signals: TrendSignal[];
    /** 只放風控採用的那一種模式的事件 */
    entries: EntryEvent[];
    cfg: RiskConfig;
    tick: number;
    pointValue: number | null;
    /** 風控參數指紋（虛擬部位 ID 用） */
    key: string;
}

export interface VirtualOutput {
    trades: VirtualTrade[];
    events: AuditEvent[];
    open: VirtualTrade | null;
    pendingEntry: { entry: EntryEvent; plan: RiskPlan } | null;
    pendingExit: { signalId: string } | null;
}

export function exitText(reason: ExitReason): string {
    switch (reason) {
        case 'STOP': return '初始停損';
        case 'BREAKEVEN_STOP': return '保本停損';
        case 'TRAIL_STOP': return '移動停損';
        case 'TP2R': return '2R 停利';
        case 'TP3R': return '3R 停利';
        case 'REVERSAL': return '5m 反轉平倉';
    }
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
    const slip = cfg.slipTicks * tick;
    const atr1 = alignPoints(m1, atr(m1, 14));
    const atr5 = alignPoints(m5.bars, atr(m5.bars, 14));
    const signalById = new Map(inp.signals.map((s) => [s.id, s]));
    const signalAtIndex = new Map(inp.signals.map((s) => [s.index, s]));
    const queue = inp.entries.filter((e) => e.status === 'TRIGGERED' && e.barTime !== null)
        .sort((a, b) => a.barTime! - b.barTime!);
    let q = 0;

    const events: AuditEvent[] = [];
    const log = (time: number, kind: AuditEvent['kind'], ref: string, text: string) => events.push({ time, kind, ref, text });
    const trades: VirtualTrade[] = [];
    // 以 as 宣告：這些狀態只在下方的閉包裡改寫，避免 TS 把外層讀取窄化成 null
    let trade = null as VirtualTrade | null;
    let pendingEntry = null as PendingEntry | null;
    let pendingExit = null as { signal: TrendSignal } | null;
    let pendingStop = null as { stop: number; reason: StopChange['reason'] } | null;

    const better = (dir: Direction, a: number, b: number) => (dir === 'LONG' ? Math.max(a, b) : Math.min(a, b));
    const queueStop = (stop: number, reason: StopChange['reason']) => {
        if (!trade) return;
        const base = pendingStop?.stop ?? trade.stop;
        if (better(trade.direction, base, stop) === base) return; // 不比目前（或已排定）的更有利
        pendingStop = { stop, reason };
    };

    const closeQty = (t: number, price: number, qty: number, reason: ExitReason) => {
        if (!trade || qty <= 0) return;
        const sign = trade.direction === 'LONG' ? 1 : -1;
        const n = Math.min(qty, trade.openQty);
        trade.fills.push({ time: t, price, qty: n, reason });
        trade.openQty -= n;
        const points = sign * (price - trade.fillPrice) * n;
        trade.realizedPoints += points;
        trade.realizedNtd += points * trade.plan.pointValue - 2 * cfg.feePerSide * n;
        log(t, 'EXIT', trade.id, `${exitText(reason)} ${n} 口 @ ${price}`);
        if (trade.openQty === 0) {
            trade.status = 'CLOSED';
            trade.exitReason = reason;
            trade.closedAt = t;
            trade = null;
            pendingExit = null;
            pendingStop = null;
        }
    };

    // 進場事件 → 等待下一根 1m 開盤成交（風控在此以參考價預估計畫）
    const activate = (upTo: number, inclusive: boolean) => {
        while (q < queue.length) {
            const e = queue[q]!;
            const bt = e.barTime!;
            if (inclusive ? bt > upTo : bt >= upTo) break;
            q++;
            const sig = signalById.get(e.signalId);
            if (!sig) continue;
            if (pendingEntry) {
                log(bt, 'WARN', e.id, '已有待成交的虛擬進場，略過');
                continue;
            }
            // 反向平倉已排定時允許：下一根開盤先平倉、再進場（兩筆獨立紀錄）
            if (trade && !pendingExit) {
                log(bt, 'WARN', e.id, '已有虛擬部位，不加碼');
                continue;
            }
            const idx = lastAtOrBefore(m1, bt);
            const swing = idx >= 1 ? swingPoint(m1, idx, cfg.swingBars, e.direction) : undefined;
            const a = idx >= 0 ? atr1[idx] : undefined;
            const plan = planRisk({
                direction: e.direction,
                entry: e.refPrice!,
                entryBasis: 'estimate',
                swing,
                atr: a,
                tick,
                pointValue: inp.pointValue,
                cfg,
            });
            if (plan.status !== 'OK' || a === undefined) {
                log(bt, 'WARN', e.id, `${e.mode} 進場被風控拒絕：${plan.reason ?? '1m ATR 不足'}`);
                continue;
            }
            pendingEntry = { entry: e, plan, swing, atr: a, sessionEnd: sig.sessionEnd };
            log(bt, 'ENTRY', e.id, `${e.mode} ${dirWord(e.direction)}單觸發（${e.reason}），待下一根 1m 開盤虛擬成交（觀察模式不送單）`);
        }
    };

    const process5m = (j: number) => {
        const bar = m5.bars[j]!;
        const sig = signalAtIndex.get(j);
        if (sig && trade && trade.direction !== sig.direction) {
            pendingExit = { signal: sig };
            log(bar.time, 'WARN', trade.id, `5m 確認反向 ${sig.kind}：下一根 1m 開盤平${dirWord(trade.direction)}（不等 1m）`);
        }
        if (trade && trade.trailing && !pendingExit) {
            const dir = trade.direction;
            const want = dir === 'LONG' ? 'UP' : 'DOWN';
            const support = t5.stopLine && t5.dir[j] === want ? t5.line[j] : undefined;
            const next = trailStop(dir, pendingStop?.stop ?? trade.stop, support, trade.extreme, atr5[j], tick, cfg.trailAtr);
            queueStop(next, 'trail');
            const through = dir === 'LONG' ? next >= bar.close : next <= bar.close;
            if (pendingStop?.reason === 'trail' && pendingStop.stop === next && through) {
                log(bar.time, 'WARN', trade.id, `移動停損 ${next} 已在 5m 收盤 ${bar.close} 的錯誤一側：不建立觸價單，下一根開盤立即處理`);
            }
        }
    };

    const openAt = (t: number, open: number) => {
        if (trade && pendingExit) {
            const px = trade.direction === 'LONG' ? open - slip : open + slip;
            closeQty(t, px, trade.openQty, 'REVERSAL');
        }
        if (pendingEntry && !trade) {
            const pe = pendingEntry;
            pendingEntry = null;
            if (t > pe.sessionEnd) {
                log(t, 'WARN', pe.entry.id, '進場成交 K 棒已跨到下一盤，取消（不跨盤進場）');
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
                    cfg,
                    fixedQty: pe.plan.qty,
                });
                if (plan.status !== 'OK') {
                    log(t, 'WARN', pe.entry.id, `成交價 ${fill} 無法重新定價（${plan.reason ?? '風控拒絕'}），虛擬單取消`);
                } else {
                    const vt: VirtualTrade = {
                        id: `${pe.entry.id}|VT#${inp.key}`,
                        entryId: pe.entry.id,
                        entryMode: pe.entry.mode,
                        signalId: pe.entry.signalId,
                        direction: dir,
                        signalTime: pe.entry.barTime!,
                        fillTime: t,
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
                        realizedNtd: 0,
                        warnings: [],
                    };
                    if (plan.overBudget) {
                        vt.warnings.push(`成交價重新定價後預估風險 NT$${Math.round(plan.totalRisk)} 超過預算 NT$${cfg.budget}`);
                    }
                    trades.push(vt);
                    trade = vt;
                    log(t, 'FILL', vt.id, `虛擬${dirWord(dir)}單 ${plan.qty} 口 @ ${fill}（觸發 ${wallTime(pe.entry.barTime!)}），停損 ${plan.stop}，R ${plan.riskPoints} 點`);
                    for (const w of vt.warnings) log(t, 'WARN', vt.id, w);
                }
            }
        }
        if (trade && pendingStop) {
            trade.stop = pendingStop.stop;
            trade.stopKind = pendingStop.reason;
            trade.stopHistory.push({ time: t, stop: pendingStop.stop, reason: pendingStop.reason });
            log(t, 'STOP_MOVE', trade.id, `${pendingStop.reason === 'breakeven' ? '保本' : '移動'}停損 → ${pendingStop.stop}`);
            pendingStop = null;
        }
    };

    const stopCheck = (t: number, bar: Candle) => {
        if (!trade) return;
        const long = trade.direction === 'LONG';
        if (long ? bar.low > trade.stop : bar.high < trade.stop) return;
        const px = long ? Math.min(trade.stop, bar.open) - slip : Math.max(trade.stop, bar.open) + slip;
        const reason: ExitReason = trade.stopKind === 'initial' ? 'STOP' : trade.stopKind === 'breakeven' ? 'BREAKEVEN_STOP' : 'TRAIL_STOP';
        closeQty(t, px, trade.openQty, reason);
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
            if (p.tiers.r2 > 0) closeQty(t, p.r2, p.tiers.r2, 'TP2R');
        }
        if (trade === vt && vt.hit.r3 === null && reached(p.r3)) {
            vt.hit.r3 = t;
            log(t, 'TARGET', vt.id, `+3R ${p.r3} 到價`);
            if (p.tiers.r3 > 0) closeQty(t, p.r3, p.tiers.r3, 'TP3R');
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
    const px: { signal: TrendSignal } | null = pendingExit;
    return {
        trades,
        events,
        open,
        pendingEntry: pe ? { entry: pe.entry, plan: pe.plan } : null,
        pendingExit: px && open ? { signalId: px.signal.id } : null,
    };
}
