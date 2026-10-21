// scripts/tsp-demo/main.tsx — 一張 TMF K 線圖掛上 Trend Signal Pro（正式元件），資料為回放。
import '../../src/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import customSource from '../../docs/trend-signal-pro-custom.js?raw';
import { CandleChart } from '../../src/components/candle-chart';
import { CUSTOM_PALETTE, customType, sampleBars, saveCustom } from '../../src/lib/custom-indicators';
import { runCustom } from '../../src/lib/custom-runtime';
import { newInstance } from '../../src/lib/indicator-defs';
import { TSP_TYPE } from '../../src/lib/trend-signal/config';
import { initTheme, setThemeSettings } from '../../src/lib/theme-store';
import type { ContractInfo } from '../../src/lib/types/contract';

const params = new URLSearchParams(location.search);
// 回放時鐘：把「現在」固定在資料結尾附近，Dashboard 的時段與資料延遲才有意義
const replayAt = params.get('replayAt');
if (replayAt) {
    const fixed = Date.parse(`${replayAt}+08:00`);
    const start = Date.now();
    const real = Date.now.bind(Date);
    Date.now = () => fixed + (real() - start);
}
initTheme();
setThemeSettings({ mode: params.get('theme') === 'light' ? 'light' : 'dark' });
const inst = { ...newInstance(TSP_TYPE), id: 'tsp-demo' };
for (const [k, v] of params) if (k.startsWith('p.')) inst.params[k.slice(2)] = Number(v);
// ?builtin=supertrend：同時掛上既有的內建指標，對照畫法
const builtin = params.get('builtin');
const extra = builtin ? [{ ...newInstance(builtin), id: 'builtin-demo' }] : [];
// ?custom=1：另掛自訂指標版（docs/trend-signal-pro-custom.js），走編輯器「儲存」同一條註冊路徑；
// ?only=custom 只掛自訂指標版；c.<參數>=值 會定義成該自訂指標的參數（App 只傳參數表裡有的參數）
const only = params.get('only');
const customInst: ReturnType<typeof newInstance>[] = [];
if (params.get('custom') === '1' || only === 'custom') {
    const probe = runCustom(customSource, sampleBars(), {});
    const id = 'tsp-custom-demo';
    saveCustom({
        id,
        name: 'Trend Signal Pro（自訂指標版）',
        short: 'TSP',
        desc: '',
        category: 'overlay',
        params: [...params].filter(([k]) => k.startsWith('c.')).map(([k, v]) => ({ key: k.slice(2), label: k.slice(2), def: Number(v), min: -1e9, max: 1e9 })),
        outputs: probe.order.map((key, i) => ({
            key,
            label: key,
            kind: probe.hints[key]?.kind ?? 'line',
            color: probe.hints[key]?.color ?? CUSTOM_PALETTE[i % CUSTOM_PALETTE.length]!,
        })),
        source: customSource,
        updatedAt: Date.now(),
    });
    customInst.push({ ...newInstance(customType(id)), id: 'tsp-custom-demo-inst' });
}
const list = only === 'builtin' ? extra : only === 'custom' ? customInst : [inst, ...customInst, ...extra];
localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(list));
localStorage.setItem('sj-pro-tsp-ui-v1', JSON.stringify({ 'tsp-demo': { mini: params.get('mini') === '1' } }));
// ?tf=1m：載入後點主圖的週期按鈕（主圖預設 5m，週期不存設定）
const tfLabel = params.get('tf');
if (tfLabel) {
    const click = () => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === tfLabel);
        if (btn) btn.click();
        else setTimeout(click, 200);
    };
    setTimeout(click, 300);
}

const tmf = { code: 'TMFR1', target_code: 'TMFI6', name: '微型臺指 09月', symbol: 'TMFR1', security_type: 'FUT', exchange: 'TAIFEX',
    category: 'TMF', root: 'TMF', currency: 'TWD', tick: 1, multiplier: 10, delivery_month: '202609',
    reference: 0, limit_up: 0, limit_down: 0, day_trade: 'Yes', update_date: '2026/08/26' } as unknown as ContractInfo;

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <CandleChart contract={tmf} />
        </div>
    </StrictMode>,
);
