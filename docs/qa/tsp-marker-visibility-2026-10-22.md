# TSP 進出場與風控標示驗證

本次來源：`/home/zongc/tw-futures-codex/.local/tsp-marker-visibility`，分支 `fix/tsp-marker-visibility`，基底 `0ad0633`。
由 Luna 定位正確的 `tsp-app-1.4.0` 專案；未沿用舊工作樹或覆寫 `tsp-feed-fix` 的未提交變更。

## 可檢查成果

- 自訂 `plot` 增加逐根對齊的 Buy/Sell metadata。三角形繪在 K 棒上／下方及圖表頂層，同棒及附近事件分列；文字區分進場與各種虛擬出場原因。多單出場 Sell、空單回補 Buy。
- 六項目前部位風控以虛線為預設，目前停損使用階梯虛線；價格軸標籤啟用時可顯示風控名稱。維持原本19個輸出名稱、數值、時間與交易計算。
- 已產生 `docs/trend-signal-pro-custom.js`；與共用來源一致。舊版 `plot` 能忽略額外 metadata，三角形仍需包含新 renderer 的前端建置。
- [1m 合成回放](../images/tsp-marker-visibility-1m.png)、[5m 合成回放](../images/tsp-marker-visibility-5m.png)。這是 Chrome 執行正式圖表元件搭配既有 demo stubs 的截圖，沒有使用帳戶或真實交易回報。

預覽以 `node_modules/.bin/vite --config scripts/tsp-demo/vite.config.ts --host 127.0.0.1 --port 5306` 啟動，exit 狀態為持續運行。
可在同一台 Windows 電腦開啟：
`http://localhost:5306/?only=custom&tf=1m&replayAt=2026-08-25T20:50:00&labels=1`。
使用內建合成行情與原有預設參數；未連 sidecar。預覽程式、工作樹保留，沒有取代原生 App。

## 驗證命令與退出碼

| 命令 | 結果 |
|---|---|
| `npm run build:tsp-custom` | exit 0，單檔產生成功 |
| `node_modules/.bin/tsc -b` | exit 0 |
| `node_modules/.bin/vitest run src` | exit 0，242 files passed／1 skipped；3,817 tests passed／2 skipped |
| `node_modules/.bin/vitest run src/lib/chart-trade-markers.test.ts src/components/candle-chart-custom-markers.test.tsx src/lib/custom-runtime-markers.test.ts src/lib/trend-signal/app-markers.test.ts src/lib/trend-signal/custom-script.test.ts` | 最後畫面調整後 exit 0，5 files／46 tests passed |
| `npm run build` | 最後畫面調整後 exit 0（含來源同步、`tsc -b`、Vite build）；保留既有 BigInt target、chunk size 與 dynamic import 警告 |
| `git diff --check` | exit 0 |

完整 `npm test` 首次 exit 1：當時3,815 tests passed／2 skipped，但既有
`docs/research/trend-signal-algorithms-2026-10/roll-tail.test.mjs` 使用 `node:test`，被 Vitest 當測試收集後回報 `No test suite found`。
`git diff --exit-code 0ad0633 -- docs/research/trend-signal-algorithms-2026-10/roll-tail.test.mjs` exit 0，該檔本輪未變更；
`node --test docs/research/trend-signal-algorithms-2026-10/roll-tail.test.mjs` exit 0。沒有為此改動研究程式或測試設定，不能把 `npm test` 宣稱為全綠。

新增檢查涵蓋：無效／錯位 marker 拒絕、空值與未來資料不產生標記、1m／5m 多空進出場方向與價位時間對應、舊 plot 相容、
實際 runtime → IndicatorPoint → 圖表 primitive、隱藏指標／單輸出、切換週期與卸載清理、三角形頂點及文字的 canvas 繪製、近距文字分列。
初次新增測試有型別註記與誤收其他圖表 primitive 的測試碼錯誤，修正後以上驗證通過。

獨立 Luna `Code Reviewer` 自行檢查完整呼叫鏈、新增元件測試與兩張實際截圖，最後無阻擋發現；不是作者自審。
其提出的 `riskHistory` 樣式切換限制經 base 核對屬既有行為，維持並記錄如下。

## 尚未完成與既有限制

- 本機官方 Shioaji Pro 為0.1.55，App PID11120、sidecar PID11280（127.0.0.1:21322）；本次只唯讀查核，未替換／啟停／登入／操作正式服務。沒有新原生安裝檔，也未完成原生 marker 驗收。
- 貼入單檔不能使尚未支援 markers 的已安裝 App 出現三角形；完整新繪法需更新前端。虛線已有舊 API 支援，但編輯舊指標仍會保留既有樣式，需將六項風控選為虛線，或新建指標。
- `riskHistory=1` 仍以歷史圓點避免跨部位接假線；參數切換不會自動修改使用者已存的輸出樣式。切至1需手動改六項風控為圓點，回0需切回線／目前停損階梯線。
- 未改風險預算、訊號、成交、停損計算；未重跑策略研究或把合成回放稱為績效證據。
- 未 push、merge 或發布；來源與可試用預覽留在隔離分支。

## 接手驗證（Claude，2026-10-22）

Codex 配額中斷後，把上述未提交內容以 `git apply --3way` 搬到乾淨 worktree，基底為 `cec405d`＋`c262f7a`（回放時序與圖表高度修正；少了它，demo 預覽的 K 棒與指標資料對不上、圖上看不到任何 TSP 線）。不含其後 5 個研究 commit；新增檔案逐位元組核對相同，`npm run build:tsp-custom` 產生的單檔與 Codex 工作樹逐位元組相同。

| 命令 | 結果 |
|---|---|
| `node_modules/.bin/tsc -b` | exit 0 |
| `node_modules/.bin/vitest run src` | 242 files passed／1 skipped；3,817 tests passed／2 skipped |
| `npm run build` | exit 0（含單檔查核、`tsc -b`、Vite build） |
| `git diff --check` | exit 0 |

`npm test`／`vitest run` 不是每次全綠：連跑多次，會隨機有 1 個與本次無關的測試失敗
（`subscription-dispatch`、`odd-spread`、`candle-chart-order` 輪流出現，單獨執行皆通過）。
未含本次變更的 `cec405d` 連跑 4 次也出現同樣的隨機失敗，所以是既有的時序不穩，不是 marker 變更造成；本次沒有修它。

使用者實測指出 5m 主趨勢切換（BUY/SELL）也畫成「Buy／Sell 趨勢」三角形，與需求「進出場改三角形」不符；已改回圓點，三角形只用在虛擬進出場。

預覽 `replayAt=2026-08-27T02:00:00` 的 1m 截圖核對：多方趨勢線為實線，目前停損為階梯虛線並隨移動停損上移，其餘風控為虛線。

仍未驗證：官方 App（0.1.55）內的實際顯示。三角形需要含本分支前端的 dev App；只貼新單檔仍畫圓點。
