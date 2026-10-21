// src/lib/trend-signal/trigger/pullback-kd.ts — 先前策略假說／未驗證（舊規格 §1.2）的 1m
// 進場確認：最近兩根已收 1m 曾回測 EMA9 或當盤 VWAP（容差 × 1m ATR），最新一根
// 收盤站回 EMA9，且 KD 在最新一根交叉。V1.1 §4.3：只能是第三套可選 plugin，預設 OFF
// （只有風控採用它時才計算）；參數固定為舊規格預設，不開放設定、不再擴充。

import { atr, ema, stoch } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints } from '../core/bars';
import type { Direction, EntryEvent } from '../types';
import type { ModeResult } from './modes';
import { hintEvent, type TrendSegment } from './window';

export const PULLBACK_KD = {
    ema: 9,
    atr: 14,
    kdPeriod: 9,
    kdK: 3,
    kdD: 3,
    touchTol: 0.25,
    kdChase: 80,
    volumeFilter: false,
    volumeLookback: 20,
} as const;

export interface KdIndicators {
    ema: (number | undefined)[];
    atr: (number | undefined)[];
    vwap: (number | undefined)[];
    k: (number | undefined)[];
    d: (number | undefined)[];
}

/** 當盤 VWAP：每個交易時段（日盤／夜盤）重新累積，跨午夜不重設 */
export function sessionVwap(bars: Candle[], session: string[]): (number | undefined)[] {
    const out: (number | undefined)[] = [];
    let key = '';
    let pv = 0;
    let vol = 0;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        if (session[i] !== key) {
            key = session[i]!;
            pv = 0;
            vol = 0;
        }
        if (b.volume > 0) {
            pv += ((b.high + b.low + b.close) / 3) * b.volume;
            vol += b.volume;
        }
        out.push(vol > 0 ? pv / vol : undefined);
    }
    return out;
}

export function kdIndicators(bars: Candle[], session: string[]): KdIndicators {
    const kd = stoch(bars, PULLBACK_KD.kdPeriod, PULLBACK_KD.kdK, PULLBACK_KD.kdD);
    return {
        ema: alignPoints(bars, ema(bars, PULLBACK_KD.ema)),
        atr: alignPoints(bars, atr(bars, PULLBACK_KD.atr)),
        vwap: sessionVwap(bars, session),
        k: alignPoints(bars, kd.k),
        d: alignPoints(bars, kd.d),
    };
}

export type SetupStage = 'NO_DATA' | 'WAIT_PULLBACK' | 'WAIT_RECLAIM' | 'WAIT_KD' | 'READY';

export interface SetupEval {
    stage: SetupStage;
    touched: 'EMA' | 'VWAP' | 'BOTH' | null;
    chase: boolean;
    volumeOk: boolean;
}

function touches(bar: Candle, level: number | undefined, tol: number): boolean {
    return level !== undefined && bar.low <= level + tol && bar.high >= level - tol;
}

/** 在已收 1m 索引 m 評估 dir 方向的回測確認條件 */
export function evalSetup(bars: Candle[], ind: KdIndicators, m: number, dir: Direction): SetupEval {
    const none: SetupEval = { stage: 'NO_DATA', touched: null, chase: false, volumeOk: true };
    if (m < 1) return none;
    const a = ind.atr[m];
    const e = ind.ema[m];
    const k = ind.k[m];
    const d = ind.d[m];
    const kPrev = ind.k[m - 1];
    const dPrev = ind.d[m - 1];
    if (a === undefined || e === undefined || k === undefined || d === undefined || kPrev === undefined || dPrev === undefined) {
        return none;
    }
    const tol = PULLBACK_KD.touchTol * a;
    let byEma = false;
    let byVwap = false;
    for (const j of [m - 1, m]) {
        const b = bars[j]!;
        byEma ||= touches(b, ind.ema[j], tol);
        byVwap ||= touches(b, ind.vwap[j], tol);
    }
    const touched = byEma && byVwap ? 'BOTH' : byEma ? 'EMA' : byVwap ? 'VWAP' : null;
    const close = bars[m]!.close;
    const reclaim = dir === 'LONG' ? close > e : close < e;
    const cross = dir === 'LONG' ? k > d && kPrev <= dPrev : k < d && kPrev >= dPrev;
    const chase = PULLBACK_KD.kdChase < 100 && (dir === 'LONG' ? k >= PULLBACK_KD.kdChase : k <= 100 - PULLBACK_KD.kdChase);
    let volumeOk = true;
    if (PULLBACK_KD.volumeFilter) {
        const from = m - PULLBACK_KD.volumeLookback;
        if (from < 0) volumeOk = false;
        else {
            let sum = 0;
            for (let j = from; j < m; j++) sum += bars[j]!.volume;
            volumeOk = bars[m]!.volume >= sum / PULLBACK_KD.volumeLookback;
        }
    }
    const stage: SetupStage = !touched ? 'WAIT_PULLBACK' : !reclaim ? 'WAIT_RECLAIM' : !cross ? 'WAIT_KD' : 'READY';
    return { stage, touched, chase, volumeOk };
}

export function pullbackKdHints(seg: TrendSegment, m1: Candle[], ind: KdIndicators, key: string): ModeResult {
    const hints: EntryEvent[] = [];
    for (const m of seg.bars) {
        const ev = evalSetup(m1, ind, m, seg.signal.direction);
        if (ev.stage !== 'READY' || ev.chase || !ev.volumeOk) continue;
        const bar = m1[m]!;
        hints.push(hintEvent(seg, 'PULLBACK_KD', key, hints.length + 1, bar.time, bar.close,
            `回測 ${ev.touched === 'BOTH' ? 'EMA9＋VWAP' : ev.touched === 'EMA' ? 'EMA9' : 'VWAP'} 後站回且 KD 交叉（先前策略假說／未驗證）`));
    }
    return { hints, waiting: '等待回測 EMA9／VWAP 並 KD 交叉（先前策略假說／未驗證）' };
}
