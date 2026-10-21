// 無額外套件：沿用既有 Vite，把 Web 純核心與 App 輸入/輸出介面打包成單檔。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'docs/trend-signal-pro-custom.js');

export async function buildCustomSource() {
    const built = await build({
        root, configFile: false, logLevel: 'silent',
        build: {
            write: false, minify: false, target: 'es2020',
            lib: { entry: path.join(root, 'src/lib/trend-signal/custom-entry.ts'), formats: ['iife'], name: 'TspCustomIndicator' },
        },
    });
    const chunks = (Array.isArray(built) ? built : [built]).flatMap((r) => r.output).filter((o) => o.type === 'chunk');
    if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) throw new Error('自訂指標必須是無外部依賴的單檔');
    const version = fs.readFileSync(path.join(root, 'src/lib/trend-signal/chart-custom.ts'), 'utf8').match(/CHART_TSP_VERSION = '([^']+)'/)?.[1];
    if (!version) throw new Error('找不到計算版本');
    return `// Trend Signal Pro ${version} — Web/App 共用計算函式，官方 App 本圖週期自訂指標\n` +
        '// 由 npm run build:tsp-custom 產生；請修改 src/lib/trend-signal 的共用來源。\n' +
        '// 預設明訂微台：tick=1、每點10元、單邊手續費12元、單邊期交稅0.00002；不自動辨識商品或真實持倉。\n' +
        '// 依目前主圖週期重算；與原固定5m趨勢/1m觸發模型不同。chartTf=0自動推斷，必要時明訂分鐘數。\n' +
        '// 日K依App提供的日曆日OHLCV、下一根可用日K；沒有正式交易日曆，也不能還原棒內分鐘路徑。\n' +
        '// 輸出19條：趨勢/提示、初始/目前停損、保本、1R/2R/3R、虛擬進出場；全部為觀察與虛擬計算。\n' +
        '// 趨勢預設線，只顯示最後一段有效趨勢；目前停損請在App樣式手動選階梯線。\n' +
        '// 自訂API沒有文字箭頭或階梯預設；點的名稱/價格在圖例滑鼠提示查看，可於樣式啟用價格標籤。\n' +
        '// 不讀帳密、不連網、不送改撤單；沒有原生Feed的資料凍結、LIVE徽章或完整審計面板。\n' +
        '// 更新歷史/載入起點/參數變更仍會重算；與Web比對需相同資料、asOf、商品規格與完整設定。\n' + chunks[0].code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const source = await buildCustomSource();
    if (process.argv.includes('--check')) {
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== source) {
            console.error('自訂腳本落後共用核心；請執行 npm run build:tsp-custom');
            process.exitCode = 1;
        } else console.log('自訂腳本與共用核心一致');
    } else {
        fs.writeFileSync(target, source);
        console.log(`已產生 ${path.relative(root, target)} (${Buffer.byteLength(source)} bytes)`);
    }
}
