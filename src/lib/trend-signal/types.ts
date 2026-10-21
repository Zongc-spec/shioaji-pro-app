// src/lib/trend-signal/types.ts — Trend Signal Pro 的共用型別。
// 模組分工（單向依賴）：core（已收棒資料）→ trend（趨勢訊號，純指標）
// → trigger（1m 進場時機）→ risk（虛擬風控）。時間一律是台灣牆鐘編碼成
// UTC 秒（utils/kbars.wallClockToUtc），K 棒時間是收盤 label。

import type { SecurityType } from '../types/contract';
import type { Candle } from '../types/market';

/** TrendCore 狀態（V1.1 §2）：NEUTRAL = 已知但無方向（例：Donchian 觸及 ATR 追蹤帶，趨勢失效） */
export type TrendState = 'LONG' | 'SHORT' | 'NEUTRAL' | 'UNKNOWN';
export type Direction = 'LONG' | 'SHORT';
export type Alignment = 'ALIGN' | 'DIVERGE' | 'NEUTRAL';
/** 週期分鐘數：原生管線只有 1／5／15／60（NativeTf）；本圖模式另有任意分鐘與 1440（日K） */
export type TfMinutes = number;
export type NativeTf = 1 | 5 | 15 | 60;
export type TrendAlgoId = 'supertrend' | 'donchian' | 'kama';
export type EntryMode = 'IMMEDIATE' | 'MICRO_TREND' | 'PRICE_STRUCTURE' | 'PULLBACK_KD';

// ---- 設定（依模組分組；每個模組只拿得到自己那一份） ----

export interface TrendParams {
    algo: TrendAlgoId;
    stPeriod: number;
    stMult: number;
    dcLength: number;
    /** Donchian 的 ATR 追蹤帶倍數（ATR14）；收盤穿越即 NEUTRAL */
    dcAtrMult: number;
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
    /** 0 = 整段 5m 同向狀態都可提示（V1.1 預設）；N = 只在翻轉後 N 根 5m 內（post-flip window，不跨盤） */
    windowBars: number;
    /** 1m 微型趨勢：與 5m 同一演算法家族、參數獨立 */
    microMult: number;
    microDcLength: number;
    microKamaHyst: number;
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
    /** 風控模型：0＝初始停損依進場週期（1m）的擺動點／ATR、+1R 保本、+2R 起移動停損；
     *  1＝初始停損改依主趨勢週期（5m）的擺動點／ATR，保本與移動規則同 0；
     *  2＝初始停損同 1、不移保本，進場後每根 5m 收棒就開始移動停損 */
    riskModel: 0 | 1 | 2;
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
    /** 該根所屬交易時段的收盤 label */
    sessionEnd: number[];
    /** 該根缺少的正規交易分鐘數（0 = 完整；1m 恆為 0） */
    missing: number[];
}

/** 資料不完整而排除的週期 K 棒（不產生任何訊號、提示或虛擬進場） */
export interface DataGap {
    tf: TfMinutes;
    /** 收盤 label */
    label: number;
    /** 缺少的 1m 根數 */
    missing: number;
}

// ---- trend ----

/** 某週期的趨勢線與方向（暖身內為 UNKNOWN） */
export interface TrendTrack {
    tf: TfMinutes;
    algo: TrendAlgoId;
    line: (number | undefined)[];
    dir: TrendState[];
    /** 線就是翻轉價位（可當停損參考）；KAMA 為 false */
    stopLine: boolean;
}

/** 5m 趨勢失效（LONG／SHORT → NEUTRAL）：只顯示，不是 BUY／SELL */
export interface TrendInvalidation {
    id: string;
    barTime: number;
    index: number;
    from: Direction;
}

export interface SignalNotes {
    /** 收盤對 EMA 與 EMA 斜率：同向／逆向／不一致 */
    ema: 'WITH' | 'AGAINST' | 'MIXED' | 'UNKNOWN';
    m15: TrendState;
    m60: TrendState;
    m15Align: Alignment;
    m60Align: Alignment;
    m15BarTime: number | null;
    m60BarTime: number | null;
    /** 訊號當時已知的最後一根 15m／60m 不是前一個桶（換盤、缺資料） */
    m15Stale: boolean;
    m60Stale: boolean;
    /** 那一根 15m／60m 缺少 1m（只標示） */
    m15Incomplete: boolean;
    m60Incomplete: boolean;
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

/** 1m 進場提示（V1.1 §2：POTENTIAL_ENTRY_LONG／SHORT）；不是委託，也不是 5m BUY/SELL */
export interface EntryEvent {
    id: string;
    kind: 'POTENTIAL_ENTRY_LONG' | 'POTENTIAL_ENTRY_SHORT';
    mode: EntryMode;
    signalId: string;
    direction: Direction;
    /** 條件成立的 K 棒收盤 label（IMMEDIATE = 5m 訊號收棒） */
    barTime: number;
    /** 觸發 K 棒收盤價（參考價；虛擬成交在下一根 1m 開盤） */
    refPrice: number;
    /** 同一段 5m 趨勢內第幾次提示（1 起算） */
    seq: number;
    reason: string;
}

/** 最新一段 5m 趨勢在某進場模式的目前狀態（Dashboard 用） */
export interface EntryModeState {
    mode: EntryMode;
    /** 趨勢仍有效且仍在允許提示的範圍內 */
    active: boolean;
    hints: number;
    last: EntryEvent | null;
    /** 目前在等什麼／為什麼沒有提示 */
    waiting: string;
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
    | 'REVERSAL'
    /** 5m 趨勢失效（→ NEUTRAL）：與反向同樣在下一根 1m 開盤出場 */
    | 'TREND_INVALID';

export interface TradeFill {
    /** 成交所在 1m K 棒的收盤 label */
    time: number;
    /** 在那根 K 棒的哪裡成交：open＝開盤（時刻 label − 60）；intrabar＝盤中觸價（label − 60 到 label 之間） */
    at: 'open' | 'intrabar';
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
    /** 實際成交時刻＝那根 K 棒的開盤（fillTime − 60） */
    fillAt: number;
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
    /** 已實現點數 × 口數（滑價已反映在成交價；未扣手續費與期交稅） */
    realizedPoints: number;
    /** 已出場部分的手續費＋期交稅（新臺幣） */
    costNtd: number;
    /** 已實現損益＝點數 × 每點價值 − costNtd */
    realizedNtd: number;
    warnings: string[];
}

/** SIGNAL 5m 切換、INVALID 5m 失效、ENTRY 1m 提示（風控採用的模式）、PLAN 虛擬風控
 *  接受提示並排定下一根開盤成交、DATA 資料不完整（排除的 K 棒）、其餘為虛擬部位的生命週期 */
export type AuditKind = 'SIGNAL' | 'INVALID' | 'ENTRY' | 'PLAN' | 'FILL' | 'EXIT' | 'STOP_MOVE' | 'TARGET' | 'WARN' | 'DATA';

export interface AuditEvent {
    /** 事件發生的時刻：收棒事件＝收盤 label；開盤成交、開盤生效的停損＝該 1m 開盤（label − 60）；
     *  盤中觸價＝該 1m 收盤 label（觸價發生在那根之內） */
    time: number;
    kind: AuditKind;
    ref: string;
    text: string;
}

// ---- engine ----

export interface TfSnapshot {
    tf: TfMinutes;
    dir: TrendState;
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
    /** 盤中且最後一根不是前一個桶（換盤後尚未收第一根、資料缺洞） */
    stale: boolean;
    /** 最後一根缺少 1m（15m／60m 只標示；5m 不完整的桶已排除） */
    incomplete: boolean;
}

export interface TrendSignalSnapshot {
    /** 1m 微型趨勢 */
    m1: TfSnapshot;
    m5: TfSnapshot;
    m15: TfSnapshot;
    m60: TfSnapshot;
    signal: TrendSignal | null;
    /** 最新訊號之後的 5m 失效事件（目前為 NEUTRAL 的起點） */
    invalid: TrendInvalidation | null;
    /** 30 分鐘內因資料不完整而排除的最後一根 5m */
    recentGap: DataGap | null;
    /** 最新一段 5m 趨勢在各進場模式的狀態（只含有計算的模式） */
    entries: Partial<Record<EntryMode, EntryModeState>>;
    /** 15m 與 60m 都與 5m 反向 */
    htfAgainst: boolean;
    trade: VirtualTrade | null;
    /** 已觸發、等待下一根 1m 開盤虛擬成交 */
    pendingEntry: { entry: EntryEvent; plan: RiskPlan } | null;
    /** 5m 已確認反向或失效、等待下一根 1m 開盤平倉（ref = 訊號或失效事件 ID） */
    pendingExit: { ref: string; reason: 'REVERSAL' | 'TREND_INVALID' } | null;
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
    /** 期交稅率（單邊，按契約價值）；0 = 不計 */
    taxRate?: number;
    config: TrendSignalConfig;
    /** 只供驗證「高週期不影響訊號」：true 時不計算 15m／60m */
    skipHtf?: boolean;
}

export interface TrendSignalResult {
    version: string;
    configKey: string;
    /** 期交稅率（單邊）；0 = 不計 */
    taxRate: number;
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
    invalidations: TrendInvalidation[];
    /** 資料不完整而排除的 5m（不參與趨勢計算、不產生任何事件） */
    gaps: DataGap[];
    entries: EntryEvent[];
    trades: VirtualTrade[];
    events: AuditEvent[];
    snapshot: TrendSignalSnapshot;
    /** 最後一根已收 1m 與 asOf 的差（秒）；沒有資料為 null */
    dataLagSec: number | null;
    /** asOf 是否在交易時段內 */
    sessionOpen: boolean;
}
