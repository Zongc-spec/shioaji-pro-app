// src/lib/trend-signal/risk.ts — 純風控計畫（P3，只產生虛擬計畫，不送單）：
// 初始停損、固定 R 與 1R/2R/3R、新臺幣風險預算與口數、整數口數分層、
// 保本價與只往有利方向移動的移動停損。價格一律以 tick 正規化。

import type { Candle } from '../types/market';
import type { Direction, RiskPlan, TierPlan, TrendSignalConfig } from './types';

function decimalsOf(tick: number): number {
    const s = String(tick);
    const exp = /e-(\d+)$/.exec(s);
    if (exp) return Number(exp[1]);
    const i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(8, s.length - i - 1);
}

// 先加微小 epsilon 吃掉浮點誤差（20000.000000001 / 1 不該再進一格）
const EPS = 1e-9;
const fix = (v: number, tick: number) => Number(v.toFixed(decimalsOf(tick)));
export const floorTick = (p: number, tick: number) => fix(Math.floor(p / tick + EPS) * tick, tick);
export const ceilTick = (p: number, tick: number) => fix(Math.ceil(p / tick - EPS) * tick, tick);
export const roundTick = (p: number, tick: number) => fix(Math.round(p / tick) * tick, tick);

/** 往不利方向取整（多單停損往下、空單往上）— 不為了風控把停損移近 */
export const awayTick = (dir: Direction, p: number, tick: number) =>
    dir === 'LONG' ? floorTick(p, tick) : ceilTick(p, tick);
/** 往有利方向取整（目標至少 k×R） */
export const towardTick = (dir: Direction, p: number, tick: number) =>
    dir === 'LONG' ? ceilTick(p, tick) : floorTick(p, tick);

/** 最近 n 根已收 1m（結尾 m）內的確認擺動低點（多）／高點（空）：
 *  左鄰嚴格較高（低）、右鄰不低於（不高於），右鄰必須也已收 → k ≤ m − 1。
 *  多個時取最低（最高），即最保守的結構失效點。 */
export function swingPoint(bars: Candle[], m: number, n: number, dir: Direction): number | undefined {
    let best: number | undefined;
    for (let k = m - 1; k >= Math.max(1, m - n + 1); k--) {
        const cur = bars[k]!;
        const left = bars[k - 1]!;
        const right = bars[k + 1]!;
        if (dir === 'LONG') {
            if (cur.low < left.low && cur.low <= right.low) best = best === undefined ? cur.low : Math.min(best, cur.low);
        } else if (cur.high > left.high && cur.high >= right.high) {
            best = best === undefined ? cur.high : Math.max(best, cur.high);
        }
    }
    return best;
}

/** 單口來回成本（新臺幣）：手續費兩邊 + 滑價緩衝兩邊 */
export function roundTripCost(cfg: Pick<TrendSignalConfig, 'feePerSide' | 'slipTicks'>, tick: number, pointValue: number): number {
    return 2 * cfg.feePerSide + 2 * cfg.slipTicks * tick * pointValue;
}

/** 依口數分配 2R／3R／追蹤三層（整數、加總等於口數、不產生零口以外的負數） */
export function allocateTiers(qty: number, cfg: Pick<TrendSignalConfig, 'singleExit' | 'tierMode' | 'tp2Lots' | 'tp3Lots'>): TierPlan {
    if (qty <= 0) return { r2: 0, r3: 0, trail: 0 };
    if (qty === 1) {
        if (cfg.singleExit === 2) return { r2: 1, r3: 0, trail: 0 };
        if (cfg.singleExit === 3) return { r2: 0, r3: 1, trail: 0 };
        return { r2: 0, r3: 0, trail: 1 };
    }
    if (cfg.tierMode === 'custom') {
        const r2 = Math.min(Math.max(0, cfg.tp2Lots), qty);
        const r3 = Math.min(Math.max(0, cfg.tp3Lots), qty - r2);
        return { r2, r3, trail: qty - r2 - r3 };
    }
    if (qty === 2) return { r2: 1, r3: 0, trail: 1 };
    if (qty === 3) return { r2: 1, r3: 1, trail: 1 };
    const r2 = Math.floor(qty / 3);
    const r3 = Math.floor(qty / 3);
    return { r2, r3, trail: qty - r2 - r3 };
}

export interface PlanInput {
    direction: Direction;
    entry: number;
    entryBasis: 'estimate' | 'fill';
    /** 擺動高低點（undefined = 沒有有效擺動點，用 ATR 備援） */
    swing: number | undefined;
    atr: number | undefined;
    tick: number;
    pointValue: number | null;
    cfg: TrendSignalConfig;
    /** 已成交口數：成交後以成交價重新定價時固定口數，超出預算只標示 overBudget */
    fixedQty?: number;
}

/** 初始停損（多）＝ min(擺動低點 − 1 tick, 進場 − stopAtr × ATR)；空單鏡像。
 *  R 由進場價與初始停損決定，之後不再改變。 */
export function planRisk(inp: PlanInput): RiskPlan {
    const { direction: dir, entry, tick, cfg } = inp;
    const sign = dir === 'LONG' ? 1 : -1;
    const requestedQty = inp.fixedQty ?? cfg.qty;
    const base: RiskPlan = {
        status: 'REJECTED_RISK',
        direction: dir,
        entry,
        entryBasis: inp.entryBasis,
        stop: Number.NaN,
        stopBasis: 'atr-fallback',
        swing: inp.swing,
        atrStop: Number.NaN,
        riskPoints: Number.NaN,
        r1: Number.NaN,
        r2: Number.NaN,
        r3: Number.NaN,
        breakevenStop: Number.NaN,
        costPoints: Number.NaN,
        tick,
        pointValue: inp.pointValue ?? Number.NaN,
        requestedQty,
        qty: 0,
        riskPerLot: Number.NaN,
        totalRisk: Number.NaN,
        budget: cfg.budget,
        overBudget: false,
        tiers: { r2: 0, r3: 0, trail: 0 },
    };
    if (!(tick > 0) || !Number.isFinite(entry)) return { ...base, reason: '價格或跳動點資料無效' };
    if (inp.pointValue === null || !(inp.pointValue > 0)) {
        return { ...base, reason: '商品每點價值未知，無法換算新臺幣風險' };
    }
    if (inp.atr === undefined || !(inp.atr > 0)) return { ...base, reason: '1m ATR 資料不足，無法計算停損' };
    const atrStop = entry - sign * cfg.stopAtr * inp.atr;
    let raw = atrStop;
    let basis: RiskPlan['stopBasis'] = 'atr-fallback';
    if (inp.swing !== undefined) {
        const swingStop = inp.swing - sign * tick;
        // 取離進場較遠者（多單取低）：結構與波動任一失效都在停損外
        raw = dir === 'LONG' ? Math.min(swingStop, atrStop) : Math.max(swingStop, atrStop);
        basis = raw === swingStop ? 'swing' : 'atr';
    }
    const stop = awayTick(dir, raw, tick);
    const riskPoints = fix(sign * (entry - stop), tick);
    if (!(riskPoints > 0)) return { ...base, atrStop, stop, stopBasis: basis, reason: '停損不在進場價的保護側' };
    const pv = inp.pointValue;
    const cost = roundTripCost(cfg, tick, pv);
    const costPoints = cost / pv;
    const riskPerLot = riskPoints * pv + cost;
    const affordable = Math.floor(cfg.budget / riskPerLot + EPS);
    const qty = inp.fixedQty ?? Math.max(0, Math.min(requestedQty, affordable));
    const plan: RiskPlan = {
        ...base,
        stop,
        stopBasis: basis,
        atrStop,
        riskPoints,
        r1: towardTick(dir, entry + sign * riskPoints, tick),
        r2: towardTick(dir, entry + sign * 2 * riskPoints, tick),
        r3: towardTick(dir, entry + sign * 3 * riskPoints, tick),
        breakevenStop: towardTick(dir, entry + sign * costPoints, tick),
        costPoints,
        qty,
        riskPerLot,
        totalRisk: riskPerLot * qty,
        overBudget: riskPerLot * qty > cfg.budget + EPS,
    };
    if (qty < 1) {
        return {
            ...plan,
            qty: 0,
            totalRisk: riskPerLot,
            reason: `單口預估風險 NT$${Math.round(riskPerLot).toLocaleString('en-US')} 超過預算 NT$${cfg.budget.toLocaleString('en-US')}`,
        };
    }
    return { ...plan, status: 'OK', tiers: allocateTiers(qty, cfg) };
}

/** 移動停損（多）：max(舊停損, 5m SuperTrend 支撐 − 1 tick, 入場後最高價 − trailAtr × 5m ATR)。
 *  缺少的來源不參與；全部缺少時不更新。空單用 min 鏡像。 */
export function trailStop(
    dir: Direction,
    current: number,
    stSupport: number | undefined,
    extreme: number,
    atr5: number | undefined,
    tick: number,
    trailAtr: number,
): number {
    const sign = dir === 'LONG' ? 1 : -1;
    const cands: number[] = [];
    if (stSupport !== undefined) cands.push(stSupport - sign * tick);
    if (atr5 !== undefined && atr5 > 0) cands.push(extreme - sign * trailAtr * atr5);
    let next = current;
    for (const c of cands) {
        const v = awayTick(dir, c, tick);
        next = dir === 'LONG' ? Math.max(next, v) : Math.min(next, v);
    }
    return next;
}
