// src/components/trend-signal-panel.tsx — Trend Signal Pro 的圖上面板：右上四週期
// Dashboard（5m 主控、1m 微型、15m 輔助、60m 背景與進場時機）、右下虛擬風控（R 面板）、
// 審計視窗與模式切換。只顯示、不送任何委託；「模擬警示」只發 App 通知（onAlert 由
// candle-chart 注入，本元件不 import 任何交易模組）。

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import type { TrendSignalFeed } from '../hooks/use-trend-signal';
import { maskMoney, usePrivacyMode } from '../lib/privacy';
import { TSP_PERMISSIONS } from '../lib/trend-signal/config';
import { wallHm, wallTime } from '../lib/trend-signal/core/session';
import { exitText } from '../lib/trend-signal/risk/virtual';
import type {
    Alignment,
    AuditEvent,
    EntryEvent,
    EntryMode,
    EntryStatus,
    TfSnapshot,
    TrendDir,
    TrendSignalConfig,
    TrendSignalResult,
} from '../lib/trend-signal/types';
import type { ContractBase } from '../lib/types/contract';
import { formatToTick } from '../lib/utils/ticksize';
import * as s from './trend-signal-panel.css';

// ---- 面板偏好（每個指標實例一份；只是本機的顯示偏好） ----

export type TspMode = 'observe' | 'alert';
export interface TspPrefs {
    mode: TspMode;
    collapsed: boolean;
    riskCollapsed: boolean;
    mini: boolean;
}
const PREFS_KEY = 'sj-pro-tsp-ui-v1';
const DEFAULT_PREFS: TspPrefs = { mode: 'observe', collapsed: false, riskCollapsed: false, mini: false };

function loadAllPrefs(): Record<string, Partial<TspPrefs>> {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) return JSON.parse(raw) as Record<string, Partial<TspPrefs>>;
    } catch {
        // fresh
    }
    return {};
}

export function useTspPrefs(instanceId: string | null): [TspPrefs, (patch: Partial<TspPrefs>) => void] {
    const [prefs, setPrefs] = useState<TspPrefs>(() => ({ ...DEFAULT_PREFS, ...(instanceId ? loadAllPrefs()[instanceId] : {}) }));
    useEffect(() => {
        setPrefs({ ...DEFAULT_PREFS, ...(instanceId ? loadAllPrefs()[instanceId] : {}) });
    }, [instanceId]);
    const patch = (p: Partial<TspPrefs>) => {
        setPrefs((cur) => {
            const next = { ...cur, ...p };
            if (instanceId) {
                try {
                    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadAllPrefs(), [instanceId]: next }));
                } catch {
                    // keep in-memory
                }
            }
            return next;
        });
    };
    return [prefs, patch];
}

// ---- 模擬警示：只對 LIVE、盤中、3 分鐘內的新事件發通知；已發過的 ID 跨重開記住 ----

export interface TspAlert {
    kind: 'ok' | 'err' | 'info';
    title: string;
    body: string;
}
const ALERTED_KEY = 'sj-pro-tsp-alerted-v1';
const ALERT_KINDS: AuditEvent['kind'][] = ['SIGNAL', 'ENTRY', 'FILL', 'EXIT'];
const ALERT_TITLE: Partial<Record<AuditEvent['kind'], string>> = {
    SIGNAL: '5m 趨勢切換',
    ENTRY: '1m 進場時機',
    FILL: '虛擬成交',
    EXIT: '虛擬出場',
};

function loadAlerted(): string[] {
    try {
        const raw = localStorage.getItem(ALERTED_KEY);
        if (raw) return JSON.parse(raw) as string[];
    } catch {
        // fresh
    }
    return [];
}

/** 新的可提醒事件（純函式，供測試） */
export function pendingAlerts(res: TrendSignalResult, alerted: Set<string>): { key: string; event: AuditEvent }[] {
    return res.events
        .filter((e) => ALERT_KINDS.includes(e.kind) && e.time >= res.asOf - 180)
        .map((event) => ({ key: `${event.kind}|${event.ref}|${event.time}`, event }))
        .filter((x) => !alerted.has(x.key));
}

export function useTspAlerts(feed: TrendSignalFeed, mode: TspMode, onAlert: (a: TspAlert) => void) {
    const res = feed.result;
    useEffect(() => {
        if (mode !== 'alert' || !res || feed.stream !== 'live' || !res.sessionOpen) return;
        const list = loadAlerted();
        const alerted = new Set(list);
        const fresh = pendingAlerts(res, alerted);
        if (fresh.length === 0) return;
        for (const { key, event } of fresh) {
            list.push(key);
            onAlert({ kind: 'info', title: `Trend Signal Pro · ${ALERT_TITLE[event.kind] ?? event.kind}`, body: `${res.symbol} ${wallHm(event.time)} ${event.text}` });
        }
        try {
            localStorage.setItem(ALERTED_KEY, JSON.stringify(list.slice(-500)));
        } catch {
            // keep going
        }
        // onAlert 由呼叫端每次 render 重建，不列入依賴
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [res, mode, feed.stream]);
}

// ---- 顯示用文字 ----

const DIR_TEXT: Record<TrendDir, string> = { UP: '▲ 多', DOWN: '▼ 空', UNKNOWN: '— 未知' };
const ALIGN_TEXT: Record<Alignment, string> = { ALIGN: '同向', DIVERGE: '逆向', NEUTRAL: '中性' };
const MODE_TEXT: Record<EntryMode, string> = {
    IMMEDIATE: '立即',
    MICRO_TREND: '微型趨勢',
    PRICE_STRUCTURE: '價格結構',
    PULLBACK_KD: '舊假說 KD',
};
const STATUS_TEXT: Record<EntryStatus, string> = { TRIGGERED: '已觸發', PENDING: '等待', EXPIRED: '逾期', CANCELLED: '取消' };
const EMA_TEXT = { WITH: 'EMA 同向', AGAINST: 'EMA 逆向', MIXED: 'EMA 不一致', UNKNOWN: 'EMA —' } as const;
const ALGO_TEXT = { supertrend: 'SuperTrend', donchian: 'Donchian', kama: 'KAMA' } as const;

const num = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const hm = (t: number | null | undefined) => (t === null || t === undefined ? '—' : wallHm(t));

function feedBadge(feed: TrendSignalFeed): { cls: keyof typeof s.badge; text: string } {
    const res = feed.result;
    if (feed.error && !res) return { cls: 'down', text: 'K 線歷史無法取得' };
    if (!res) return { cls: 'idle', text: feed.loading ? '載入 20 天 1m…' : '等待資料' };
    if (feed.stream !== 'live') return { cls: 'down', text: `行情未連線（${feed.stream}）— 訊號不可交易` };
    if (!res.sessionOpen) return { cls: 'idle', text: '休市' };
    if (res.dataLagSec !== null && res.dataLagSec > 180) return { cls: 'warn', text: `資料延遲 ${Math.round(res.dataLagSec)} 秒` };
    return { cls: 'live', text: 'LIVE' };
}

function TfRow({ label, snap, px, showAlign }: { label: string; snap: TfSnapshot; px: (v: number | undefined) => string; showAlign: boolean }) {
    return (
        <div className={s.row}>
            <span className={s.rowLabel}>{label}</span>
            <span className={s.rowMain}>
                <span className={s.dir[snap.dir]}>{DIR_TEXT[snap.dir]}</span>
                {snap.age !== null && <span>{snap.age} 根</span>}
                {showAlign && <span className={s.tag[snap.align]}>{ALIGN_TEXT[snap.align]}</span>}
                {showAlign && <span>H {px(snap.keyHigh)} L {px(snap.keyLow)}</span>}
            </span>
            <span className={s.rowTime}>{hm(snap.barTime)}</span>
        </div>
    );
}

export function TrendSignalPanel({
    feed,
    config,
    contract,
    lastPrice,
    prefs,
    onPrefs,
    right,
}: {
    feed: TrendSignalFeed;
    config: TrendSignalConfig;
    contract: ContractBase;
    lastPrice: number | null;
    prefs: TspPrefs;
    onPrefs: (patch: Partial<TspPrefs>) => void;
    /** 右側要讓出的寬度（價格軸） */
    right: number;
}) {
    const [audit, setAudit] = useState(false);
    const privacy = usePrivacyMode();
    const res = feed.result;
    const px = (v: number | undefined | null) => (v === undefined || v === null || !Number.isFinite(v) ? '—' : formatToTick(contract, v));
    const money = (v: number) => maskMoney(`NT$${Math.round(v).toLocaleString('en-US')}`, privacy);
    const badge = feedBadge(feed);
    const snap = res?.snapshot;
    const signal = snap?.signal ?? null;

    if (prefs.collapsed) {
        return (
            <button className={s.chip} style={{ right }} onClick={() => onPrefs({ collapsed: false })} title='展開 Trend Signal Pro'>
                <span>TSP</span>
                {snap && <span className={s.dir[snap.m5.dir]}>{DIR_TEXT[snap.m5.dir]}</span>}
                {signal && <span>{signal.kind} {hm(signal.barTime)}</span>}
                <span className={s.badge[badge.cls]}>{badge.text}</span>
            </button>
        );
    }

    const modes: EntryMode[] = ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'];
    if (config.entry.mode === 'PULLBACK_KD') modes.push('PULLBACK_KD');
    const trade = snap?.trade ?? null;
    const open = trade?.status === 'OPEN' ? trade : null;
    const sign = open?.direction === 'LONG' ? 1 : -1;
    const pv = open?.plan.pointValue ?? 0;
    const unrealPts = open && lastPrice !== null ? sign * (lastPrice - open.fillPrice) * open.openQty : null;
    const unrealNtd = unrealPts !== null && open ? unrealPts * pv - 2 * config.risk.feePerSide * open.openQty : null;
    const pending = snap?.pendingEntry ?? null;

    return (
        <>
            <div className={s.dashboard} style={{ right }}>
                <div className={s.header}>
                    <span className={s.headerTitle} title='Trend Signal Pro'>TSP · {ALGO_TEXT[config.trend.algo]}</span>
                    <select
                        className={s.select}
                        value={prefs.mode}
                        title='觀察：只顯示；模擬警示：新訊號發 App 通知。模擬交易（P4）尚未授權；正式交易 V1 不開放'
                        onChange={(e) => onPrefs({ mode: e.target.value as TspMode })}
                    >
                        <option value='observe'>觀察</option>
                        <option value='alert'>模擬警示</option>
                        <option value='sim' disabled>模擬交易（未授權）</option>
                        <option value='live' disabled>正式交易（不開放）</option>
                    </select>
                    <button className={s.btn} onClick={() => setAudit(true)} disabled={!res}>審計</button>
                    <button className={prefs.mini ? s.btnOn : s.btn} onClick={() => onPrefs({ mini: !prefs.mini })} title='1m 小圖'>1m</button>
                    <button className={s.btn} onClick={() => onPrefs({ collapsed: true })} title='收合'>—</button>
                </div>
                <div className={s.body}>
                    <div>
                        <span className={s.badge[badge.cls]}>{badge.text}</span>
                        <span className={s.note}> · 只觀察，不送任何委託</span>
                    </div>
                    {snap && (
                        <>
                            <div className={s.row}>
                                <span className={s.rowLabel}>5m 主控</span>
                                <span className={s.rowMain}>
                                    <span className={`${s.primary} ${s.dir[snap.m5.dir]}`}>{DIR_TEXT[snap.m5.dir]}</span>
                                    {snap.m5.age !== null && <span>{snap.m5.age} 根</span>}
                                    <span title='(收盤 − 趨勢線) ÷ ATR'>距線 {num(snap.m5.distAtr)} ATR</span>
                                    <span>ATR {num(snap.m5.atr, 1)}</span>
                                    <span>RSI {num(snap.m5.rsi, 0)}</span>
                                </span>
                                <span className={s.rowTime}>{hm(snap.m5.barTime)}</span>
                                {signal && (
                                    <span className={s.sub}>
                                        最新 {signal.kind} {hm(signal.barTime)} @ {px(signal.close)} · {EMA_TEXT[signal.notes.ema]} · 15m {ALIGN_TEXT[signal.notes.m15Align]} · 60m {ALIGN_TEXT[signal.notes.m60Align]}
                                    </span>
                                )}
                            </div>
                            <TfRow label='1m 微型' snap={snap.m1} px={px} showAlign={false} />
                            <div className={s.row}>
                                <span className={s.rowLabel}>進場時機</span>
                                <span className={s.rowMain}>
                                    {modes.map((m) => {
                                        const e: EntryEvent | undefined = snap.entries[m];
                                        return (
                                            <span key={m} title={e?.reason ?? '尚無 5m 訊號'}>
                                                {m === config.entry.mode ? '★' : ''}{MODE_TEXT[m]}{' '}
                                                <span className={e ? s.entryStatus[e.status] : undefined}>
                                                    {e ? `${STATUS_TEXT[e.status]}${e.barTime !== null ? ` ${hm(e.barTime)}` : ''}` : '—'}
                                                </span>
                                            </span>
                                        );
                                    })}
                                </span>
                                <span />
                            </div>
                            <TfRow label='15m 輔助' snap={snap.m15} px={px} showAlign />
                            <TfRow label='60m 背景' snap={snap.m60} px={px} showAlign />
                            {snap.htfAgainst && <div className={s.warn}>⚠ 高週期逆向：15m 與 60m 都與 5m 反向（只提示，不改訊號）</div>}
                            {snap.m1Against && <div className={s.warn}>⚠ 1m 微型趨勢與虛擬部位反向（只警告，不出場）</div>}
                        </>
                    )}
                    <div className={s.note}>★ 為虛擬風控採用的進場時機。自行設計的公開演算法，非 Universal Indicator／Ultimate AI 原版。</div>
                </div>
            </div>
            {res && prefs.riskCollapsed && (
                <button className={s.riskChip} style={{ right }} onClick={() => onPrefs({ riskCollapsed: false })} title='展開虛擬風控'>
                    虛擬風控 · {open ? `${open.direction === 'LONG' ? '多' : '空'} ${open.openQty} 口 停損 ${px(open.stop)}` : pending ? '待成交' : '無部位'}
                </button>
            )}
            {res && !prefs.riskCollapsed && (
                <div className={s.riskCard} style={{ right }}>
                    <div className={s.header}>
                        <span className={s.headerTitle}>虛擬風控 · {res.symbol}</span>
                        <span className={s.note}>觀察模式（無帳號）</span>
                        <button className={s.btn} onClick={() => onPrefs({ riskCollapsed: true })} title='收合'>—</button>
                    </div>
                    <div className={s.body}>
                        {res.snapshot.trade === null && !pending && <div className={s.note}>目前無虛擬部位</div>}
                        {pending && (
                            <div>
                                {MODE_TEXT[pending.entry.mode]}已觸發 {hm(pending.entry.barTime)}：待下一根 1m 開盤虛擬成交 · 參考 {px(pending.plan.entry)} · 停損 {px(pending.plan.stop)} · R {pending.plan.riskPoints} 點／{money(pending.plan.totalRisk)} · {pending.plan.qty} 口
                            </div>
                        )}
                        {trade && trade.status === 'CLOSED' && !pending && (
                            <>
                                <div>
                                    上一筆（已出場）：<span className={s.dir[trade.direction === 'LONG' ? 'UP' : 'DOWN']}>{trade.direction === 'LONG' ? '多' : '空'}</span>{' '}
                                    {trade.qty} 口 @ {px(trade.fillPrice)}（{hm(trade.fillTime - 60)} 成交，{MODE_TEXT[trade.entryMode]}觸發 {hm(trade.signalTime)}）
                                </div>
                                <div>出場：{trade.fills.map((f) => `${exitText(f.reason)} ${f.qty} 口 @ ${px(f.price)}（${hm(f.time)}）`).join('；')}</div>
                                <div>初始停損 {px(trade.plan.stop)} · R {trade.plan.riskPoints} 點／{money(trade.plan.riskPerLot * trade.qty)} · 已實現 {trade.realizedPoints >= 0 ? '+' : ''}{trade.realizedPoints} 點／{money(trade.realizedNtd)}（虛擬，扣手續費）</div>
                            </>
                        )}
                        {open && (
                            <>
                                <div>
                                    <span className={s.dir[open.direction === 'LONG' ? 'UP' : 'DOWN']}>{open.direction === 'LONG' ? '多' : '空'}</span>{' '}
                                    {open.openQty}/{open.qty} 口 @ {px(open.fillPrice)}（{hm(open.fillTime - 60)} 成交，{MODE_TEXT[open.entryMode]}觸發 {hm(open.signalTime)}）
                                </div>
                                <div>初始停損 {px(open.plan.stop)}（{open.plan.stopBasis === 'swing' ? '擺動點' : open.plan.stopBasis === 'atr' ? '1m ATR' : 'ATR 備援'}）· R {open.plan.riskPoints} 點／{money(open.plan.riskPerLot * open.qty)}</div>
                                <div>1R {px(open.plan.r1)} · 2R {px(open.plan.r2)} · 3R {px(open.plan.r3)} · 保本 {px(open.plan.breakevenStop)}</div>
                                <div>目前停損 {px(open.stop)}（{open.stopKind === 'initial' ? '初始' : open.stopKind === 'breakeven' ? '保本' : '移動'}）{open.trailing ? ' · 移動停損啟動' : ''}</div>
                                <div>
                                    {unrealPts !== null && unrealNtd !== null && <>未實現 {unrealPts >= 0 ? '+' : ''}{unrealPts} 點／{money(unrealNtd)} · </>}
                                    已實現 {open.realizedPoints >= 0 ? '+' : ''}{open.realizedPoints} 點／{money(open.realizedNtd)}（虛擬，扣手續費）
                                </div>
                                {snap?.pendingExit && <div className={s.warn}>5m 已確認反向：下一根 1m 開盤平倉（不等 1m）</div>}
                                {open.warnings.map((w) => <div key={w} className={s.warn}>⚠ {w}</div>)}
                            </>
                        )}
                        <div className={s.note}>保護單：虛擬 — 未送出任何委託（read_only={String(TSP_PERMISSIONS.read_only)}）。預估風險不是損失上限。</div>
                    </div>
                </div>
            )}
            {audit && res && <AuditDialog res={res} onClose={() => setAudit(false)} />}
        </>
    );
}

// ---- 審計視窗 ----

type AuditTab = 'events' | 'signals' | 'entries' | 'trades';

export function auditExport(res: TrendSignalResult) {
    return {
        version: res.version,
        configKey: res.configKey,
        symbol: res.symbol,
        contractMonth: res.contractMonth,
        asOf: wallTime(res.asOf),
        permissions: TSP_PERMISSIONS,
        dataSource: 'shioaji kbars 1m（20 個日曆日）＋ SSE 逐筆成交；只用已收 K 棒',
        signals: res.signals,
        entries: res.entries,
        trades: res.trades,
        events: res.events.map((e) => ({ ...e, at: wallTime(e.time) })),
    };
}

function AuditDialog({ res, onClose }: { res: TrendSignalResult; onClose: () => void }) {
    const [tab, setTab] = useState<AuditTab>('events');
    const [copied, setCopied] = useState('');
    useEscClose(onClose);
    const json = () => JSON.stringify(auditExport(res), null, 2);
    const copy = () => {
        void navigator.clipboard?.writeText(json()).then(() => setCopied('已複製'), () => setCopied('無法存取剪貼簿'));
    };
    const download = () => {
        const url = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `tsp-audit-${res.symbol}-${wallTime(res.asOf).replace(/[ :]/g, '')}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const tabs: [AuditTab, string][] = [['events', `事件 ${res.events.length}`], ['signals', `5m 訊號 ${res.signals.length}`], ['entries', `進場時機 ${res.entries.length}`], ['trades', `虛擬部位 ${res.trades.length}`]];
    return createPortal(
        <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.dialog}>
                <div className={s.header}>
                    <span className={s.headerTitle}>Trend Signal Pro 訊號審計 · {res.symbol}（{res.contractMonth}）</span>
                    <button className={s.btn} onClick={onClose}>關閉</button>
                </div>
                <div className={s.tabs}>
                    {tabs.map(([k, label]) => (
                        <button key={k} className={tab === k ? s.btnOn : s.btn} onClick={() => setTab(k)}>{label}</button>
                    ))}
                </div>
                <div className={s.tableWrap}>
                    <table className={s.table}>
                        {tab === 'events' && (
                            <>
                                <thead><tr><th>時間</th><th>類型</th><th>內容</th><th>ID</th></tr></thead>
                                <tbody>
                                    {[...res.events].reverse().map((e, i) => (
                                        <tr key={i}><td>{wallTime(e.time)}</td><td>{e.kind}</td><td>{e.text}</td><td>{e.ref}</td></tr>
                                    ))}
                                </tbody>
                            </>
                        )}
                        {tab === 'signals' && (
                            <>
                                <thead><tr><th>5m 收棒</th><th>訊號</th><th>收盤</th><th>趨勢線</th><th>EMA 註記</th><th>15m／60m（收棒）</th><th>ID</th></tr></thead>
                                <tbody>
                                    {[...res.signals].reverse().map((g) => (
                                        <tr key={g.id}>
                                            <td>{wallTime(g.barTime)}</td><td>{g.kind}</td><td>{g.close}</td><td>{num(g.line, 1)}</td><td>{g.notes.ema}</td>
                                            <td>{g.notes.m15}（{hm(g.notes.m15BarTime)}）／{g.notes.m60}（{hm(g.notes.m60BarTime)}）</td><td>{g.id}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </>
                        )}
                        {tab === 'entries' && (
                            <>
                                <thead><tr><th>訊號</th><th>模式</th><th>狀態</th><th>觸發</th><th>參考價</th><th>原因</th></tr></thead>
                                <tbody>
                                    {[...res.entries].reverse().map((e) => (
                                        <tr key={e.id}>
                                            <td>{e.signalId.split('|').slice(-2).join(' ')}</td><td>{MODE_TEXT[e.mode]}</td><td>{STATUS_TEXT[e.status]}</td>
                                            <td>{e.barTime !== null ? wallTime(e.barTime) : '—'}</td><td>{e.refPrice ?? '—'}</td><td>{e.reason}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </>
                        )}
                        {tab === 'trades' && (
                            <>
                                <thead><tr><th>成交</th><th>方向</th><th>口數</th><th>成交價</th><th>停損／R</th><th>出場</th><th>已實現（虛擬）</th></tr></thead>
                                <tbody>
                                    {[...res.trades].reverse().map((t) => (
                                        <tr key={t.id}>
                                            <td>{wallTime(t.fillTime - 60)}（{MODE_TEXT[t.entryMode]}）</td><td>{t.direction === 'LONG' ? '多' : '空'}</td><td>{t.qty}</td><td>{t.fillPrice}</td>
                                            <td>{t.plan.stop}／{t.plan.riskPoints} 點</td>
                                            <td>{t.fills.map((f) => `${exitText(f.reason)} ${f.qty}@${f.price}（${hm(f.time)}）`).join('；') || '持有中'}</td>
                                            <td>{t.realizedPoints} 點</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </>
                        )}
                    </table>
                </div>
                <div className={s.footer}>
                    <span>計算版本 {res.configKey} · 截至 {wallTime(res.asOf)} · 只用已收 K 棒</span>
                    <span className={s.spacer} />
                    {copied && <span>{copied}</span>}
                    <button className={s.btn} onClick={copy}>複製 JSON</button>
                    <button className={s.btn} onClick={download}>下載 JSON</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
