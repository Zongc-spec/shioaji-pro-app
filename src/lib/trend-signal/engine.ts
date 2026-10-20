// src/lib/trend-signal/engine.ts — Trend Signal Pro 引擎：同一份已收 1m
// → 四週期狀態、5m BUY/SELL、1m 觸發、虛擬部位（P3，只顯示、不送單）。
//
// 時間序：逐根已收 1m（label t）依序處理
//   1. label < t 尚未處理的已收 5m（那一根之前就已收盤）
//   2. 這根的開盤：待成交進場、5m 反轉出場、下一根生效的停損
//   3. 盤中：停損觸價（含跳空）
//   4. 已收 K 棒才判定：1R 保本、2R／3R 停利與移動停損啟動
//   5. label == t 的已收 5m：BUY/SELL、反轉、移動停損
//   6. 1m 觸發（引用 5m 最新已收狀態）
// 進行中的 1m 只做 2、3（開盤價與已發生的觸價都不會再改變）。
// 同一輸入永遠得到同一輸出；任何時點只用該時點以前已收的 K 棒。

import { atr, ema, stoch } from '../indicators';
import type { Candle } from '../types/market';
import { alignPoints, buildTf, confirmed1m, lastAtOrBefore, sessionVwap } from './bars';
import { configKey, TSP_ALGO_VERSION } from './config';
import { planRisk, swingPoint, trailStop } from './risk';
import { isSessionOpen, tradingSessionOf, wallTime } from './session';
import { alignmentOf, computeTrend, keyLevels, transitionAt } from './trend';
import { evalSetup } from './trigger';
import type {
    AuditEvent,
    CandidateStatus,
    Direction,
    EntryTrigger,
    ExitReason,
    HtfContext,
    M1Indicators,
    M1Phase,
    RiskPlan,
    StopChange,
    TfSeries,
    TfSnapshot,
    TrendSeries,
    TrendSignal,
    TrendSignalInput,
    TrendSignalResult,
    TrendState,
    VirtualTrade,
} from './types';

const pad = (n: number) => String(n).padStart(2, '0');
function isoMinute(t: number): string {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const dirWord = (d: Direction) => (d === 'LONG' ? '多' : '空');

interface PendingEntry {
    trigger: EntryTrigger;
    plan: RiskPlan;
    swing: number | undefined;
    atr: number;
}

export function runTrendSignal(input: TrendSignalInput): TrendSignalResult {
    const cfg = input.config;
    const key = configKey(cfg);
    const sec = input.securityType;
    const tick = input.tick;
    const asOf = input.asOf;
    const bars1 = confirmed1m(input.bars1m, asOf);
    const m1 = buildTf(bars1, 1, sec, asOf);
    const m5 = buildTf(bars1, 5, sec, asOf);
    const m15 = buildTf(bars1, 15, sec, asOf);
    const m60 = buildTf(bars1, 60, sec, asOf);
    const tp = {
        stPeriod: cfg.stPeriod,
        stMult: cfg.stMult,
        emaPeriod: cfg.emaPeriod,
        emaSlopeBars: cfg.emaSlopeBars,
        atrPeriod: cfg.atrPeriod,
    };
    const t5 = computeTrend(m5.bars, tp);
    const t15 = computeTrend(m15.bars, tp);
    const t60 = computeTrend(m60.bars, tp);
    const kd = stoch(m1.bars, cfg.kdPeriod, cfg.kdK, cfg.kdD);
    const m1Ind: M1Indicators = {
        ema: alignPoints(m1.bars, ema(m1.bars, cfg.ema1m)),
        atr: alignPoints(m1.bars, atr(m1.bars, cfg.atr1m)),
        vwap: sessionVwap(m1.bars, m1.session),
        k: alignPoints(m1.bars, kd.k),
        d: alignPoints(m1.bars, kd.d),
        session: m1.session,
    };

    const idBase = `${key}|${input.symbol}|${input.contractMonth}`;
    const slip = cfg.slipTicks * tick;
    const events: AuditEvent[] = [];
    const log = (time: number, kind: AuditEvent['kind'], ref: string, text: string) =>
        events.push({ time, kind, ref, text });

    const htfAt = (t: number, s5: TrendState): HtfContext => {
        const i15 = lastAtOrBefore(m15.bars, t);
        const i60 = lastAtOrBefore(m60.bars, t);
        const s15: TrendState = i15 >= 0 ? t15.state[i15]! : 'UNKNOWN';
        const s60: TrendState = i60 >= 0 ? t60.state[i60]! : 'UNKNOWN';
        return {
            m15: s15,
            m60: s60,
            m15Align: alignmentOf(s15, s5),
            m60Align: alignmentOf(s60, s5),
            m15BarTime: i15 >= 0 ? m15.bars[i15]!.time : null,
            m60BarTime: i60 >= 0 ? m60.bars[i60]!.time : null,
        };
    };

    // ---- 5m BUY/SELL（候選訊號）----
    const signals: TrendSignal[] = [];
    const signalAt = new Map<number, TrendSignal>();
    for (let i = 0; i < m5.bars.length; i++) {
        const kind = transitionAt(t5.state, i);
        if (!kind) continue;
        const bar = m5.bars[i]!;
        const sess = tradingSessionOf(sec, m5.lastMinute[i]!);
        const direction: Direction = kind === 'BUY' ? 'LONG' : 'SHORT';
        const sig: TrendSignal = {
            id: `${idBase}|${sess.key}|5m|${isoMinute(bar.time)}|${kind}`,
            kind,
            direction,
            barTime: bar.time,
            index: i,
            session: sess.key,
            prevState: t5.state[i - 1]!,
            close: bar.close,
            st: t5.st[i]!,
            ema: t5.ema[i]!,
            atr: t5.atr[i],
            // 接下來 candidateBars 根 5m，不跨盤別（收盤即失效）
            expiresAt: Math.min(bar.time + cfg.candidateBars * 300, sess.end),
            htf: htfAt(bar.time, direction),
        };
        signals.push(sig);
        signalAt.set(i, sig);
    }

    // ---- 逐根已收 1m：觸發與虛擬部位 ----
    const triggers: EntryTrigger[] = [];
    const trades: VirtualTrade[] = [];
    const used = new Set<string>();
    // 以 as 宣告：這些狀態只在下方的閉包裡改寫，避免 TS 把外層讀取窄化成 null
    let trade = null as VirtualTrade | null;
    let pendingEntry = null as PendingEntry | null;
    let pendingExit = null as { signal: TrendSignal } | null;
    let pendingStop = null as { stop: number; reason: StopChange['reason'] } | null;
    let latest = null as TrendSignal | null;
    let j5 = -1; // 最後處理的 5m
    let state5 = 'UNKNOWN' as TrendState;

    const better = (dir: Direction, a: number, b: number) => (dir === 'LONG' ? Math.max(a, b) : Math.min(a, b));
    const queueStop = (stop: number, reason: StopChange['reason']) => {
        if (!trade) return;
        const dir = trade.direction;
        const base = pendingStop?.stop ?? trade.stop;
        if (better(dir, base, stop) === base) return; // 不比目前（或已排定）的更有利
        pendingStop = { stop, reason };
    };

    const closeQty = (t: number, price: number, qty: number, reason: ExitReason) => {
        if (!trade || qty <= 0) return;
        const sign = trade.direction === 'LONG' ? 1 : -1;
        const q = Math.min(qty, trade.openQty);
        trade.fills.push({ time: t, price, qty: q, reason });
        trade.openQty -= q;
        const points = sign * (price - trade.fillPrice) * q;
        trade.realizedPoints += points;
        // 每口來回手續費；滑價已反映在成交價
        trade.realizedNtd += points * trade.plan.pointValue - 2 * cfg.feePerSide * q;
        log(t, 'EXIT', trade.id, `${exitText(reason)} ${q} 口 @ ${price}`);
        if (trade.openQty === 0) {
            trade.status = 'CLOSED';
            trade.exitReason = reason;
            trade.closedAt = t;
            trade = null;
            pendingExit = null;
            pendingStop = null;
        }
    };

    const process5m = (j: number) => {
        j5 = j;
        const prevState = state5;
        state5 = t5.state[j]!;
        const bar = m5.bars[j]!;
        const sig = signalAt.get(j);
        if (sig) {
            latest = sig;
            log(bar.time, 'SIGNAL', sig.id, `5m ${sig.kind}（${sig.prevState} → ${state5}），1m 可進場至 ${wallTime(sig.expiresAt)}`);
            if (trade && trade.direction !== sig.direction) {
                pendingExit = { signal: sig };
                log(bar.time, 'WARN', trade.id, `5m 確認反轉 ${sig.kind}：下一根 1m 開盤平${dirWord(trade.direction)}（不自動反手）`);
            }
        }
        if (trade && state5 === 'NEUTRAL' && prevState !== 'NEUTRAL') {
            log(bar.time, 'WARN', trade.id, '5m 轉為 NEUTRAL：趨勢減弱警告（不自動平倉）');
        }
        if (trade && trade.trailing && !pendingExit) {
            const dir = trade.direction;
            const up = t5.stUp[j];
            const support = up === (dir === 'LONG') ? t5.st[j] : undefined;
            const next = trailStop(dir, pendingStop?.stop ?? trade.stop, support, trade.extreme, t5.atr[j], tick, cfg.trailAtr);
            queueStop(next, 'trail');
            const through = dir === 'LONG' ? next >= bar.close : next <= bar.close;
            if (pendingStop?.reason === 'trail' && through) {
                log(bar.time, 'WARN', trade.id, `移動停損 ${next} 已在 5m 收盤 ${bar.close} 的錯誤一側：不建立觸價單，下一根開盤立即處理`);
            }
        }
    };

    const openAt = (t: number, open: number) => {
        // 2. 開盤事件
        if (pendingEntry) {
            const pe = pendingEntry;
            pendingEntry = null;
            const dir = pe.trigger.direction;
            const fill = dir === 'LONG' ? open + slip : open - slip;
            const plan = planRisk({
                direction: dir,
                entry: fill,
                entryBasis: 'fill',
                swing: pe.swing,
                atr: pe.atr,
                tick,
                pointValue: input.pointValue,
                cfg,
                fixedQty: pe.plan.qty,
            });
            if (plan.status !== 'OK') {
                log(t, 'WARN', pe.trigger.id, `成交價 ${fill} 無法重新定價（${plan.reason ?? '風控拒絕'}），虛擬單取消`);
                return;
            }
            const vt: VirtualTrade = {
                id: `${pe.trigger.id}|VT`,
                triggerId: pe.trigger.id,
                signalId: pe.trigger.signalId,
                direction: dir,
                signalTime: pe.trigger.barTime,
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
            log(t, 'FILL', vt.id, `虛擬${dirWord(dir)}單 ${plan.qty} 口 @ ${fill}（訊號 ${wallTime(pe.trigger.barTime)}），停損 ${plan.stop}，R ${plan.riskPoints} 點`);
            for (const w of vt.warnings) log(t, 'WARN', vt.id, w);
        }
        if (trade && pendingExit) {
            const px = trade.direction === 'LONG' ? open - slip : open + slip;
            closeQty(t, px, trade.openQty, 'REVERSAL');
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
        // 3. 停損觸價：觸及即出；開盤已穿過停損以開盤價成交
        if (!trade) return;
        const long = trade.direction === 'LONG';
        if (long ? bar.low > trade.stop : bar.high < trade.stop) return;
        const px = long ? Math.min(trade.stop, bar.open) - slip : Math.max(trade.stop, bar.open) + slip;
        const reason: ExitReason = trade.stopKind === 'initial' ? 'STOP' : trade.stopKind === 'breakeven' ? 'BREAKEVEN_STOP' : 'TRAIL_STOP';
        closeQty(t, px, trade.openQty, reason);
    };

    const targetCheck = (t: number, bar: Candle) => {
        // 4. 已收 K 棒的目標判定（同一根觸及停損時上一步已出場）
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

    const evalTrigger = (m: number) => {
        // 6. 1m 觸發：5m 最新已收狀態與候選同向、候選未逾期
        const bar = m1.bars[m]!;
        const t = bar.time;
        const cand: TrendSignal | null = latest;
        if (!cand || state5 !== cand.direction) return;
        if (!(t > cand.barTime && t <= cand.expiresAt)) return;
        const setup = evalSetup(m1.bars, m1Ind, m, cand.direction, cfg);
        if (setup.stage !== 'READY') return;
        const dir = cand.direction;
        const ref5 = m5.bars[j5]!.time;
        const htf = htfAt(t, state5);
        const atr1 = m1Ind.atr[m]!;
        const base: EntryTrigger = {
            id: `${idBase}|${m1.session[m]}|1m|${isoMinute(t)}|${dir === 'LONG' ? 'BUY' : 'SELL'}`,
            signalId: cand.id,
            direction: dir,
            barTime: t,
            index: m,
            session: m1.session[m]!,
            close: bar.close,
            ema: m1Ind.ema[m]!,
            vwap: m1Ind.vwap[m],
            k: m1Ind.k[m]!,
            d: m1Ind.d[m]!,
            atr: atr1,
            touched: setup.touched!,
            status: 'ACCEPTED',
            reason: '',
            plan: null,
            refs: { m5: ref5, m15: htf.m15BarTime, m60: htf.m60BarTime },
            htf,
        };
        let trig: EntryTrigger;
        if (trade || pendingEntry) {
            trig = { ...base, status: 'SKIPPED_POSITION', reason: '已有虛擬部位，不加碼' };
        } else if (used.has(cand.id)) {
            trig = { ...base, status: 'SKIPPED_USED', reason: '此 5m 候選已進場過一次' };
        } else if (setup.chase) {
            trig = { ...base, status: 'REJECTED_CHASE', reason: `KD K=${base.k.toFixed(1)} 追價過濾` };
        } else if (!setup.volumeOk) {
            trig = { ...base, status: 'REJECTED_VOLUME', reason: '成交量低於近 20 根平均' };
        } else {
            const swing = swingPoint(m1.bars, m, cfg.swingBars, dir);
            const plan = planRisk({ direction: dir, entry: bar.close, entryBasis: 'estimate', swing, atr: atr1, tick, pointValue: input.pointValue, cfg });
            if (plan.status !== 'OK') {
                trig = { ...base, status: 'REJECTED_RISK', reason: plan.reason ?? '風控拒絕', plan };
            } else {
                trig = { ...base, plan, reason: '待人工確認（觀察模式不送單）' };
                used.add(cand.id);
                pendingEntry = { trigger: trig, plan, swing, atr: atr1 };
            }
        }
        triggers.push(trig);
        log(t, 'TRIGGER', trig.id, `1m ${dir === 'LONG' ? 'BUY' : 'SELL'} ${trig.status}${trig.reason ? `：${trig.reason}` : ''}`);
    };

    let next5 = 0;
    for (let m = 0; m < m1.bars.length; m++) {
        const bar = m1.bars[m]!;
        const t = bar.time;
        while (next5 < m5.bars.length && m5.bars[next5]!.time < t) process5m(next5++);
        openAt(t, bar.open);
        stopCheck(t, bar);
        targetCheck(t, bar);
        while (next5 < m5.bars.length && m5.bars[next5]!.time === t) process5m(next5++);
        evalTrigger(m);
    }
    while (next5 < m5.bars.length) process5m(next5++);

    // 進行中的 1m：只處理開盤成交與已發生的停損觸價
    const live = input.live;
    const lastConfirmed = m1.bars[m1.bars.length - 1]?.time ?? -Infinity;
    if (live && live.time > asOf && live.time > lastConfirmed) {
        openAt(live.time, live.open);
        stopCheck(live.time, live);
    }

    // ---- 快照 ----
    const tfSnap = (s: TfSeries, tr: TrendSeries, i: number, m5State: TrendState): TfSnapshot => {
        const lv = keyLevels(s.bars, i, cfg.keyBars);
        const state: TrendState = i >= 0 ? tr.state[i]! : 'UNKNOWN';
        return {
            tf: s.tf,
            state,
            barTime: i >= 0 ? s.bars[i]!.time : null,
            close: i >= 0 ? s.bars[i]!.close : undefined,
            st: i >= 0 ? tr.st[i] : undefined,
            stUp: i >= 0 ? tr.stUp[i] : undefined,
            ema: i >= 0 ? tr.ema[i] : undefined,
            atr: i >= 0 ? tr.atr[i] : undefined,
            align: s.tf === 5 ? 'NEUTRAL' : alignmentOf(state, m5State),
            keyHigh: lv?.high,
            keyLow: lv?.low,
        };
    };
    const s5 = tfSnap(m5, t5, m5.bars.length - 1, 'UNKNOWN');
    const s15 = tfSnap(m15, t15, m15.bars.length - 1, s5.state);
    const s60 = tfSnap(m60, t60, m60.bars.length - 1, s5.state);
    const cand: TrendSignal | null = latest;
    let candStatus: CandidateStatus = 'NONE';
    if (cand) {
        candStatus = used.has(cand.id) ? 'USED'
            : asOf > cand.expiresAt ? 'EXPIRED'
                : s5.state !== cand.direction ? 'CANCELLED' : 'ACTIVE';
    }
    const mLast = m1.bars.length - 1;
    const lastTrigger = triggers[triggers.length - 1] ?? null;
    let phase: M1Phase = 'UNKNOWN';
    let pullback: number | undefined;
    let against = false;
    const openTrade: VirtualTrade | null = trade;
    if (mLast >= 0) {
        if (openTrade) {
            phase = 'IN_POSITION';
            const e = m1Ind.ema[mLast];
            const k = m1Ind.k[mLast];
            const d = m1Ind.d[mLast];
            const c = m1.bars[mLast]!.close;
            if (e !== undefined && k !== undefined && d !== undefined) {
                against = openTrade.direction === 'LONG' ? c < e && k < d : c > e && k > d;
            }
        } else if (cand && candStatus === 'ACTIVE') {
            if (lastTrigger && lastTrigger.barTime === m1.bars[mLast]!.time) {
                phase = lastTrigger.status === 'ACCEPTED' ? 'TRIGGERED' : 'REJECTED';
            } else {
                const ev = evalSetup(m1.bars, m1Ind, mLast, cand.direction, cfg);
                pullback = ev.pullback;
                phase = ev.stage === 'NO_DATA' ? 'UNKNOWN' : ev.stage === 'WAIT_PULLBACK' ? 'WAIT_PULLBACK'
                    : ev.stage === 'WAIT_RECLAIM' ? 'WAIT_RECLAIM' : 'WAIT_KD';
            }
        } else {
            phase = 'NO_CANDIDATE';
        }
    }
    const lastBar1 = mLast >= 0 ? m1.bars[mLast]! : undefined;
    return {
        version: TSP_ALGO_VERSION,
        configKey: key,
        asOf,
        securityType: sec,
        symbol: input.symbol,
        contractMonth: input.contractMonth,
        m1,
        m5,
        m15,
        m60,
        m1Ind,
        t5,
        t15,
        t60,
        signals,
        triggers,
        trades,
        events,
        snapshot: {
            m5: s5,
            m15: s15,
            m60: s60,
            m1: {
                barTime: lastBar1?.time ?? null,
                close: lastBar1?.close,
                ema: mLast >= 0 ? m1Ind.ema[mLast] : undefined,
                vwap: mLast >= 0 ? m1Ind.vwap[mLast] : undefined,
                k: mLast >= 0 ? m1Ind.k[mLast] : undefined,
                d: mLast >= 0 ? m1Ind.d[mLast] : undefined,
                atr: mLast >= 0 ? m1Ind.atr[mLast] : undefined,
                phase,
                pullback,
                against,
            },
            candidate: { signal: cand, status: candStatus },
            htfAgainst: s15.align === 'DIVERGE' && s60.align === 'DIVERGE',
            trade: openTrade ?? trades[trades.length - 1] ?? null,
            lastTrigger,
            pendingEntry: pendingEntry ? { trigger: pendingEntry.trigger, plan: pendingEntry.plan } : null,
            pendingExit: pendingExit && openTrade ? { signalId: pendingExit.signal.id } : null,
        },
        dataLagSec: lastBar1 ? asOf - lastBar1.time : null,
        sessionOpen: isSessionOpen(sec, asOf),
    };
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
