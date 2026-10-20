// scripts/tsp-demo/main.tsx — 一張 TMF K 線圖掛上 Trend Signal Pro（正式元件），資料為回放。
import '../../src/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { CandleChart } from '../../src/components/candle-chart';
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
localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(params.get('only') === 'builtin' ? extra : [inst, ...extra]));
localStorage.setItem('sj-pro-tsp-ui-v1', JSON.stringify({ 'tsp-demo': { mini: params.get('mini') === '1' } }));

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
