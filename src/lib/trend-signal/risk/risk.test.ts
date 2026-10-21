// src/lib/trend-signal/risk/risk.test.ts — 虛擬風控：停損依據、R 在成交後固定、tick 取整、
// 新臺幣預算與口數（TMF／MTX 每點價值不同）、期交稅、整數口數分層、移動停損只往有利方向，
// 以及虛擬部位的成交、停損優先、保本、分批停利、5m 反向／失效立即出場、不跨盤、
// 同段趨勢多次提示（持倉時略過、停損後可再進場）。
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { buildTf } from '../core/bars';
import { DEFAULT_CONFIG } from '../config';
import { T } from '../fixtures.test-harness';
import type { EntryEvent, RiskConfig, TrendInvalidation, TrendSignal, TrendState, TrendTrack } from '../types';
import { allocateTiers, ceilTick, floorTick, futuresTax, planRisk, roundTripCost, swingPoint, trailStop } from './plan';
import { runVirtual } from './virtual';

const R: RiskConfig = DEFAULT_CONFIG.risk;

describe('tick 取整', () => {
    it('吃掉浮點誤差，支援小數 tick', () => {
        expect(floorTick(20000.000000001, 1)).toBe(20000);
        expect(ceilTick(19999.9999999999, 1)).toBe(20000);
        expect(floorTick(10.07, 0.05)).toBe(10.05);
        expect(ceilTick(10.01, 0.05)).toBe(10.05);
    });
});

describe('planRisk', () => {
    const base = { tick: 1, pointValue: 10, cfg: { ...R, budget: 100000 } };
    it('多單：停損取擺動低點 − 1 tick 與 1.5 ATR 中較遠者；R、目標、保本依 tick', () => {
        const p = planRisk({ ...base, direction: 'LONG', entry: 20000, entryBasis: 'estimate', swing: 19980, atr: 10 });
        expect(p).toMatchObject({ status: 'OK', stop: 19979, stopBasis: 'swing', riskPoints: 21, r1: 20021, r2: 20042, r3: 20063 });
        // 成本 = 手續費 12 × 2 ÷ 每點 10 + 滑價 1 tick × 2 = 4.4 點 → 保本往有利方向取整
        expect(p.costPoints).toBeCloseTo(4.4, 10);
        expect(p.breakevenStop).toBe(20005);
        const atrOnly = planRisk({ ...base, direction: 'LONG', entry: 20000, entryBasis: 'estimate', swing: 19995, atr: 10 });
        expect(atrOnly).toMatchObject({ stop: 19985, stopBasis: 'atr' });
        const noSwing = planRisk({ ...base, direction: 'LONG', entry: 20000, entryBasis: 'estimate', swing: undefined, atr: 10 });
        expect(noSwing).toMatchObject({ stop: 19985, stopBasis: 'atr-fallback' });
    });
    it('空單鏡像', () => {
        const p = planRisk({ ...base, direction: 'SHORT', entry: 20000, entryBasis: 'estimate', swing: 20020, atr: 10 });
        expect(p).toMatchObject({ stop: 20021, riskPoints: 21, r1: 19979, r2: 19958, r3: 19937, breakevenStop: 19995 });
    });
    it('規格案例 6：TMF 與 MTX 同樣 50 點停損，新臺幣風險不同', () => {
        const inp = { direction: 'LONG' as const, entry: 20000, entryBasis: 'estimate' as const, swing: 19951, atr: 10, tick: 1 };
        const tmf = planRisk({ ...inp, pointValue: 10, cfg: R });
        const mtx = planRisk({ ...inp, pointValue: 50, cfg: R });
        expect(tmf.riskPoints).toBe(50);
        expect(mtx.riskPoints).toBe(50);
        expect(tmf.riskPerLot).toBe(50 * 10 + 24 + 2 * 10);
        expect(mtx.riskPerLot).toBe(50 * 50 + 24 + 2 * 50);
        expect(tmf).toMatchObject({ status: 'OK', qty: 1 });
        expect(mtx).toMatchObject({ status: 'REJECTED_RISK', qty: 0 });
        expect(mtx.reason).toContain('超過預算');
    });
    it('預算決定口數上限；每點價值未知、ATR 不足時拒絕', () => {
        const p = planRisk({ direction: 'LONG', entry: 20000, entryBasis: 'estimate', swing: 19980, atr: 10, tick: 1, pointValue: 10, cfg: { ...R, qty: 10, budget: 1000 } });
        expect(p.qty).toBe(3); // 每口 21 × 10 + 24 + 20 = 254 → 1000 / 254
        expect(p.totalRisk).toBe(254 * 3);
        expect(planRisk({ direction: 'LONG', entry: 1, entryBasis: 'estimate', swing: undefined, atr: 1, tick: 1, pointValue: null, cfg: R }).status).toBe('REJECTED_RISK');
        expect(planRisk({ direction: 'LONG', entry: 1, entryBasis: 'estimate', swing: undefined, atr: undefined, tick: 1, pointValue: 10, cfg: R }).reason).toContain('ATR');
    });
    it('成交後重新定價固定口數；超出預算只標示，不假裝在預算內', () => {
        const p = planRisk({ direction: 'LONG', entry: 20000, entryBasis: 'fill', swing: 19900, atr: 10, tick: 1, pointValue: 10, cfg: R, fixedQty: 1 });
        expect(p).toMatchObject({ status: 'OK', qty: 1, overBudget: true });
    });
    it('期交稅：契約價值 × 稅率，元以下四捨五入；計入來回成本與保本價', () => {
        expect(futuresTax(23000, 10, 0.00002)).toBe(5); // 4.6 → 5
        expect(futuresTax(20000, 10, 0.00002, 3)).toBe(12);
        expect(futuresTax(20000, 10, 0)).toBe(0);
        expect(roundTripCost(R, 1, 10, 20000, 0.00002)).toBe(24 + 20 + 8);
        const p = planRisk({ ...base, direction: 'LONG', entry: 20000, entryBasis: 'estimate', swing: 19980, atr: 10, taxRate: 0.00002 });
        expect(p.costPoints).toBeCloseTo(5.2, 10);
        expect(p.breakevenStop).toBe(20006);
    });
});

describe('allocateTiers', () => {
    it('規格表：1／2／3 口與 4 口以上', () => {
        expect(allocateTiers(1, R)).toEqual({ r2: 0, r3: 0, trail: 1 });
        expect(allocateTiers(1, { ...R, singleExit: 2 })).toEqual({ r2: 1, r3: 0, trail: 0 });
        expect(allocateTiers(1, { ...R, singleExit: 3 })).toEqual({ r2: 0, r3: 1, trail: 0 });
        expect(allocateTiers(2, R)).toEqual({ r2: 1, r3: 0, trail: 1 });
        expect(allocateTiers(3, R)).toEqual({ r2: 1, r3: 1, trail: 1 });
        expect(allocateTiers(4, R)).toEqual({ r2: 1, r3: 1, trail: 2 });
        expect(allocateTiers(6, R)).toEqual({ r2: 2, r3: 2, trail: 2 });
    });
    it('規格案例 5：任何口數都是非負整數、加總等於口數（含自訂超量）', () => {
        for (let q = 1; q <= 50; q++) {
            for (const cfg of [R, { ...R, tierMode: 'custom' as const, tp2Lots: 7, tp3Lots: 30 }]) {
                const t = allocateTiers(q, cfg);
                for (const v of [t.r2, t.r3, t.trail]) {
                    expect(Number.isInteger(v)).toBe(true);
                    expect(v).toBeGreaterThanOrEqual(0);
                }
                expect(t.r2 + t.r3 + t.trail).toBe(q);
            }
        }
    });
});

describe('trailStop', () => {
    it('多單取 max(舊停損, 趨勢線 − 1 tick, 最高 − k × ATR)，只往上', () => {
        expect(trailStop('LONG', 100, 110, 130, 10, 1, 1.2)).toBe(118);
        expect(trailStop('LONG', 125, 110, 130, 10, 1, 1.2)).toBe(125);
        expect(trailStop('LONG', 100, undefined, 130, undefined, 1, 1.2)).toBe(100); // 來源都缺：不盲目更新
    });
    it('空單鏡像', () => {
        expect(trailStop('SHORT', 200, 190, 170, 10, 1, 1.2)).toBe(182);
    });
});

describe('swingPoint', () => {
    it('需要右側已收 K 棒確認；取窗口內最低的擺動低點', () => {
        const lows = [10, 8, 9, 7, 9, 10];
        const bars = lows.map((l, i) => ({ time: i, open: l, high: l + 1, low: l, close: l, volume: 1 }));
        expect(swingPoint(bars, 5, 5, 'LONG')).toBe(7);
        expect(swingPoint(bars, 3, 5, 'LONG')).toBe(8); // index 3 還沒有右鄰
    });
});

// ---- 虛擬部位情境 ----

const t0 = T('2026-10-20T09:00:00');
const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: 10 });
/** 09:01–09:40 平盤（高低 ±10 → 1m ATR 20），之後接 extra */
function scenario(extra: [number, number, number, number][]): Candle[] {
    const out: Candle[] = [];
    for (let i = 1; i <= 40; i++) out.push(bar(t0 + 60 * i, 100, 110, 90, 100));
    extra.forEach(([o, h, l, c], k) => out.push(bar(t0 + 60 * (41 + k), o, h, l, c)));
    return out;
}
const sig = (kind: 'BUY' | 'SELL', index: number, barTime: number, sessionEnd = T('2026-10-20T13:45:00')): TrendSignal => ({
    id: `sig-${index}`,
    kind,
    direction: kind === 'BUY' ? 'LONG' : 'SHORT',
    barTime,
    index,
    session: '2026-10-20D',
    sessionEnd,
    close: 100,
    line: undefined,
    atr: undefined,
    notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN', m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null, m15Stale: false, m60Stale: false, m15Incomplete: false, m60Incomplete: false },
});
const entry = (s: TrendSignal, barTime = s.barTime, refPrice = 100, seq = 1): EntryEvent => ({
    id: `${s.id}|IMMEDIATE|${barTime}`,
    kind: s.direction === 'LONG' ? 'POTENTIAL_ENTRY_LONG' : 'POTENTIAL_ENTRY_SHORT',
    mode: 'IMMEDIATE',
    signalId: s.id,
    direction: s.direction,
    barTime,
    refPrice,
    seq,
    reason: 'test',
});
function run(
    m1: Candle[],
    signals: TrendSignal[],
    entries: EntryEvent[],
    opts: { cfg?: Partial<RiskConfig>; live?: Candle; dirs?: TrendState[]; invalidations?: TrendInvalidation[]; taxRate?: number } = {},
) {
    const asOf = m1.at(-1)!.time;
    const m5 = buildTf(m1, 5, 'FUT', asOf);
    const t5: TrendTrack = { tf: 5, algo: 'supertrend', line: m5.bars.map(() => undefined), dir: opts.dirs ?? m5.bars.map(() => 'LONG'), stopLine: true };
    return runVirtual({
        m1,
        m1SessionEnd: buildTf(m1, 1, 'FUT', asOf).sessionEnd,
        live: opts.live ?? null,
        asOf,
        m5,
        t5,
        signals,
        invalidations: opts.invalidations ?? [],
        entries,
        cfg: { ...R, ...opts.cfg },
        tick: 1,
        pointValue: 10,
        taxRate: opts.taxRate ?? 0,
        key: 'k',
    });
}
const BUY = sig('BUY', 7, t0 + 2400); // 5m 09:40

describe('虛擬部位', () => {
    it('下一根 1m 開盤 ± 滑價成交，R 以成交價重新定價後固定', () => {
        const v = run(scenario([[100, 105, 95, 100]]), [BUY], [entry(BUY)]);
        const vt = v.trades[0]!;
        expect(vt).toMatchObject({ fillTime: t0 + 2460, fillPrice: 101, status: 'OPEN' });
        expect(vt.plan).toMatchObject({ entryBasis: 'fill', stop: 71, riskPoints: 30, r1: 131, r2: 161, r3: 191, breakevenStop: 106 });
    });
    it('保護性停損觸價即出；跳空穿過停損以開盤價 − 滑價成交', () => {
        const hit = run(scenario([[100, 105, 95, 100], [100, 100, 70, 75]]), [BUY], [entry(BUY)]).trades[0]!;
        expect(hit.fills).toEqual([{ time: t0 + 2520, at: 'intrabar', price: 70, qty: 1, reason: 'STOP' }]);
        expect(hit.realizedNtd).toBe((70 - 101) * 10 - 24);
        expect(hit.costNtd).toBe(24);
        const gap = run(scenario([[100, 105, 95, 100], [60, 65, 55, 60]]), [BUY], [entry(BUY)]).trades[0]!;
        expect(gap.fills[0]).toMatchObject({ price: 59, reason: 'STOP', at: 'open' });
    });
    it('+1R 到價後，保本停損從下一根開始生效', () => {
        const v = run(scenario([[100, 105, 95, 100], [100, 135, 100, 130], [120, 125, 105, 110]]), [BUY], [entry(BUY)]);
        const vt = v.trades[0]!;
        expect(vt.stopHistory.map((s) => [s.time, s.stop, s.reason])).toEqual([
            [t0 + 2460, 71, 'initial'],
            [t0 + 2580, 106, 'breakeven'],
        ]);
        expect(vt.fills[0]).toMatchObject({ reason: 'BREAKEVEN_STOP', price: 105 });
    });
    it('同一根同時觸及停損與 +1R：停損優先（保守）', () => {
        const vt = run(scenario([[100, 105, 95, 100], [100, 140, 60, 100]]), [BUY], [entry(BUY)]).trades[0]!;
        expect(vt.hit.r1).toBeNull();
        expect(vt.exitReason).toBe('STOP');
    });
    it('2 口：+2R 出 1 口、啟動移動停損，其餘續抱', () => {
        const vt = run(scenario([[100, 105, 95, 100], [100, 165, 100, 160]]), [BUY], [entry(BUY)], { cfg: { qty: 2, budget: 100000 } }).trades[0]!;
        expect(vt.fills).toEqual([{ time: t0 + 2520, at: 'intrabar', price: 161, qty: 1, reason: 'TP2R' }]);
        expect(vt).toMatchObject({ openQty: 1, trailing: true, status: 'OPEN' });
    });
    it('規格案例 2：5m 確認反向 → 下一根 1m 開盤平倉，不等 1m；平倉本身不開反向部位', () => {
        const m1 = scenario([[100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [98, 105, 95, 100]]);
        const SELL = sig('SELL', 8, t0 + 2700); // 5m 09:45
        const dirs: TrendState[] = [...Array(8).fill('LONG'), 'SHORT'];
        const v = run(m1, [BUY, SELL], [entry(BUY)], { dirs });
        expect(v.trades).toHaveLength(1);
        expect(v.trades[0]!.fills).toEqual([{ time: t0 + 2760, at: 'open', price: 97, qty: 1, reason: 'REVERSAL' }]);
        // 反向訊號有自己的進場事件時，才在同一根開盤以獨立紀錄進場
        const v2 = run(m1, [BUY, SELL], [entry(BUY), entry(SELL)], { dirs });
        expect(v2.trades.map((t) => [t.direction, t.fillTime])).toEqual([['LONG', t0 + 2460], ['SHORT', t0 + 2760]]);
        expect(v2.trades[0]!.closedAt).toBe(t0 + 2760);
    });
    it('進場成交的 K 棒跨到下一盤 → 取消，不跨盤進場', () => {
        const close = T('2026-10-20T13:45:00');
        const m1 = [
            ...Array.from({ length: 20 }, (_, i) => bar(close - 60 * (19 - i), 100, 110, 90, 100)),
            bar(T('2026-10-20T15:01:00'), 100, 105, 95, 100),
        ];
        const s = sig('BUY', 3, close, close);
        const v = run(m1, [s], [entry(s)]);
        expect(v.trades).toHaveLength(0);
        expect(v.events.some((e) => e.text.includes('不跨盤'))).toBe(true);
    });
    it('進行中的 1m：開盤即虛擬成交、已發生的觸價即出場；沒有即時 K 棒時保持待成交', () => {
        const m1 = scenario([]);
        const pending = run(m1, [BUY], [entry(BUY)]);
        expect(pending.trades).toHaveLength(0);
        expect(pending.pendingEntry?.entry.signalId).toBe(BUY.id);
        const live = bar(t0 + 2460, 100, 100, 60, 65);
        const v = run(m1, [BUY], [entry(BUY)], { live });
        expect(v.trades[0]).toMatchObject({ fillPrice: 101, exitReason: 'STOP' });
    });
    it('已有虛擬部位時不加碼', () => {
        const other = sig('BUY', 8, t0 + 2700);
        const m1 = scenario([[100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100]]);
        const v = run(m1, [BUY, other], [entry(BUY), entry(other)]);
        expect(v.trades).toHaveLength(1);
        expect(v.events.some((e) => e.text.includes('不加碼'))).toBe(true);
    });
    it('審計時間：開盤成交與開盤出場記該 1m 開盤時刻，盤中觸價記觸價那根 1m 的收盤 label', () => {
        const v = run(scenario([[100, 105, 95, 100], [100, 100, 70, 75]]), [BUY], [entry(BUY)]);
        const vt = v.trades[0]!;
        expect(vt).toMatchObject({ fillTime: t0 + 2460, fillAt: t0 + 2400 });
        const fill = v.events.find((e) => e.kind === 'FILL')!;
        expect(fill.time).toBe(vt.fillAt);
        expect(fill.text).toContain('09:40 開盤');
        const exit = v.events.find((e) => e.kind === 'EXIT')!;
        expect(exit.time).toBe(t0 + 2520);
        expect(exit.text).toContain('09:41–09:42 盤中');
        // 5m 反向的開盤平倉：事件時間＝該 1m 開盤
        const m1 = scenario([[100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [98, 105, 95, 100]]);
        const SELL = sig('SELL', 8, t0 + 2700);
        const r = run(m1, [BUY, SELL], [entry(BUY)], { dirs: [...Array(8).fill('LONG'), 'SHORT'] });
        const rev = r.events.find((e) => e.kind === 'EXIT')!;
        expect(rev.time).toBe(t0 + 2700);
        expect(rev.text).toContain('09:45 開盤');
    });
    it('已實現損益扣手續費與期交稅（兩邊各自以成交價計）', () => {
        const hit = run(scenario([[100, 105, 95, 100], [100, 100, 70, 75]]), [BUY], [entry(BUY)], { taxRate: 0.01 }).trades[0]!;
        // 停損 70、進場 101：稅 = round(101 × 10 × 1%) + round(70 × 10 × 1%) = 10 + 7
        expect(hit.realizedNtd).toBe((70 - 101) * 10 - 24 - 17);
        expect(hit.costNtd).toBe(24 + 17);
        expect(hit.realizedNtd).toBe(hit.realizedPoints * 10 - hit.costNtd);
    });
    it('5m 趨勢失效（→ NEUTRAL）→ 下一根 1m 開盤平倉，不等 1m', () => {
        const m1 = scenario([[100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [98, 105, 95, 100]]);
        const inv: TrendInvalidation = { id: 'inv-8', barTime: t0 + 2700, index: 8, from: 'LONG' };
        const v = run(m1, [BUY], [entry(BUY)], { dirs: [...Array(8).fill('LONG'), 'NEUTRAL'], invalidations: [inv] });
        expect(v.trades[0]!.fills).toEqual([{ time: t0 + 2760, at: 'open', price: 97, qty: 1, reason: 'TREND_INVALID' }]);
        // 反方向的失效（空方失效）與多單無關
        const other = run(m1, [BUY], [entry(BUY)], { invalidations: [{ ...inv, from: 'SHORT' }] });
        expect(other.trades[0]!.status).toBe('OPEN');
    });
    it('同一段趨勢多次提示：持倉中略過；停損出場後下一次提示可再進場', () => {
        // 第 1 次提示 09:40 → 09:41 成交；第 2 次 09:41 在持倉中 → 略過；09:42 觸及停損 71；
        // 第 3 次 09:43 → 09:44 開盤再進場
        const m1 = scenario([[100, 105, 95, 100], [100, 100, 60, 65], [65, 70, 60, 66], [66, 70, 60, 66], [66, 70, 60, 66]]);
        const hints = [entry(BUY), entry(BUY, t0 + 2460, 100, 2), entry(BUY, t0 + 2580, 66, 3)];
        const v = run(m1, [BUY], hints);
        expect(v.trades.map((t) => [t.fillTime, t.entryId])).toEqual([[t0 + 2460, hints[0]!.id], [t0 + 2640, hints[2]!.id]]);
        expect(v.trades[0]!.exitReason).toBe('STOP');
        expect(v.events.filter((e) => e.kind === 'WARN' && e.text.includes('略過')).map((e) => e.ref)).toEqual([hints[1]!.id]);
    });
    it('提示所在盤決定能否成交：整段趨勢延續到下一盤時，提示在新盤內即可成交', () => {
        const dayEnd = T('2026-10-20T13:45:00');
        const day = Array.from({ length: 20 }, (_, i) => bar(dayEnd - 60 * (19 - i), 100, 110, 90, 100));
        const night = Array.from({ length: 20 }, (_, i) => bar(T('2026-10-20T15:01:00') + 60 * i, 100, 110, 90, 100));
        const m1 = [...day, ...night];
        const s = sig('BUY', 1, T('2026-10-20T13:35:00'), dayEnd);
        const v = run(m1, [s], [entry(s, T('2026-10-20T15:10:00'), 100, 2)]);
        expect(v.trades[0]).toMatchObject({ fillTime: T('2026-10-20T15:11:00'), status: 'OPEN' });
    });
});
