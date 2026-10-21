// scripts/tsp-demo/vite.config.ts — dev-only Trend Signal Pro 展示頁（畫面驗收與截圖，不需 sidecar）：
//   TSP_DEMO_DATA=<kbars JSON> pnpm exec vite --config scripts/tsp-demo/vite.config.ts --port 5298
// 開啟 /?theme=dark&replayAt=2026-08-26T23:59:40&mini=1（自訂指標版：&only=custom、1m 主圖：&tf=1m、
// 審計視窗：&audit=trades）。
// 主圖、指標與面板都是正式元件；
// 只有歷史來源、帳戶、行情 hook 與下單模組換成 stub — 畫面上任何操作都送不出委託。
// TSP_DEMO_DATA 未設定時用合成資料。資料檔不進 repo。Never part of a build.

import fs from 'node:fs';
import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = path.resolve(__dirname, '../..');
const src = (p: string) => path.resolve(root, 'src', p);
const stub = (p: string) => path.resolve(__dirname, 'stubs', p);
const REDIRECT: Record<string, string> = {
    [src('lib/chart-history.ts')]: stub('chart-history.ts'),
    [src('lib/trade.ts')]: stub('trade.ts'),
    [src('lib/account-store.ts')]: stub('account-store.ts'),
    [src('hooks/use-stream.ts')]: stub('use-stream.ts'),
};

function demoStubs(): Plugin {
    return {
        name: 'tsp-demo-stubs',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (!importer || importer.startsWith(path.resolve(__dirname, 'stubs'))) return null;
            const r = await this.resolve(source, importer, { ...options, skipSelf: true });
            return r && REDIRECT[r.id] ? REDIRECT[r.id] : null;
        },
        configureServer(server) {
            server.middlewares.use('/__tsp_demo_data.json', (_req, res) => {
                const file = process.env.TSP_DEMO_DATA;
                res.setHeader('Content-Type', 'application/json');
                res.end(file && fs.existsSync(file) ? fs.readFileSync(file) : 'null');
            });
        },
    };
}

export default defineConfig({
    root: __dirname,
    plugins: [demoStubs(), react(), vanillaExtractPlugin()],
    resolve: { alias: { '@modules': src('modules-stub/index.ts') } },
    define: {
        'process.env': {},
        __STATSIG_CLIENT_KEY__: JSON.stringify(''),
        __SHIOAJI_APP_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_BUILD_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_SERVER_VERSION__: JSON.stringify('demo'),
    },
    server: {
        host: '127.0.0.1',
        port: 5298,
        strictPort: true,
        fs: { allow: [root] },
        // Keep the visual fixture in-browser isolated from the app and sidecar.
        headers: { 'Content-Security-Policy': "connect-src 'self'" },
    },
});
