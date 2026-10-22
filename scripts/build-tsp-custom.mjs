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
    const version = fs.readFileSync(path.join(root, 'src/lib/trend-signal/app-custom.ts'), 'utf8').match(/APP_TSP_VERSION = '([^']+)'/)?.[1];
    if (!version) throw new Error('找不到計算版本');
    return `// Trend Signal Pro ${version} — Web/App 共用計算函式，官方 App 自訂指標\n` +
        '// 由 npm run build:tsp-custom 產生；請修改 src/lib/trend-signal 的共用來源。\n' +
        '// 5m 是主趨勢並判斷進出場，1m 是精準進出場；App 只給主圖本身的 K 棒，所以依主圖週期：\n' +
        '//   1m 主圖：原模型（由 1m 聚合 5m 主趨勢、1m 精準提示、虛擬風控），與 Web 逐根相同。\n' +
        '//   5m 主圖：5m 主趨勢＋三種進場模式與虛擬風控，全部用 5m K 棒（提示看不到 5 分鐘內的回檔）。\n' +
        '// 初始停損預設依 5m 擺動點與 5m ATR（stopTf=5；1＝1m 原規則），每筆風險預算預設 NT$2,500。\n' +
        '//   15m／60m／日K：只畫該週期趨勢線作高週期輔助，不產生訊號、進出場與風控。\n' +
        '// 預設明訂微台：tick=1、每點10元、單邊手續費12元、單邊期交稅0.00002；不自動辨識商品或真實持倉。\n' +
        '// 輸出19條：趨勢/提示、初始/目前停損、保本、1R/2R/3R、虛擬進出場；全部為觀察與虛擬計算。\n' +
        '// 趨勢線只顯示最後一段有效趨勢；目前風控為虛線，目前停損為階梯虛線。\n' +
        '// 三角形與 Buy/Sell 文字需要支援 plot markers 的 App；舊 App 會忽略 markers，仍畫圓點。\n' +
        '// 舊指標已保存的樣式優先：請將六項風控輸出改為虛線、目前停損選階梯線，或新建指標。\n' +
        '// 不讀帳密、不連網、不送改撤單；沒有原生Feed的資料凍結、LIVE徽章或完整審計面板。\n' +
        '// 更新歷史/載入起點/參數變更仍會重算；與Web比對需相同資料、asOf、商品規格與完整設定。\n' + chunks[0].code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const source = await buildCustomSource();
    if (process.argv.includes('--check')) {
        // Windows checkout（core.autocrlf）會把產物換成 CRLF：只比對內容，不比對換行字元
        const onDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
        if (onDisk !== source) {
            console.error('自訂腳本落後共用核心；請執行 npm run build:tsp-custom');
            process.exitCode = 1;
        } else console.log('自訂腳本與共用核心一致');
    } else {
        fs.writeFileSync(target, source);
        console.log(`已產生 ${path.relative(root, target)} (${Buffer.byteLength(source)} bytes)`);
    }
}
