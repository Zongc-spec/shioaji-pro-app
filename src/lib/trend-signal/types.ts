// src/lib/trend-signal/types.ts — Trend Signal Pro（5m 主控、1m 執行、
// 15m/60m 輔助）的共用型別。時間一律是台灣牆鐘編碼成 UTC 秒
// （utils/kbars.wallClockToUtc），K 棒時間是收盤 label。

import type { Candle } from '../types/market';
import type { SecurityType } from '../types/contract';

export type TrendState = 'UNKNOWN' | 'LONG' | 'SHORT' | 'NEUTRAL';
export type Direction = 'LONG' | 'SHORT';
export type Alignment = 'ALIGN' | 'DIVERGE' | 'NEUTRAL';
export type TfMinutes = 1 | 5 | 15 | 60;

export interface TrendSignalConfig {
    // ---- 5m 主控 ----
    stPeriod: number;
    stMult: number;
    emaPeriod: number;
    /** EMA 斜率：與幾根前比較（規格：兩根前） */
    emaSlopeBars: number;
    atrPeriod: number;
    /** BUY/SELL 後允許 1m 進場的 5m K 棒數 */
    candidateBars: number;
    // ---- 1m 觸發 ----
    ema1m: number;
    atr1m: number;
    kdPeriod: number;
    kdK: number;
    kdD: number;
    /** 回測容差 = touchTol × 1m ATR */
    touchTol: number;
    /** 多單 K ≥ 此值拒絕追價（空單 K ≤ 100 − 此值）；100 = 關 */
    kdChase: number;
    volumeFilter: boolean;
    volumeLookback: number;
    // ---- 15m／60m ----
    keyBars: number;
    // ---- 風控（P3 虛擬計畫） ----
    budget: number;
    feePerSide: number;
    slipTicks: number;
    qty: number;
    swingBars: number;
    stopAtr: number;
    trailAtr: number;
    /** 單口出場：1 = 追蹤、2 = 2R 全出、3 = 3R 全出 */
    singleExit: 1 | 2 | 3;
    /** 多口分配：auto = 規格表、custom = tp2Lots/tp3Lots，其餘追蹤 */
    tierMode: 'auto' | 'custom';
    tp2Lots: number;
    tp3Lots: number;
}

/** 一個週期的已收 K 棒與每根的時段資訊 */
export interface TfSeries {
    tf: TfMinutes;
    bars: Candle[];
    /** 該根最後一根 1m 的 label（判斷時段用） */
    lastMinute: number[];
    session: string[];
}

export interface TrendSeries {
    /** 目前生效那一側的 SuperTrend 值 */
    st: (number | undefined)[];
    stUp: (boolean | undefined)[];
    ema: (number | undefined)[];
    atr: (number | undefined)[];
    state: TrendState[];
}

export interface M1Indicators {
    ema: (number | undefined)[];
    atr: (number | undefined)[];
    vwap: (number | undefined)[];
    k: (number | undefined)[];
    d: (number | undefined)[];
    session: string[];
}

/** 5m 確認收棒的 BUY / SELL（候選訊號） */
export interface TrendSignal {
    id: string;
    kind: 'BUY' | 'SELL';
    direction: Direction;
    /** 5m 收盤 label */
    barTime: number;
    index: number;
    session: string;
    prevState: TrendState;
    close: number;
    st: number;
    ema: number;
    atr: number | undefined;
    /** 最後一個允許 1m 進場的 1m label（含） */
    expiresAt: number;
    htf: HtfContext;
}

export interface HtfContext {
    m15: TrendState;
    m60: TrendState;
    m15Align: Alignment;
    m60Align: Alignment;
    m15BarTime: number | null;
    m60BarTime: number | null;
}

export type TriggerStatus =
    | 'ACCEPTED'
    | 'REJECTED_RISK'
    | 'REJECTED_CHASE'
    | 'REJECTED_VOLUME'
    | 'SKIPPED_POSITION'
    | 'SKIPPED_USED';

/** 1m 進場觸發（在 5m 候選內） */
export interface EntryTrigger {
    id: string;
    signalId: string;
    direction: Direction;
    /** 1m 收盤 label */
    barTime: number;
    index: number;
    session: string;
    close: number;
    ema: number;
    vwap: number | undefined;
    k: number;
    d: number;
    atr: number;
    touched: 'EMA' | 'VWAP' | 'BOTH';
    status: TriggerStatus;
    reason: string;
    plan: RiskPlan | null;
    /** 決策引用的各週期最新已收 K 棒 */
    refs: { m5: number; m15: number | null; m60: number | null };
    htf: HtfContext;
}

export interface TierPlan {
    r2: number;
    r3: number;
    trail: number;
}

export interface RiskPlan {
    status: 'OK' | 'REJECTED_RISK';
    reason?: string;
    direction: Direction;
    entry: number;
    entryBasis: 'estimate' | 'fill';
    stop: number;
    stopBasis: 'swing' | 'atr' | 'atr-fallback';
    swing: number | undefined;
    atrStop: number;
    riskPoints: number;
    r1: number;
    r2: number;
    r3: number;
    breakevenStop: number;
    costPoints: number;
    tick: number;
    pointValue: number;
    requestedQty: number;
    qty: number;
    riskPerLot: number;
    totalRisk: number;
    budget: number;
    /** 成交後重新定價的風險超出預算（跳空、滑價）— 預估值，不是保證上限 */
    overBudget: boolean;
    tiers: TierPlan;
}

export type ExitReason =
    | 'STOP'
    | 'BREAKEVEN_STOP'
    | 'TRAIL_STOP'
    | 'TP2R'
    | 'TP3R'
    | 'REVERSAL';

export interface TradeFill {
    time: number;
    price: number;
    qty: number;
    reason: ExitReason;
}

export interface StopChange {
    /** 開始生效的 1m label */
    time: number;
    stop: number;
    reason: 'initial' | 'breakeven' | 'trail';
}

/** 虛擬部位（觀察／虛擬風控：不送任何委託） */
export interface VirtualTrade {
    id: string;
    triggerId: string;
    signalId: string;
    direction: Direction;
    /** 1m 觸發收盤（訊號時間） */
    signalTime: number;
    /** 成交所在的 1m K 棒 label（以其開盤價虛擬成交） */
    fillTime: number;
    fillPrice: number;
    plan: RiskPlan;
    qty: number;
    openQty: number;
    stop: number;
    stopKind: StopChange['reason'];
    stopHistory: StopChange[];
    trailing: boolean;
    hit: { r1: number | null; r2: number | null; r3: number | null };
    extreme: number;
    fills: TradeFill[];
    status: 'OPEN' | 'CLOSED';
    exitReason: ExitReason | null;
    closedAt: number | null;
    /** 已實現點數 × 口數（未扣成本） */
    realizedPoints: number;
    /** 已實現損益（扣手續費與滑價緩衝） */
    realizedNtd: number;
    warnings: string[];
}

export type AuditKind =
    | 'SIGNAL'
    | 'TRIGGER'
    | 'FILL'
    | 'EXIT'
    | 'STOP_MOVE'
    | 'TARGET'
    | 'WARN';

export interface AuditEvent {
    time: number;
    kind: AuditKind;
    ref: string;
    text: string;
}

export interface TfSnapshot {
    tf: TfMinutes;
    state: TrendState;
    barTime: number | null;
    close: number | undefined;
    st: number | undefined;
    stUp: boolean | undefined;
    ema: number | undefined;
    atr: number | undefined;
    align: Alignment;
    keyHigh: number | undefined;
    keyLow: number | undefined;
}

export type CandidateStatus = 'NONE' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'USED';

export type M1Phase =
    | 'NO_CANDIDATE'
    | 'WAIT_PULLBACK'
    | 'WAIT_RECLAIM'
    | 'WAIT_KD'
    | 'TRIGGERED'
    | 'REJECTED'
    | 'IN_POSITION'
    | 'UNKNOWN';

export interface M1Snapshot {
    barTime: number | null;
    close: number | undefined;
    ema: number | undefined;
    vwap: number | undefined;
    k: number | undefined;
    d: number | undefined;
    atr: number | undefined;
    phase: M1Phase;
    /** 最近一次回測低點（多）或高點（空） */
    pullback: number | undefined;
    /** 持倉中 1m 收盤跌破（多）／站上（空）EMA 且 KD 反向 — 只是警告／減碼參考 */
    against: boolean;
}

export interface TrendSignalSnapshot {
    m5: TfSnapshot;
    m1: M1Snapshot;
    m15: TfSnapshot;
    m60: TfSnapshot;
    candidate: { signal: TrendSignal | null; status: CandidateStatus };
    /** 15m 與 60m 都與 5m 反向 */
    htfAgainst: boolean;
    trade: VirtualTrade | null;
    lastTrigger: EntryTrigger | null;
    /** 已接受、等待下一個報價虛擬成交的進場 */
    pendingEntry: { trigger: EntryTrigger; plan: RiskPlan } | null;
    /** 5m 已確認反轉、等待下一根 1m 開盤平倉 */
    pendingExit: { signalId: string } | null;
}

export interface TrendSignalInput {
    /** 1m K 棒（排序、label 唯一）；label > asOf 的會被忽略 */
    bars1m: Candle[];
    /** 進行中的 1m K 棒（只含已觀察到的成交）；只用於成交開盤價與停損觸價 */
    live?: Candle | null;
    asOf: number;
    securityType: SecurityType;
    symbol: string;
    contractMonth: string;
    tick: number;
    /** 每口每點新臺幣；null = 規格未知，不產生風控計畫 */
    pointValue: number | null;
    config: TrendSignalConfig;
}

export interface TrendSignalResult {
    version: string;
    configKey: string;
    asOf: number;
    securityType: SecurityType;
    symbol: string;
    contractMonth: string;
    m1: TfSeries;
    m5: TfSeries;
    m15: TfSeries;
    m60: TfSeries;
    m1Ind: M1Indicators;
    t5: TrendSeries;
    t15: TrendSeries;
    t60: TrendSeries;
    signals: TrendSignal[];
    triggers: EntryTrigger[];
    trades: VirtualTrade[];
    events: AuditEvent[];
    snapshot: TrendSignalSnapshot;
    /** 最後一根已收 1m 與 asOf 的差（秒）；沒有資料為 null */
    dataLagSec: number | null;
    /** asOf 是否在交易時段內 */
    sessionOpen: boolean;
}
