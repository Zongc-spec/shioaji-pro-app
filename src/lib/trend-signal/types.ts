// src/lib/trend-signal/types.ts — Trend Signal Pro 的共用型別。
// 模組分工（單向依賴）：core（已收棒資料）→ trend（趨勢訊號，純指標）
// → trigger（1m 進場時機）→ risk（虛擬風控）。時間一律是台灣牆鐘編碼成
// UTC 秒（utils/kbars.wallClockToUtc），K 棒時間是收盤 label。

import type { SecurityType } from '../types/contract';
import type { Candle } from '../types/market';

export type TrendDir = 'UP' | 'DOWN' | 'UNKNOWN';
export type Direction = 'LONG' | 'SHORT';
export type Alignment = 'ALIGN' | 'DIVERGE' | 'NEUTRAL';
export type TfMinutes = 1 | 5 | 15 | 60;
export type TrendAlgoId = 'supertrend' | 'donchian' | 'kama';
export type EntryMode = 'IMMEDIATE' | 'MICRO_TREND' | 'PRICE_STRUCTURE' | 'PULLBACK_KD';

// ---- 設定（依模組分組；每個模組只拿得到自己那一份） ----

export interface TrendParams {
    algo: TrendAlgoId;
    stPeriod: number;
    stMult: number;
    dcLength: number;
    kamaLength: number;
    kamaFast: number;
    kamaSlow: number;
    /** KAMA 線自身回落／回升 kamaHyst × ATR14 才翻轉 */
    kamaHyst: number;
}

/** 只顯示、不參與訊號的註記與強度 */
export interface NoteParams {
    emaPeriod: number;
    emaSlopeBars: number;
    atrPeriod: number;
    rsiPeriod: number;
    keyBars: number;
}

export interface EntryParams {
    /** 虛擬風控採用哪一個進場時機（所有模式都會計算並記錄） */
    mode: EntryMode;
    /** 5m 訊號後允許進場的 5m 根數（不跨盤別） */
    windowBars: number;
    /** 1m 微型趨勢：1m SuperTrend 的倍數（ATR 週期沿用趨勢參數）；小＝靈敏 */
    microMult: number;
    pivotLeft: number;
    pivotRight: number;
    /** 回檔深度下限（× 1m ATR14） */
    minPullbackAtr: number;
}

export interface RiskConfig {
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

export interface TrendSignalConfig {
    trend: TrendParams;
    note: NoteParams;
    entry: EntryParams;
    risk: RiskConfig;
}

// ---- core ----

/** 一個週期的已收 K 棒與每根的時段資訊 */
export interface TfSeries {
    tf: TfMinutes;
    bars: Candle[];
    /** 該根最後一根 1m 的 label（判斷時段用） */
    lastMinute: number[];
    session: string[];
}

// ---- trend ----

/** 某週期的趨勢線與方向（暖身內為 UNKNOWN） */
export interface TrendTrack {
    tf: TfMinutes;
    algo: TrendAlgoId;
    line: (number | undefined)[];
    dir: TrendDir[];
    /** 線就是翻轉價位（可當停損參考）；KAMA 為 false */
    stopLine: boolean;
}

export interface SignalNotes {
    /** 收盤對 EMA 與 EMA 斜率：同向／逆向／不一致 */
    ema: 'WITH' | 'AGAINST' | 'MIXED' | 'UNKNOWN';
    m15: TrendDir;
    m60: TrendDir;
    m15Align: Alignment;
    m60Align: Alignment;
    m15BarTime: number | null;
    m60BarTime: number | null;
}

/** 5m 趨勢切換（主訊號）。只含訊號當時已知的資訊，產生後不再改變。 */
export interface TrendSignal {
    id: string;
    kind: 'BUY' | 'SELL';
    direction: Direction;
    /** 5m 收盤 label */
    barTime: number;
    index: number;
    session: string;
    sessionEnd: number;
    close: number;
    line: number | undefined;
    atr: number | undefined;
    notes: SignalNotes;
}

// ---- trigger ----

export type EntryStatus = 'TRIGGERED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

/** 1m 進場時機事件（不是委託） */
export interface EntryEvent {
    id: string;
    mode: EntryMode;
    signalId: string;
    direction: Direction;
    status: EntryStatus;
    /** 觸發條件成立的 K 棒收盤 label（IMMEDIATE = 5m 訊號收棒） */
    barTime: number | null;
    /** 觸發 K 棒收盤價（參考價；虛擬成交在下一根 1m 開盤） */
    refPrice: number | null;
    /** 窗口最後一個允許觸發的 1m label */
    windowEnd: number;
    reason: string;
}

// ---- risk ----

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
    entryId: string;
    entryMode: EntryMode;
    signalId: string;
    direction: Direction;
    /** 進場時機事件的觸發時間（訊號時間） */
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
    /** 已實現損益（扣手續費；滑價已反映在成交價） */
    realizedNtd: number;
    warnings: string[];
}

export type AuditKind = 'SIGNAL' | 'ENTRY' | 'FILL' | 'EXIT' | 'STOP_MOVE' | 'TARGET' | 'WARN';

export interface AuditEvent {
    time: number;
    kind: AuditKind;
    ref: string;
    text: string;
}

// ---- engine ----

export interface TfSnapshot {
    tf: TfMinutes;
    dir: TrendDir;
    barTime: number | null;
    close: number | undefined;
    line: number | undefined;
    /** 目前方向已持續的根數 */
    age: number | null;
    /** (收盤 − 趨勢線) ÷ ATR */
    distAtr: number | undefined;
    atr: number | undefined;
    rsi: number | undefined;
    /** 與 5m 的關係（5m 本身為 NEUTRAL） */
    align: Alignment;
    keyHigh: number | undefined;
    keyLow: number | undefined;
}

export interface TrendSignalSnapshot {
    /** 1m 微型趨勢 */
    m1: TfSnapshot;
    m5: TfSnapshot;
    m15: TfSnapshot;
    m60: TfSnapshot;
    signal: TrendSignal | null;
    /** 最新訊號在各進場模式的狀態 */
    entries: Partial<Record<EntryMode, EntryEvent>>;
    /** 15m 與 60m 都與 5m 反向 */
    htfAgainst: boolean;
    trade: VirtualTrade | null;
    /** 已觸發、等待下一根 1m 開盤虛擬成交 */
    pendingEntry: { entry: EntryEvent; plan: RiskPlan } | null;
    /** 5m 已確認反向、等待下一根 1m 開盤平倉 */
    pendingExit: { signalId: string } | null;
    /** 持倉中 1m 微型趨勢與部位反向 — 只是警告 */
    m1Against: boolean;
}

export interface TrendSignalInput {
    /** 1m K 棒（排序、label 唯一）；label > asOf 的會被忽略 */
    bars1m: Candle[];
    /** 進行中的 1m K 棒（只含已觀察到的成交）；只用於虛擬成交開盤價與停損觸價 */
    live?: Candle | null;
    asOf: number;
    securityType: SecurityType;
    symbol: string;
    contractMonth: string;
    tick: number;
    /** 每口每點新臺幣；null = 規格未知，不產生風控計畫 */
    pointValue: number | null;
    config: TrendSignalConfig;
    /** 只供驗證「高週期不影響訊號」：true 時不計算 15m／60m */
    skipHtf?: boolean;
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
    t1: TrendTrack;
    t5: TrendTrack;
    t15: TrendTrack;
    t60: TrendTrack;
    /** 5m EMA（註記用，與訊號無關） */
    ema5: (number | undefined)[];
    signals: TrendSignal[];
    entries: EntryEvent[];
    trades: VirtualTrade[];
    events: AuditEvent[];
    snapshot: TrendSignalSnapshot;
    /** 最後一根已收 1m 與 asOf 的差（秒）；沒有資料為 null */
    dataLagSec: number | null;
    /** asOf 是否在交易時段內 */
    sessionOpen: boolean;
}
