// src/lib/trend-signal/core/session.ts — 交易時段（日盤／夜盤）判定：當盤 VWAP
// 的重設點、訊號 ID 的 session 欄位、候選有效期不跨盤別。沿用
// intraday-session 的時段定義，只補上收盤定盤（CLOSE_GRACE）歸屬。

import { CLOSE_GRACE, sessionWindowFor, type SessionWindow } from '../../intraday-session';
import type { SecurityType } from '../../types/contract';

export interface TradingSession extends SessionWindow {
    /** 時段開始日期（台灣）＋ D／N，例：2026-10-20N */
    key: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 牆鐘秒 → 'YYYY-MM-DD' */
export function wallDate(t: number): string {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 牆鐘秒 → 'YYYY-MM-DD HH:MM' */
export function wallTime(t: number): string {
    const d = new Date(t * 1000);
    return `${wallDate(t)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 牆鐘秒 → 'HH:MM' */
export function wallHm(t: number): string {
    const d = new Date(t * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 1m K 棒 label 所屬的交易時段。收盤後 CLOSE_GRACE 內的定盤 K 棒
 *  （例：期貨 13:46–13:49）歸剛收的那一盤，不歸下一盤。 */
export function tradingSessionOf(secType: SecurityType, label: number): TradingSession {
    let w = sessionWindowFor(secType, label);
    const p = sessionWindowFor(secType, label - CLOSE_GRACE);
    if (p.start !== w.start && label > p.end && label <= p.end + CLOSE_GRACE) w = p;
    return { ...w, key: `${wallDate(w.start)}${w.night ? 'N' : 'D'}` };
}

/** asOf 是否在交易時段內（週末開始的時段不存在；國定假日無從得知，
 *  由資料延遲判定補上） */
export function isSessionOpen(secType: SecurityType, t: number): boolean {
    const s = tradingSessionOf(secType, t);
    const wd = new Date(s.start * 1000).getUTCDay();
    if (wd === 0 || wd === 6) return false;
    return t > s.start && t <= s.end;
}
