import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { KBars } from './types/market';

let revision = 0;
// Shared across mounted charts: a manual refresh must not reuse another
// panel's earlier local counter value and return its old cached history.
export const nextChartHistoryRevision = () => ++revision;

const requests = new Map<string, { promise: Promise<KBars>; at: number }>();
function request(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }) {
    const key = JSON.stringify([getApiBase(), contract, start, end, opts?.revision ?? 0]);
    let entry = requests.get(key);
    if (!entry) {
        entry = { promise: fetchKbars(contract, start, end, opts), at: Date.now() };
        requests.set(key, entry);
        if (requests.size > 100) requests.delete(requests.keys().next().value!);
    }
    return entry;
}

/** Presentation rebuilds reuse history, including failures. A manual revision
 * or a new date range explicitly permits another bounded fetchKbars attempt. */
export function fetchChartHistory(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }) {
    return request(contract, start, end, opts).promise;
}

/** Same shared request, plus when it was originally sent (Date.now() ms). A cached
 * response can be older than "now"; callers that judge data completeness need this. */
export function fetchChartHistoryStamped(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }) {
    const entry = request(contract, start, end, opts);
    return entry.promise.then((kbars) => ({ kbars, requestedAt: entry.at }));
}

/** A one-off fetch outside the shared cache, stamped with its send time. For repeated
 * gap-filling requests: they must not evict the charts' cached histories. */
export function fetchChartHistoryFresh(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number }) {
    const requestedAt = Date.now();
    return fetchKbars(contract, start, end, opts).then((kbars) => ({ kbars, requestedAt }));
}
