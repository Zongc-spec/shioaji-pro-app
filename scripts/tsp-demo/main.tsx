// scripts/tsp-demo/main.tsx — 隔離圖表回放；行情來源為 demo stub，不接 sidecar。
import '../../src/lib/polyfills';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import customSource from '../../docs/trend-signal-pro-custom.js?raw';
import { CandleChart } from '../../src/components/candle-chart';
import { CUSTOM_PALETTE, customType, sampleBars, saveCustom } from '../../src/lib/custom-indicators';
import { runCustom } from '../../src/lib/custom-runtime';
import { newInstance } from '../../src/lib/indicator-defs';
import { TSP_PARAMS, TSP_TYPE } from '../../src/lib/trend-signal/config';
import { initTheme, setThemeSettings } from '../../src/lib/theme-store';
import type { ContractInfo } from '../../src/lib/types/contract';
import { ChartAudit } from './chart-audit';

const params = new URLSearchParams(location.search);
// 回放時鐘：把「現在」固定在資料尾端附近，Dashboard 與本圖審計使用同一時鐘。
const replayAt = params.get('replayAt');
if (replayAt) {
    const fixed = Date.parse(`${replayAt}+08:00`);
    const start = Date.now();
    const real = Date.now.bind(Date);
    Date.now = () => fixed + (real() - start);
}
initTheme();
setThemeSettings({ mode: params.get('theme') === 'light' ? 'light' : 'dark' });

const numeric = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
};
const defaults = Object.fromEntries(TSP_PARAMS.map((def) => [def.key, def.def]));
const budgetOverride = numeric('budget');
const webParams = { ...defaults };
for (const [key, value] of params) if (key.startsWith('p.')) {
    const n = Number(value);
    if (Number.isFinite(n)) webParams[key.slice(2)] = n;
}
if (budgetOverride !== undefined && numeric('p.budget') === undefined) webParams.budget = budgetOverride;
// 和官方編輯器一樣，只宣告使用者有指定的參數。未宣告時由單檔採用本週期預設，
// 避免把1m微型預設明確送進5m，亦避免legend列出全部參數。
const customParams: Record<string, number> = {};
for (const def of TSP_PARAMS) {
    const value = numeric(`c.${def.key}`) ?? numeric(`p.${def.key}`) ??
        (def.key === 'budget' ? budgetOverride : undefined);
    if (value !== undefined) customParams[def.key] = value;
}
const customDefs = [...TSP_PARAMS,
    { key: 'riskHistory', label: '歷史風控', def: 0, min: 0, max: 1 },
    { key: 'chartTf', label: '主圖分鐘（0自動）', def: 0, min: 0, max: 1440 },
];
for (const key of ['riskHistory', 'chartTf']) {
    const value = numeric(`c.${key}`) ?? numeric(key);
    if (value !== undefined) customParams[key] = value;
}

const inst = { ...newInstance(TSP_TYPE), id: 'tsp-demo', params: { ...newInstance(TSP_TYPE).params, ...webParams } };
// ?builtin=supertrend：同時掛上既有的內建指標，對照畫法
const builtin = params.get('builtin');
const extra = builtin ? [{ ...newInstance(builtin), id: 'builtin-demo' }] : [];
// ?custom=1：另掛官方 App 自訂指標版；?only=custom 只掛自訂指標版。
const only = params.get('only');
const customInst: ReturnType<typeof newInstance>[] = [];
if (params.get('custom') === '1' || only === 'custom') {
    const probe = runCustom(customSource, sampleBars(), customParams);
    const id = 'tsp-custom-demo';
    const stopStep = numeric('stopStep') === 1;
    saveCustom({
        id,
        name: 'Trend Signal Pro（自訂指標版）',
        short: 'TSP',
        desc: '',
        category: 'overlay',
        params: customDefs.filter((def) => def.key in customParams).map((def) => ({ ...def, def: customParams[def.key]! })),
        outputs: probe.order.map((key, i) => ({
            key,
            label: key,
            kind: probe.hints[key]?.kind ?? 'line',
            color: probe.hints[key]?.color ?? CUSTOM_PALETTE[i % CUSTOM_PALETTE.length]!,
            ...(probe.hints[key]?.width ? { width: probe.hints[key].width } : {}),
            ...(stopStep && key === '目前停損' ? { plot: 'step' as const } : {}),
        })),
        source: customSource,
        updatedAt: Date.now(),
    });
    const saved = newInstance(customType(id));
    customInst.push({
        ...saved,
        id: 'tsp-custom-demo-inst',
        params: { ...saved.params, ...customParams },
        ...(numeric('labels') === 1 ? { showLabels: true } : {}),
        ...(stopStep ? { styles: { ...saved.styles, '目前停損': { ...saved.styles?.['目前停損'], plot: 'step' } } } : {}),
    });
}
const list = only === 'builtin' ? extra : only === 'custom' ? customInst : [inst, ...customInst, ...extra];
localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(list));
localStorage.setItem('sj-pro-tsp-ui-v1', JSON.stringify({ 'tsp-demo': { mini: params.get('mini') === '1' } }));

const timeframeMinutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '60m': 60, '1D': 1440 };
const requestedTf = params.get('tf');
const startingTf = requestedTf && requestedTf in timeframeMinutes ? requestedTf : '5m';
const chartAudit = params.get('chartAudit') === '1';
const auditParams = customParams;

// ?tf=5m：載入後點主圖週期按鈕；側欄也監聽同一工具列的切換。
if (requestedTf && requestedTf in timeframeMinutes) {
    const click = () => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === requestedTf);
        if (btn) btn.click();
        else setTimeout(click, 200);
    };
    setTimeout(click, 300);
}
// ?audit=trades（events／signals／entries）：開啟 TSP 審計視窗。
const auditTab = params.get('audit');
if (auditTab) {
    const TAB: Record<string, string> = { events: '事件', signals: '5m 訊號', entries: '1m 提示', trades: '虛擬部位' };
    const pick = () => {
        const tab = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith(TAB[auditTab] ?? auditTab));
        if (tab) tab.click();
        else setTimeout(pick, 200);
    };
    const open = () => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '審計' && !b.disabled);
        if (!btn) return void setTimeout(open, 300);
        btn.click();
        setTimeout(pick, 200);
    };
    setTimeout(open, 500);
}

const tmf = { code: 'TMFR1', target_code: 'TMFI6', name: '微型臺指 09月', symbol: 'TMFR1', security_type: 'FUT', exchange: 'TAIFEX',
    category: 'TMF', root: 'TMF', currency: 'TWD', tick: 1, multiplier: 10, delivery_month: '202609',
    reference: 0, limit_up: 0, limit_down: 0, day_trade: 'Yes', update_date: '2026/08/26' } as unknown as ContractInfo;

function Demo() {
    const [tf, setTf] = useState(startingTf);
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            const text = button?.textContent?.trim();
            const parentClass = String(button?.parentElement?.className ?? '');
            if (text && text in timeframeMinutes && parentClass.split(/\s+/).some((name) => name.includes('toolbar'))) setTf(text);
        };
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, []);

    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden' }}>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}><CandleChart contract={tmf} /></div>
            {chartAudit && <ChartAudit
                timeframe={tf}
                minutes={timeframeMinutes[tf] ?? 5}
                params={auditParams}
                source={customSource}
            />}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Demo /></StrictMode>);
