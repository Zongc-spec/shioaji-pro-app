# Trend Signal Pro V1.0／V1.1 — 實作紀錄與 Gate

規格：[trend-signal-pro-v1.md](trend-signal-pro-v1.md)；V1.1 優先規格：
[trend-signal-pro-v1-1-core-correction.md](trend-signal-pro-v1-1-core-correction.md)（覆蓋前者 §1.1／§1.2）。
本文件記錄 P0 基線、實作前定案的設計決策，以及各階段 Gate 的實際結果；V1.1 見文末。

## P0 — 基線（2026-10-20）

| 項目 | 結果 |
|---|---|
| Repo / 分支 | `Zongc-spec/shioaji-pro-app`，`codex/trend-signal-pro-v1`（已推送，與 origin 同步） |
| 基線 SHA | `6efd14057731491215046e5d63821f0a2d412231` |
| 工作樹 | 乾淨，無 stash，無其他 worktree |
| 工具鏈 | Node v22.22.0；pnpm 10.34.7（`--frozen-lockfile`，與 CI 相同） |
| `npm test` | 224 files passed / 1 skipped；3450 tests passed / 2 skipped |
| `npm run build` | 通過（`tsc -b` + `vite build`；既有 BigInt / dynamic import 警告） |
| 桌面層 | 本 repo 沒有 `modules/`、`src-tauri/`（私有 repo）；只能 build Web 版 |

### 規格 §5 整合點核對

| 規格敘述 | 程式現況 |
|---|---|
| 主圖 1m/5m/15m/60m、lightweight-charts | `src/components/candle-chart.tsx:153` TIMEFRAMES；v5.2.0 |
| 1m → N 分 aggregation | `src/lib/utils/kbars.ts:40`，close-label-right（`Math.ceil`，:49） |
| 圖表保留 raw 1m | `candle-chart.tsx:479` `rawRef`；即時 tick 只更新目前週期的最後一根，不更新 raw 1m |
| 已有 SuperTrend / EMA / ATR / KD 純函式 | `src/lib/indicators.ts:260` / `:28` / `:226` / `:353`，皆為因果（只往前算） |
| 內建 VWAP 依日曆日重設 | `src/lib/indicators.ts:109` `Math.floor(b.time / 86400)` — 夜盤跨午夜會被切斷，不能當「當盤 VWAP」 |
| 交易時段 | `src/lib/intraday-session.ts:21` 期/選日盤 08:45–13:45、夜盤 15:00–05:00；`CLOSE_GRACE` :42 |
| 指標註冊 | `src/lib/indicator-defs.ts:64` `compute(bars, p)` 只拿到目前週期的 K 棒 |
| 每點價值 | `src/lib/utils/contract-cost.ts:8-9` MXF 50、TMF 10；未知商品退回 50（:33） |
| 即時成交 | `src/lib/stream.ts:915` `onAnyTick` 逐筆（含連續月別名）；:23 `StreamStatus` |
| 既有 trailing / bracket | `src/lib/conditional/trailing.ts:33`、`src/lib/trigger-engine.ts:125` |

## 設計決策

**D1 單一 canonical 1m 來源。** Trend Signal Pro 自己載入固定 10 天的 1m 歷史
（`fetchChartHistory`，與 5m 圖同一個快取鍵，不重抓），再以 `onAnyTick` 逐筆組即時
1m。結果與圖表目前週期無關，切 1m/5m/15m/60m 不會改變任何訊號。

**D2 已收棒規則。** 1m K 棒以收盤分鐘為 label。`asOf = max(最後一筆 tick 的交易所時間,
本機牆鐘 − 10 秒)`；label ≤ asOf 才算已收。N 分 K 的 label ≤ asOf，或該時段已收盤
（加 `CLOSE_GRACE`）才算已收。進行中的 K 棒不參與任何指標或訊號。

**D3 aggregation 與主圖相同。** 5m/15m/60m 直接用 `aggregate()`，K 棒時間與主圖一致，
Dashboard 數值可以和切到該週期的主圖互相對照。

**D4 指標重用既有純函式。** SuperTrend、EMA、ATR、KD 用 `indicators.ts`。VWAP 另寫
依交易時段（日盤／夜盤）重設的版本。

**D5 暖身。** 指標資料不足或尚在收斂時輸出 UNKNOWN。UNKNOWN → LONG/SHORT 不產生
BUY/SELL，避免資料起點造成假訊號。

**D6 候選有效期。** BUY/SELL 後「接下來 3 根完整 5m」，用交易時段內的預期 5m 桶計算
（日盤收盤延續到夜盤開盤；跨週末、假日沒有資料，等同逾期）。

**D7 進場節流。** 同一時間只有一筆虛擬部位；每個 5m 候選最多一次接受進場。

**D8 虛擬成交模型（P3，只顯示，不送單）。** 進場：觸發 K 棒的下一根 1m 開盤 ± 滑價。
停損：觸及即出（進行中 K 棒也算），跳空以開盤價成交 ± 滑價。停利：限價、只在已收 K 棒判定；
同一根同時觸及停損與目標時，停損優先。5m 反轉：下一根 1m 開盤出場，不自動反手。

**D9 每點價值嚴格取得。** 先用 API 的 `contract.multiplier`，再用已知根代碼
（TMF 10、MXF 50、TXF 200）。都沒有就拒絕產生風控計畫，不沿用「預設 50」。

**D10 沒有下單路徑。** `src/lib/trend-signal/` 與 TSP 的 UI 元件不 import
`trade` / `shioaji` / `trigger-engine` / `bracket` / `execution`。這條邊界由
安全測試（掃描 import）保護。警示通知由 `candle-chart` 注入 callback。

**D11 原生指標整合。** 在 `INDICATOR_DEFS` 註冊 `trend-signal-pro`，沿用選單、設定、
樣式、時框顯示與 legend。`compute` 多一個選填的 context，舊指標不受影響。箭頭用
`createSeriesMarkers`。R 線另建 series，不加在 K 棒 series 的 price line 上，
避免和可拖曳的委託線混在一起。

**D12 模式。** 觀察（預設）、模擬警示（只發 App 通知）。模擬交易（P4）與正式交易
在 UI 顯示為停用；`read_only = true`、`auto_entry = false`、`auto_exit = false`
是常數。

## 2026-10-20 方向調整（P1 途中）

使用者釐清目標：Trend Signal Pro 是**獨立趨勢指標**（功能對齊 Universal Indicator Ultimate AI 的公開描述），
不是把規格 §1.1／§1.2 的交易策略假說包裝成指標。處理：

- P1 草稿完整保存為 `d05e7e9`，不刪除；盤點與分類見 [重設計提案](trend-signal-pro-v1-redesign.md) §2。
- EMA9／VWAP／KD Trigger 停止擴充，保留為可選模式。
- 以真實 TMF 資料量測候選演算法與 1m 進場時機：[量測報告](../research/trend-signal-algorithms-2026-10.md)。
- 使用者確認後（同日）：核心 SuperTrend 可切換 Donchian／KAMA；1m Trigger 為 IMMEDIATE（基準）、
  MICRO_TREND、PRICE_STRUCTURE；EMA21 改註記。設計決策修正：D1 視窗 10 天 → 20 天；D5 暖身改為
  依演算法的固定根數（實測）；D6 候選窗口不跨盤別，歸 Entry Trigger 模組；D7、D8 歸風控模組。

既有測試觀察（不穩定測試，與本功能無關）：完整 `npm test` 偶發 1 個失敗，出現過兩個測試：
`candle-chart-order.test.tsx`「refuses a pending chart order at dispatch after switch back changes」（1 次）與
`subscription-dispatch.test.ts`「sends a subscription request when the mode stays current for
/api/v1/stream/unsubscribe/scanner」（多次）。證據：

- 在改動前的基線 `6efd140`（暫時 worktree）完整執行 5 次，後者失敗 3 次 → 既有問題。
- 兩者單獨執行各 5 次全過。
- 後者使用 `vi.resetModules()` ＋ 動態 import ＋ 預設 1 秒的 `vi.waitFor`，屬負載下的計時敏感測試。

不在本功能範圍內修改；回報 CI 結果時需重跑確認。

## 驗收（P5）

| 項目 | 結果 |
|---|---|
| 單元／整合測試 | `npm test`：232 files passed／1 skipped；3586 tests passed／2 skipped（新增 136 個） |
| 型別檢查與建置 | `npm run build`（`tsc -b` + `vite build`）通過 |
| 真實資料回放 | 3 演算法 × 2 期間 × 886 步，0 不一致（量測報告結果 5） |
| 起點不變性 | 373 個起點，暖身後方向與線值一致（量測報告結果 3） |
| 交易安全 | 靜態測試：TSP 程式（含 UI）不 import 任何下單模組；整合測試全程未呼叫下單／刪單／改價 |
| 畫面 | `scripts/tsp-demo` 回放展示頁（正式元件、stub 掉歷史／帳戶／下單）以 Windows Chrome headless 截圖；
  截圖過程發現並修正趨勢線翻轉連線（`b9e1c21`）。截圖：[docs/images/trend-signal-pro-demo.png](../images/trend-signal-pro-demo.png)（合成資料） |
| 原生 App | **未實測**：本 repo 沒有桌面層（私有 repo），本機也沒有啟動中的 Shioaji server；未登入任何帳號 |

發現的既有問題（改動前即存在，本次未改行為）：

- 內建「SuperTrend 超級趨勢」指標的多空兩線在翻轉處互相連線：lightweight-charts v5 的折線不因 whitespace
  斷開，`indicators.ts` 註解「with whitespace gaps so the inactive side isn't drawn」的假設不成立。
  可沿用 `trend-signal/project.ts` 的 `splitTrendLines()` 修正。
- `candle-chart-order.test.tsx`、`subscription-dispatch.test.ts` 各有一個負載下的計時敏感測試（見上節）。

## Gate 狀態

| 階段 | 狀態 | 證據 |
|---|---|---|
| P0 基線 | 完成 | 本文件 P0 節；`bee79e8` |
| P1 Signal engine / MTF | 完成 | `e2762fc`：core／trend／trigger；A1–A10、必驗案例 1、2、4、5、6 |
| P2 UI / Dashboard | 完成 | `6f0b6b3`、`b9e1c21`：指標選單、趨勢線、標記、Dashboard、虛擬風控面板、審計、1m 小圖 |
| P3 Risk planner（虛擬） | 完成 | `e2762fc`：risk/plan、risk/virtual；R 面板在 P2 |
| P4 模擬交易 adapter | **未授權，不實作** | — |
| P5 Acceptance | 完成（原生 App 實測除外） | 上節 |

## V1.1 核心修正（2026-10-21）

使用者推送 V1.1 優先規格（`fbedfd1`，合併於 `07bcb2c`）。程式：`e3178db`；計算版本 `tsp-1.1.0`。

### Gate 0 — 既有成果盤點與遷移

| 既有成果 | 處理 |
|---|---|
| core（已收棒、週期聚合、時段、即時 1m） | 保留；`TfSeries` 加每根的時段收盤，新增 `tfBucket`／`freshAt`（過期判定） |
| trend（SuperTrend／Donchian／KAMA） | 狀態改四態；Donchian 改為 V1.1 的候選 C；SuperTrend、KAMA 演算法不變 |
| trigger 的 15 分鐘窗口（舊規格 §1.2 的「候選有效期」） | 降為可選 post-flip window（`hintWindow`，預設 0＝整段趨勢） |
| MICRO_TREND 一律用 1m SuperTrend | 改用與 5m 同一演算法家族，參數獨立 |
| PULLBACK_KD（EMA9／VWAP／KD，舊策略假說） | 保留為第三套可選 plugin，名稱「先前策略假說／未驗證」，只在風控選用時計算（預設 OFF） |
| EMA21 斜率（舊規格 §1.1） | V1.0 重設計時已改為註記，不變 |
| risk（計畫、虛擬部位）、UI（Dashboard、R 面板、審計、1m 小圖、標記）、安全測試 | 保留並擴充（見下） |

遷移：計算版本升為 `tsp-1.1.0`（舊 ID 不混淆）；語義改變的參數換鍵名（`windowBars`→`hintWindow`、
`microMult`→`microStMult`），V1.0 已存實例的 15 分鐘窗口與 1m 倍數 1 不沿用。遷移驗證：V1.1 程式以 V1.0 窗口重跑
結果 4，SuperTrend 核心逐欄相同（量測報告結果 4 末段）。

### V1.1 設計決策

**D13 TrendCore 四態。** LONG／SHORT／NEUTRAL／UNKNOWN。BUY＝已收 5m 由 SHORT／NEUTRAL 進入 LONG，SELL 鏡像；每次
切換一個不可變事件。規格寫「非 LONG→LONG」；前一根 UNKNOWN（暖身）時不知道之前的狀態，不算切換，否則暖身結束與
資料起點不同都會產生假訊號、同一根 K 棒的訊號 ID 也會隨視窗起點改變（D5 的延續）。

**D14 候選 C＝Donchian 突破＋ATR 追蹤帶。** 收盤突破前 n 根最高（最低）價進入 LONG（SHORT）；追蹤帶＝近 n 根（含當根）
最高價 − k × ATR14 的棘輪，收盤跌破即 NEUTRAL（失效事件，不是 SELL），再突破才有新訊號。暖身 dcLength + 120（實測）。

**D15 過期（MtfContext）。** 時點 t 已知的最後一根 tf K 棒若不是前一個桶（換盤後尚未收第一根、資料缺洞），該週期為
stale。Dashboard 標「過期」；5m 過期時 1m 不提示。15m／60m 只註記，不否決 5m。

**D16 提示範圍。** 一段 5m 趨勢從訊號收棒後開始，到 5m 離開該方向為止（每根 1m 看 label ≤ 它的最後一根已收 5m）；
可選 post-flip N 根 5m（不超過該盤收盤）。每盤最後一根 1m 不提示（下一根開盤已是下一盤）。提示產生即定案，ID 帶觸發
1m 時間，`seq` 為本段第幾次。

**D17 MICRO_TREND 同家族。** 1m 用 5m 的演算法，只換該演算法的靈敏度參數（SuperTrend 倍數、Donchian 週期、KAMA 遲滯），
其餘沿用趨勢設定；1m 由反向或中性轉回同向即提示。預設倍數 3（V1.0 為 1）：整段趨勢範圍下倍數 1 每段約 12.6 次提示
（量測報告結果 6 §3b）。

**D18 PRICE_STRUCTURE 多次提示。** 提示後要有新的、形成於提示之後的已確認回檔轉折，才可能再提示。

**D19 風控。** 5m 失效與反向同樣在下一根 1m 開盤平倉（候選 C 的追蹤帶就是規格 §3 的「ATR 出場帶」）。持倉或待成交時
略過提示（不加碼），停損出場後下一次提示可再進場；成交 K 棒是否跨盤以提示所在盤判斷（整段趨勢會延續到下一盤）。
期交稅：契約價值 × 稅率，元以下四捨五入（股價指數類 0.00002），計入成本、保本價與已實現損益。

**D20 UI 語義。** 主圖 `5m BUY／SELL`＝主趨勢切換、`5m 失效`、`ENTRY 模式代號 HH:MM`＝1m 執行候選（換到 5m 以上主圖仍
保留原始 1m 時間）。Dashboard 顯示演算法參數與版本、各週期最後已收 K 棒時間與過期、各模式本段提示次數與最近一次。

### Gate 結果（V1.1 第一版，`933d165`；已撤回）

> 2026-10-21 使用者審查 `933d165` 後退回：下表的「完成」判定過早（四個問題，兩個 P1）。以文末「V1.1 審查退回與修正」的
> Gate 狀態為準；下表保留原文作為紀錄。

| Gate | 狀態 | 證據 |
|---|---|---|
| Gate 0 盤點／遷移 | 完成 | 上節；遷移驗證 |
| Gate 1 TrendCore | 完成 | `trend.test.ts`：三個候選的 A1 不偷看、A3 一次切換一個事件、A4、A5 棘輪、A7 起點不變、A10 參考實作（C 以 `donchian()`／`atr()` 建的狀態機逐根對照）；`engine.test.ts`：重算相同 ID、資料缺洞、歷史回補（補齊後與一次完整計算 `toEqual`）、隔夜／午休；`core.test.ts`：過期判定；真實資料回放 0 不一致、起點不變性（量測報告結果 3、5） |
| Gate 2 EntryTiming | 完成 | `trigger.test.ts`：整段範圍、post-flip、反向／失效停止、過期、每盤最後一根、多次提示與 `seq`、未確認轉折不觸發、空單鏡像、舊假說只在選用時計算；`engine.test.ts` Gate 2：三個核心的每個提示當時 5m 同向且未過期、不在該盤最後一根 |
| Gate 3 UI | 完成（原生 App 未實測） | `candle-chart-tsp.test.tsx`：指標選單、標記、切換 1m/5m/15m/60m 標記數不變、隱藏、組合商品；`trend-signal-panel.test.ts`：警示去重（重開不重播）、審計含演算法與參數；展示頁截圖（SuperTrend、Donchian＋ATR） |
| Gate 4 RiskPlanner | 完成 | `risk.test.ts`：期交稅、失效平倉、持倉略過與停損後再進場、以提示所在盤判斷跨盤；`safety.test.ts`：TSP 程式不 import 任何下單模組 |
| Gate 5 公平比較 | 完成（不指定最佳） | 量測報告結果 6：同資料、同成本、樣本內／外、日夜盤、月份型態；三個核心的 SAR 每筆 |t| < 2，沒有可分辨的成本後優勢；無法直接比較原版 |
| P4 模擬委託連動 | **未授權，不實作** | — |

測試：`npm test` 232 files passed／1 skipped、3633 tests passed／2 skipped；`tsc -b`、`vite build` 通過。

### V1.1 補充：桌面版自訂指標版（2026-10-21）

官方桌面版（v0.1.54，與本分支的基線同版）有「自訂指標」：使用者在 App 內貼 JavaScript，執行器
（`src/lib/custom-runtime.ts`）只給目前主圖週期的 OHLCV 陣列與參數表裡定義的參數，只能用 `plot()` 輸出數值序列（線／虛線／
柱狀／圓點）與 `hline()`。

**D21 單檔自訂指標版。** [`docs/trend-signal-pro-custom.js`](../trend-signal-pro-custom.js) 把三個 TrendCore、已收棒判定
（台灣牆鐘 − 10 秒，含收盤定盤寬限）、1m→5m 聚合與投影、1m 微型趨勢、PRICE_STRUCTURE、提示範圍規則照抄成單一檔案（不用
`ta.*`，避免與原生 ATR 起算方式不同）。全部以圓點輸出：自訂指標沒有箭頭與文字，且折線會在翻轉處互連。沒有 Dashboard、虛擬
風控、審計與通知。驗證：`src/lib/trend-signal/custom-script.test.ts` 以 App 的自訂指標執行器跑這個檔案，與 `runTrendSignal`
逐根比對（5m、1m 主圖；三個核心；post-flip、非預設參數；進行中的 K 棒），10 個測試通過；真實 TMF 1m 6.8 萬根每次 30–41 ms。
回放展示頁 `&only=custom` 走編輯器「儲存」同一條註冊路徑畫出（截圖 `docs/images/trend-signal-pro-custom-1m.png`）。

未完成與待辦：

- 原生桌面 App 未實測（同 P5；需私有 repo 與本機 sidecar）。自訂指標版也還沒有在桌面 App 內實際貼上驗證。
- 進 main 前需依 DEV.md 跑一輪 AI review（`/code-review`）與 QA 驗收；本次只推送開發分支，未開 PR。

## V1.1 審查退回與修正（2026-10-21，`tsp-1.1.1`）

使用者審查 `933d165` 後退回：「驗收完成」的結論太早。上方 V1.1 Gate 表的「完成」撤回，以本節為準。程式修正：`a57ed65`；
計算版本升為 `tsp-1.1.1`（訊號 ID 帶版本，舊 ID 不混淆）。

### 審查發現與根因

| # | 等級 | 問題 | 根因（`933d165`） | 修正 |
|---|---|---|---|---|
| 1 | P1 | 資料不完整仍產生訊號：10:26–10:30 的 5m 只有一根 1m，仍產生 BUY、進場提示與虛擬進場計畫 | `core/bars.ts:75–78` 只用時間判定最後一個桶已收（label ≤ asOf 或該盤已收盤），不檢查桶內分鐘是否齊全；asOf 由牆鐘推進（D2），缺分鐘的桶照樣成為已收 5m | D22 |
| 2 | P1 | 已確認的歷史訊號會改變：02:40 收棒後，同分鐘晚到的成交只改 10 點，就在原本沒有訊號的位置新增 SELL | `core/live.ts:25` `mergeTick` 只拒收比最後一根更早的分鐘；最後一根即使已被 asOf（牆鐘 − 10 秒）確認，同分鐘的晚到成交仍會改寫它，重算時歷史事件跟著變。既有回放只推進 asOf、不經過即時資料路徑，所以沒有測到 | D23 |
| 3 | P2 | 審計時間不一致：同一筆虛擬成交，事件表 22:51、部位表 22:50 | 事件表的 FILL 記在成交 1m 的收盤 label（`risk/virtual.ts:262` `log(t, 'FILL', …)`），部位表顯示 `fillTime − 60`（開盤，`trend-signal-panel.tsx:478`），出場欄又用收盤 label | D24 |
| 4 | P2 | 審計只顯示成本前點數 | 部位表只有 `realizedPoints`（`trend-signal-panel.tsx:481`），引擎已算的手續費、期交稅與成本後損益沒有顯示 | D25 |

### 設計決策（tsp-1.1.1）

**D22 資料完整性。** 5m 桶內每個正規交易分鐘（`isRegularMinute`：期貨日盤 08:46–13:45、夜盤 15:01–05:00，不含收盤定盤寬限與
週末）都要有 1m。`buildTf` 記下每根缺幾分鐘，`completeOnly` 排除缺分鐘的 5m 並列出 `gaps`：排除的 5m 不參與 TrendCore，不產生
訊號或失效，審計記一筆 `DATA` 事件，Dashboard 顯示 30 分鐘內的缺口。1m 所屬的 5m 桶在它之前已缺分鐘時（`holeBefore`，只看
之前的分鐘，因果）不提示；缺口之後到下一根完整的 5m 收盤前，5m 依 D15 過期，也不提示。15m／60m 是輔助週期、不否決 5m，
只標「缺資料」，不排除。缺分鐘也可能是那一分鐘真的沒有成交，程式無法分辨，一律排除（TMF 兩年 0.62% 的 5m，量測報告結果 6 §0）。

**D23 即時資料以資料進度確認並凍結（`core/feed.ts` 的 `LiveFeed`，取代 D2 的牆鐘 asOf）。**

- 伺服器歷史涵蓋到「原始請求時間 − 10 秒」；共用快取命中時也用原始請求時間（`fetchChartHistoryStamped`）。
- 即時成交只在同一條行情連線（stream epoch）內累積涵蓋：從連上那一刻起，到最後一筆成交時間或最後一次心跳 − 10 秒。
- 歷史之後的每個正規分鐘都要被涵蓋才算已收。連線前的分鐘、或連線起點落在其中的分鐘，逐筆永遠涵蓋不到，收完 10 秒就列為
  `pendingFrom`（徽章「資料補齊中」）並自動補抓近兩天歷史（兩次補抓至少間隔 15 秒）；同一次連線內的分鐘則等一次心跳週期
  （`HEARTBEAT_WAIT_SEC` 45 秒，伺服器約每 30 秒一次心跳），仍沒有成交或心跳涵蓋才當成串流可能卡住、改抓歷史。
  重連（epoch 改變）重新起算涵蓋。
- 每次計算後 `commit(asOf)` 凍結 ≤ asOf 的分鐘：之後同分鐘的晚到成交拒收並計數（`lateTicks`），補抓或「更新歷史」也不改寫
  已凍結的分鐘。
- 進行中的 K 棒只在它是目前這一分鐘、而且前面沒有待補分鐘時才傳給風控（停損觸價），斷線期間殘留的半根 K 棒不會被當成即時價。

**D24 審計時間慣例。** 審計時間一律是事件實際發生的時刻。開盤成交（進場、5m 反向／失效平倉、停損跳空）記成交 1m 的開始
（label − 60），顯示「HH:MM 開盤」；盤中觸價（停損、停利）記該 1m 的 label，顯示「HH:MM–HH:MM 盤中」。`TradeFill.at`
（`open`／`intrabar`）與 `VirtualTrade.fillAt` 記錄這個區分；JSON 的 K 棒時間仍是收盤 label，匯出的 `timeConvention` 有說明。

**D25 成本後損益。** 部位表逐筆列點數（含滑價）、手續費＋期交稅（`costNtd`）、成本後損益（`realizedNtd` ＝ 點數 × 每點價值 −
成本），上方是已平倉合計（`tradeSummary`）；JSON 匯出 `summary`。

**D21 修訂（自訂指標版）。** 已收判定改為依資料：最後一根要等下一根 K 棒出現，或該盤收盤（含定盤寬限）再過 10 秒才算收完，
取代 D21 的「牆鐘 − 10 秒」。1m 主圖同步 D22（缺分鐘的 5m 排除、桶內缺口之後不提示）；5m 主圖看不到桶內分鐘，不做這項檢查。
自訂指標每次重算都從頭來，沒有 D23 的凍結。`custom-script.test.ts` 12 個測試（新增兩個缺口案例）與原生逐根相同。

### 證據

| # | 重現（修正前的行為） | 修正後 |
|---|---|---|
| 1 | `engine.test.ts`「P1 回歸：資料不完整的 5m 不產生任何事件」前提：2026-09-02 13:10 的桶只留 13:06，不過濾時 5m 在 13:10 翻成 SELL。「5m 桶內缺 1m 之後的 1m 不提示」前提：2026-09-03 缺 12:28，不略過時 12:29 仍有 MICRO_TREND 提示，而且完整資料下這個提示會成交 | 13:10 排除並記 `DATA`，沒有訊號、提示或部位；12:29 不提示，沒有虛擬進場；缺口前的事件不變。`core.test.ts`（正規分鐘、缺分鐘計數、`holeBefore`）、`trigger.test.ts`（桶內缺口）、`custom-script.test.ts`（兩個缺口案例與原生逐根相同） |
| 2 | `core/feed.test.ts`「對照」：那根 1m 收盤 −10 點時，5m 02:40 確實翻成 SELL（舊行為把晚到成交併進已收 K 棒） | 心跳確認 02:40 之後到的同分鐘成交被拒收並計數，訊號不變；確認前到的照常併入；斷線重連後等補抓涵蓋，結果與完整資料相同；補抓不改寫已確認分鐘；只有心跳的安靜市場照常確認，等下一次心跳期間不誤報「資料補齊中」（同一次連線內超過 45 秒才補抓）；共用快取的舊歷史要等補抓；模擬一整天（8% 晚到成交、一次斷線、每分鐘重算）已確認事件不變 |
| 3 | — | `risk.test.ts`「審計時間」：FILL 時間＝`fillAt`（「09:40 開盤」）、停損「09:41–09:42 盤中」、反向平倉「09:45 開盤」；`trend-signal-panel.test.ts`：`fillAt = fillTime − 60`、每筆 fill 有 `at` |
| 4 | — | `trend-signal-panel.test.ts`「審計部位合計」：成本後＝點數 × 每點價值 − 成本，成本＝各筆 `costNtd` 合計；匯出含 `summary`、`timeConvention`、`dataGaps` |

真實 TMF 資料（量測報告結果 5、6；`tsp-1.1.1` 重跑）：

- 逐步回放（asOf 每 3 分鐘前進）：3 演算法 × 2 期間 × 886 步，0 不一致；2025-12 期間有 3 根缺分鐘的 5m 被排除。
- 即時資料路徑（審查指出的缺口）：真實 1m 產生逐筆成交，經 `LiveFeed` 加上心跳、約 8% 分鐘的晚到成交、一次斷線與補抓，
  每 3 分鐘重算：3 × 2 × 885 次，每段拒收 169 筆晚到成交、補抓 2 次，已確認的訊號、失效、提示與成交 0 不一致。
- Gate 5 與進場模式量測依新規則重跑：數字小幅變動（例：A SAR 樣本內每筆 +25 → +29 元），讀法與結論不變。

### Gate 狀態（tsp-1.1.1，取代上方 V1.1 Gate 表）

| Gate | 狀態 | 證據／未完成 |
|---|---|---|
| Gate 0 盤點／遷移 | 完成 | 版本升為 `tsp-1.1.1`；遷移驗證見量測報告結果 4 末段 |
| Gate 1 TrendCore | 程式與測試完成，待使用者驗收 | V1.1 Gate 1 證據＋D22／D23 與上表 #1、#2；真實資料兩種回放 0 不一致 |
| Gate 2 EntryTiming | 程式與測試完成，待使用者驗收 | V1.1 Gate 2 證據＋桶內缺口之後不提示 |
| Gate 3 UI | 程式與測試完成，原生 App 未實測 | 徽章（資料補齊中、確認延遲）、缺資料標示、缺口警告、晚到成交筆數、審計時間與成本欄。`docs/images` 的展示頁截圖是修正前的畫面（審計欄位與徽章不同），這次沒有重拍 |
| Gate 4 RiskPlanner | 程式與測試完成，待使用者驗收 | D24、D25 與上表 #3、#4 |
| Gate 5 公平比較 | 完成（不指定最佳） | 依 tsp-1.1.1 重跑，結論不變；仍無法直接比較原版 |
| P4 模擬委託連動 | **未授權，不實作** | — |

### 已知限制（tsp-1.1.1）

- 嚴格完整性：冷清分鐘沒有成交也會讓整根 5m 排除（多在夜盤 02:00–05:00），該段訊號延後或不出現；TrendCore 直接接上下一根
  完整的 5m（缺口兩側視為相鄰），是近似。
- 15m／60m 缺分鐘只標示，不排除。
- 凍結的是當時收到的資料：重開 App 會以伺服器歷史重新計算，結果可能與當時畫面不同。
- 確認延遲：一分鐘結束後沒有新成交時，要等下一次心跳（約 30 秒一次）再加 10 秒緩衝。
- 心跳時刻是本機收到的時間（`stream.ts` 的 `Date.now()`），成交是交易所時間：本機時鐘比交易所快超過約 10 秒時，沒有成交的
  分鐘可能提早確認，之後才到的同分鐘成交會被拒收（計入晚到成交）。已出現的訊號不會被改寫，但那根 1m 會少算這幾筆。
- 整根 5m 都沒有 1m 時不記 `DATA` 事件（例如上游資料整段截斷）；這段期間 5m 過期，不提示。
- 補抓後才確認的事件沒有「補算」標記。
- 自訂指標版沒有凍結；放在 5m 主圖時看不到桶內分鐘，不做完整性檢查（只有 1m 主圖會排除缺分鐘的 5m）。
- 原生桌面 App 未實測（同 P5）；P4 未授權。

測試：`npm test` 234 files passed／1 skipped、3671 tests passed／2 skipped；`tsc -b`、`vite build` 通過。展示頁的審計視窗與徽章
沒有在瀏覽器實際截圖核對（本次啟動展示頁伺服器的權限被拒）；新增展示頁參數 `&audit=trades` 可直接打開審計的虛擬部位分頁。
進 main 前仍需依 DEV.md 跑 AI review（`/code-review`）與 QA 驗收。
