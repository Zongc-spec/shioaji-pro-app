// demo stub of src/lib/account-store.ts：觀察用，沒有任何帳戶
const state = { loaded: true, accounts: [], selectedStock: undefined, selectedFutures: undefined };
export async function loadAccountsShared() { return []; }
export function ensureAccounts() { return undefined; }
export function refreshAccounts() { return Promise.resolve(); }
export function selectAccount() { /* demo */ }
export function getAccountState() { return state; }
export function accountFor() { return undefined; }
export function subscribeAccounts() { return () => undefined; }
export function useAccounts() { return state; }
