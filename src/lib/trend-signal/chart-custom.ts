// 本圖週期模式：直接使用宿主 OHLCV，不將粗週期偽裝為 1m。
// 趨勢、候選、風控與費稅仍使用 Web 的既有純函式。
import { atr } from '../indicators';
import { CLOSE_GRACE } from '../intraday-session';
import type { BarsInput, PlotHint } from '../custom-runtime';
import { nowWallClockUtc } from '../utils/kbars';
import { configFromParams, entryKey, microParams, riskKey, trendKey } from './config';
import { CUSTOM_TSP_PLOTS, normalizeCustomBars, projectCustomTsp, type CustomPlotResult } from './custom-adapter';
import { alignPoints } from './core/bars';
import { isRegularMinute, tradingSessionOf, wallDate } from './core/session';
import { runVirtual } from './risk/virtual';
import { invalidAt, switchAt, trendTrack } from './trend/signals';
import { computeEntries } from './trigger/entries';
import type { AuditEvent, TfSeries, TrendInvalidation, TrendSignal } from './types';

export const CHART_TSP_VERSION = 'tsp-chart-1.2.0';
const DAY = 86400;
const nameOf = (key: string) => key === '1m 微型提示' ? '本圖微型提示' : key === '1m 結構提示' ? '本圖結構提示' : key;
export const CHART_TSP_PLOTS = CUSTOM_TSP_PLOTS.map(([key, color]) => [nameOf(key), color] as const);

/** 宿主未傳 tf；預設由間距推斷，可用 chartTf 明訂分鐘數消除缺棒歧義。 */
export function inferChartMinutes(times: number[], explicit = 0): number {
    if (!Number.isInteger(explicit) || explicit < 0 || explicit > 1440) throw new Error('chartTf 必須為 0（自動）或 1–1440 分鐘');
    if (explicit > 0) return explicit;
    if (times.length < 2) return 1;
    if (times.every((t) => t % DAY === 0)) return 1440;
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    let step = 0;
    for (let i = 1; i < times.length; i++) step = gcd(step, (times[i]! - times[i - 1]!) / 60);
    if (!Number.isInteger(step) || step < 1 || step > 1440) throw new Error('無法判定主圖週期，請以 chartTf 指定分鐘數');
    return step;
}

/** 60m 的 14:00 桶仍屬日盤，不能直接把粗棒 label 當最後成交分鐘。 */
export function chartSession(label: number, minutes: number) {
    for (let t = label - minutes * 60 + 60; t <= label; t += 60) {
        if (isRegularMinute('FUT', t)) return tradingSessionOf('FUT', t);
        const session = tradingSessionOf('FUT', t);
        if (t > session.start && t <= session.end + CLOSE_GRACE) return session;
    }
    return tradingSessionOf('FUT', label);
}

export function frameFromChart(bars: BarsInput, params: Record<string, number> = {}, nowWall = nowWallClockUtc()) {
    if (!Number.isFinite(nowWall)) throw new Error('計算時刻無效');
    const normalized = normalizeCustomBars(bars, params);
    const minutes = inferChartMinutes(normalized.sorted.map((b) => b.time), params.chartTf ?? 0);
    const seconds = minutes * 60;
    const daily = minutes === 1440;
    if (normalized.sorted.some((b) => b.time % seconds !== 0)) throw new Error('chartTf 與 K 棒時間未對齊，請核對主圖週期');
    // App 日K以日曆日開端標記；內部轉為該日結束，投影時再映回原 label。
    const mapTime = (t: number) => daily ? t + DAY : t;
    const ceiling = daily ? (Math.floor(nowWall / DAY) + 1) * DAY : Math.ceil(nowWall / seconds) * seconds;
    const visible = normalized.sorted.map((b) => ({ ...b, time: mapTime(b.time) })).filter((b) => b.time <= ceiling);
    const last = visible.at(-1);
    const settled = last !== undefined && (daily ? nowWall >= last.time + 10
        : nowWall >= Math.max(last.time, chartSession(last.time, minutes).end + CLOSE_GRACE) + 10);
    const confirmed = settled ? visible : visible.slice(0, -1);
    const live = settled ? null : last ?? null;
    const asOf = confirmed.at(-1)?.time ?? -Infinity;
    const sessions = confirmed.map((b) => daily ? `CALENDAR:${wallDate(b.time - DAY)}` : chartSession(b.time, minutes).key);
    const sessionEnd = confirmed.map((b) => daily ? Infinity : chartSession(b.time, minutes).end);
    const series: TfSeries = { tf: minutes, bars: confirmed, lastMinute: confirmed.map((b) => b.time),
        session: sessions, sessionEnd, missing: confirmed.map(() => 0) };
    const next = new Map(visible.slice(0, -1).map((b, i) => [b.time, visible[i + 1]!.time]));
    const label = daily ? '1D（日曆日）' : `${minutes}m`;
    const clock = { baseLabel: label, trendLabel: label,
        openTime: (t: number) => daily ? t - seconds : Math.max(t - seconds, chartSession(t, minutes).start),
        // 日K只宣稱下一根可用日K，沒有交易日曆，不能判別漏日與休市。
        isNext: (from: number, to: number) => daily ? next.get(from) === to : to === from + seconds };
    return { ...normalized, minutes, seconds, daily, label, mapTime, visible, confirmed, live, asOf, series, clock,
        config: configFromParams(params) };
}

export function runChartSignal(frame: ReturnType<typeof frameFromChart>) {
    const { series, config: cfg, asOf, label } = frame;
    const track = trendTrack(series, cfg.trend);
    const micro = trendTrack(series, microParams(cfg));
    const av = alignPoints(series.bars, atr(series.bars, cfg.note.atrPeriod));
    const signals: TrendSignal[] = [];
    const invalidations: TrendInvalidation[] = [];
    const key = `${CHART_TSP_VERSION}|chart=${frame.minutes}|${trendKey(cfg)}`;
    series.bars.forEach((b, i) => {
        const id = `${key}|${series.session[i]}|${b.time}`;
        const from = invalidAt(track.dir, i);
        if (from) invalidations.push({ id: `${id}|INVALID`, barTime: b.time, index: i, from });
        const kind = switchAt(track.dir, i);
        if (kind) signals.push({ id: `${id}|${kind}`, kind, direction: kind === 'BUY' ? 'LONG' : 'SHORT',
            barTime: b.time, index: i, session: series.session[i]!, sessionEnd: series.sessionEnd[i]!, close: b.close,
            line: track.line[i], atr: av[i], notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN',
                m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null,
                m15Stale: true, m60Stale: true, m15Incomplete: false, m60Incomplete: false } });
    });
    const timing = computeEntries({ signals, m1: series.bars, m1Session: series.session, m1SessionEnd: series.sessionEnd,
        m1Hole: series.bars.map(() => false), m5: series.bars, dir5: track.dir, micro: micro.dir,
        asOf, p: cfg.entry, key: `${key}|${entryKey(cfg)}`, chartMinutes: frame.minutes });
    const v = runVirtual({ m1: series.bars, m1SessionEnd: series.sessionEnd, live: frame.live, asOf,
        m5: series, t5: track, signals, invalidations, entries: timing.entries.filter((e) => e.mode === cfg.entry.mode),
        cfg: cfg.risk, tick: frame.tick, pointValue: frame.pointValue, taxRate: frame.taxRate, key: `${key}|${riskKey(cfg)}`, clock: frame.clock });
    const events: AuditEvent[] = signals.map((s) => ({ time: s.barTime, kind: 'SIGNAL', ref: s.id, text: `本圖 ${label} ${s.kind} @ ${s.close}` }));
    events.push(...v.events.map((e) => ({ ...e, text: e.text.replace(/\b[15]m\b/g, label) })));
    events.sort((a, b) => a.time - b.time);
    return { version: CHART_TSP_VERSION, timeframeMinutes: frame.minutes, timeframeLabel: label, asOf,
        m1: series, m5: series, t5: track, signals, invalidations, entries: timing.entries,
        trades: v.trades, events, snapshot: { trade: v.open ?? v.trades.at(-1) ?? null }, pendingEntry: v.pendingEntry,
        pendingExit: v.pendingExit } satisfies CustomPlotResult & Record<string, unknown>;
}

export function computeChartCustomTsp(bars: BarsInput, params: Record<string, number> = {}, nowWall = nowWallClockUtc()) {
    if (params.riskHistory !== undefined && params.riskHistory !== 0 && params.riskHistory !== 1) throw new Error('riskHistory 只接受 0 或 1');
    const frame = frameFromChart(bars, params, nowWall);
    const result = runChartSignal(frame);
    const through = frame.live?.time ?? frame.confirmed.at(-1)?.time ?? -Infinity;
    const mappedTimes = bars.time.map(frame.mapTime);
    const projected = projectCustomTsp(result, mappedTimes, through, params.riskHistory === 1);
    // 宿主曲線會跨 whitespace 連線：只畫最後一段連續有效趨勢，歷史成交點仍保留。
    const last = frame.confirmed.length - 1;
    let start = last;
    const direction = result.t5.dir[last];
    while (start > 0 && result.t5.dir[start - 1] === direction &&
        (frame.daily || (frame.confirmed[start]!.time - frame.confirmed[start - 1]!.time === frame.seconds &&
            frame.series.session[start] === frame.series.session[start - 1]))) start--;
    for (const key of ['多方趨勢線', '空方趨勢線']) {
        projected[key] = projected[key]!.map((v, i) => {
            const time = mappedTimes[i]!;
            if (time < (frame.confirmed[start]?.time ?? Infinity)) return null;
            if (!frame.daily && time > (frame.confirmed[last]?.time ?? -Infinity) &&
                (time !== frame.confirmed[last]!.time + frame.seconds ||
                    chartSession(time, frame.minutes).key !== frame.series.session[last])) return null;
            return v;
        });
    }
    const outputs = Object.fromEntries(Object.entries(projected).map(([k, v]) => [nameOf(k), v]));
    const levelKeys = new Set(['初始停損', '目前停損', '保本價', '1R', '2R', '3R']);
    const hints = Object.fromEntries(CHART_TSP_PLOTS.map(([key, color]) => [key, { color,
        kind: key.endsWith('趨勢線') ? 'line' : levelKeys.has(key) ? params.riskHistory === 1 ? 'points' : 'line' : 'points',
        width: key === '目前停損' || key.endsWith('趨勢線') ? 2 : 1 } satisfies PlotHint]));
    return { frame, result, outputs, order: CHART_TSP_PLOTS.map(([key]) => key), hints };
}
