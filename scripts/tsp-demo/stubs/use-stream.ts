// demo stub of src/hooks/use-stream.ts: 回放沒有即時行情（不連 SSE）
export function useStreamStatus() { return 'connecting' as const; }
export function useTradingLive() { return false; }
export function useQuote(_code: string | null, _o?: unknown) { return undefined; }
