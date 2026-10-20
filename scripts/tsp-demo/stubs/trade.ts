// demo stub of src/lib/trade.ts：通知寫到 console；任何送單、刪單一律拒絕（示範畫面不會送單）
import type { ContractBase } from '../../../src/lib/types/contract';

export interface AppNotice { kind: 'ok' | 'err' | 'info'; title: string; body: string }
export interface LoggedNotice extends AppNotice { ts: number }
const refuse = async (): Promise<never> => { throw new Error('示範畫面不會送單'); };
export function notify(n: AppNotice) { console.info('[demo notice]', n); }
export function logNotice(n: AppNotice) { console.info('[demo log]', n); }
export function onNotice() { return () => undefined; }
export function subscribeNoticeLog() { return () => undefined; }
export function getNoticeLog(): LoggedNotice[] { return []; }
export function clearNoticeLog() { /* demo */ }
export function isFuturesContract(c: ContractBase) { return c.security_type === 'FUT' || c.security_type === 'OPT'; }
export function assertTradingLive() { throw new Error('示範畫面不會送單'); }
export const placeQuickOrder = refuse;
export const placeStockExitByShares = refuse;
export const cancelAllOrders = refuse;
