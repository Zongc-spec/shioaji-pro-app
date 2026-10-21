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

## tsp-1.1.2：Codex 接手第二輪修正（2026-10-21）

基線 `81b2b93`（程式 `a57ed65`）；Claude 配額中斷時原分支沒有未提交變更。實作在隔離工作樹
`fix/tsp-feed-confirmation` 進行，保留既有 TrendCore、EntryTiming、費率與唯讀權限。
本節描述此版的離線驗證與瀏覽器展示頁 QA，不代替使用者驗收、原生 App 實測或實際交易驗證。
上節 D23 中「心跳接收時間可以推進涵蓋」由本節取代；1.1.1 的原始紀錄保留。

### 修正與回歸

| 問題 | 本版處理 | 可檢查證據 |
|---|---|---|
| P1 隱藏／不顯示指標的週期停用逐筆 listener，重新啟用仍沿用舊涵蓋 | listener cleanup 呼叫 `LiveFeed.pause()`，撤銷逐筆涵蓋；保留 frozen，漏收區間等歷史補抓 | `use-trend-signal.test.tsx` 同 code／epoch、同 revision 舊快取重啟反例；`feed.test.ts` 暫停後的新 tick 不能跨缺口，補抓後資料可恢復 |
| P1 延遲心跳用本機收到時間，提前凍結尚在佇列的成交 | 心跳只用於串流連線健康，不推進資料 asOf；連續接收的交易所成交時間或伺服器歷史才確認 | 10:00:30 心跳於 10:01:15 到達，10:00:50 tick 仍可入；core 與真正 React hook 的回歸 |
| 較舊 patch／full 回應反向完成，payload 倒退但沿用較新水位 | `setHistory()` 拒絕涵蓋時間落後的回應 | `feed.test.ts` 新 full 後接舊 patch，10:01 不會被刪掉並永久凍結 |
| 舊商品的 patch finally 釋放新商品的鎖；historyVer 重算又誤取消有效 patch | 寫入與 finally 都驗 request identity；停用／換商品撤銷 record，同接收週期的重算保留有效補抓 | hook 測試與獨立 deferred request 反例；A 晚完成不能令 B 重複補抓 |
| 移除心跳推進後，安靜市場卡在午休／週末的非交易分鐘 | 只用 now 掃描下一個到期的正規分鐘來排補抓，不推進 asOf | `feed.test.ts` 日盤轉夜盤、週五夜盤轉週一日盤 |
| 已初始化 A 切 B，當輪 effect 仍有舊 historyVer，新 feed 從 −Infinity 掃描 | snapshot 未初始化守門、hook 非有限 asOf 守門 | core 與 hook 切商品測試 |
| 多口分批重複取整進場稅 | 按累計已平口數分配進場稅，分配總和等於整筆口數的取整稅額 | 兩口回歸原成本 68、應為 67；修正後進場稅分配 5＋4＝9；不改單口結果 |

安靜市場在分鐘結束 45 秒後才排補抓，兩次至少相隔 15 秒；補抓失敗繼續等待，不承諾最長確認時間。
此版沒有引入新的 broker／行情服務或持久化架構。

### 驗證結果

- 修正前：`./node_modules/.bin/vitest run src/lib/trend-signal/core/feed.test.ts --maxWorkers=2 -t '延遲心跳|較舊歷史'`
  exit 1，兩項反例都失敗；修正後同指令 exit 0。hook 停用重啟、舊請求 finally 及多口成本也先紅後綠。
- `./node_modules/.bin/vitest run src/lib/trend-signal/core/feed.test.ts --maxWorkers=2`：exit 0，14 tests。
- `npm exec -- vitest run src/hooks/use-trend-signal.test.tsx --maxWorkers=2`：exit 0，6 tests。
- `./node_modules/.bin/vitest run src/lib/trend-signal/risk/risk.test.ts --maxWorkers=2`：exit 0，27 tests。
- `./node_modules/.bin/vitest run --maxWorkers=2`：exit 0；235 files passed／1 skipped、3684 tests passed／2 skipped。
- `./node_modules/.bin/tsc -b`、`npm run build`：exit 0。build 仍有既有 target／dynamic-import 警告，未改其它交易模組。
- 獨立 `trading_auditor` 以 `node --input-type=commonjs` 的記憶體白名單 loader 執行六類 feed、48 個 LONG／SHORT 部分與全部平倉成本、
  兩個 hook 生命週期反例，共 56 例，各命令 exit 0；最終 finder review 沒有未解阻擋。
- 工程相容性：固定合成 1m、三種核心 × 三種 EntryTiming、單口，與未變動的 `81b2b93` 原工作樹輸出比較，
  除計算版本與 ID 外逐欄相同（`node` 記憶體檢查 exit 0）。首次使用 Node 子程序呼叫 git 的方案遇 `spawnSync git EPERM`／exit 1，
  改為直接唯讀載入原工作樹，沒有放寬權限或修改基線。這不是新的市場研究。

獨立審查所核對的實作 SHA-256：feed `489ec769345b8039a411777c11b47b420358aca04035131a64a688b41ba1ad41`；
hook `ec95c6fe5282ffdcfcbeda268a457f66b81422c0a746a1418d02606401297d75`；
virtual `f1c091e87fa18644f7cee4711019f61e1f485fbb69ec413362b16d84b0b02f71`。

### 畫面與剩餘界線

展示頁明確綁定 loopback、strictPort 與 `Content-Security-Policy: connect-src 'self'`；歷史、帳戶、下單由既有 stub 隔離。
5298 被占用時沒有接管，改用 5299；HTTP 首頁與合成 endpoint 為 200，沒有指定外部行情檔。
一般 sandbox 的 Vite 啟動 EPERM、Windows Chrome 的 WSL vsock 啟動錯誤均保留；在本次已授權 QA 的 tool escalation 後，
Windows Chrome headless 使用 `/tmp` 的獨立 UNC profile 成功，exit 0，實際寫出 312,003 bytes。
新截圖：[1.1.2 審計，合成資料](../images/trend-signal-pro-audit-1.1.2.png)，SHA-256
`fc47d6d9ff136c1315aa48ef9d5f3441dfdc9e5357c45ec6506a43f9dad5a9cc`。
已實際檢視成本欄、合計、成交開盤／觸價區間與 `tsp-1.1.2` 版本；畫面中的獲利是合成示例，不是績效證據。
Chrome 對 UNC profile 的 cache／DB 有警告；自建 server 與 profile 均已清理，既有服務未接管。

原生桌面 App、真實 SSE／網路延遲、券商帳單取整尚未實測；審計分頁互動沒有做瀏覽器自動斷言。
原有兩年 Gate 5 與實際資料回放仍保留為 `tsp-1.1.1` 的歷史結果，本輪沒有重跑或宣稱為 `1.1.2` 的新績效。
自訂指標的缺乏凍結／5m 主圖完整性限制維持已揭露範圍；P4 沒有啟用。

## 2026-10-21：Web／App 共用核心與自訂風控（tsp-1.1.3）

使用者授權保留 Web 完整審計介面與官方 App 自訂指標，共用計算核心，先補齊 App 風控再做對照。本輪完成程式、離線對照與 Web 合成回放畫面；**官方 App 內貼上／儲存／載入仍待人工驗證，不能稱原生驗收完成**。

- 新增 `custom-adapter.ts`：僅處理 App 的 1m OHLCV 輸入、收棒時點、微台模型規格驗證與圖上輸出；趨勢、進場、風控、費稅均呼叫現有 `runTrendSignal`／`risk/plan`／`risk/virtual`。`custom-entry.ts` 透過公開 `bars/p/plot` 介面輸出。
- `npm run build:tsp-custom` 沿用 Vite 打包成一個無外部 import 的 JS（71,384 bytes），取代舊版手寫複製的自訂演算法。`npm test`／`npm run build` 先執行產物新鮮度查核；不同步會失敗。
- 19 條輸出：原7種趨勢/提示；初始停損、目前停損、保本、1R/2R/3R；虛擬多空進場、保護停損、2R、3R、反轉/失效出場。使用成交所屬1m label定位，停損依 stopHistory 生效，分批出場分欄避免覆蓋。
- 視覺查核發現歷史風控價位堆疊，改為預設僅顯示目前 OPEN 部位六條風控，空手清除、歷史成交點保留；`riskHistory=1` 可查歷史，該參數不影響核心計算。圓點不跨空手期間接線。
- 獨審發現既有虛擬進場會在下一分鐘缺棒時延後到下一根現存棒成交。修正為取消與 WARN，計算版升 `tsp-1.1.3`，避免與舊ID混用。跨盤取消仍保留。
- 固定微台模型預設 tick1、每點10元、單邊手續費12元、稅率0.00002、滑價1tick/邊；不自動識別主圖商品或實際持倉。只支援1m主圖；規格/資料非法會報錯。

### 驗證與失敗紀錄

- `npm run build:tsp-custom` exit0；`npm test -- --maxWorkers=2 src/lib/trend-signal/custom-adapter.test.ts src/lib/trend-signal/custom-script.test.ts src/lib/trend-signal/risk/risk.test.ts src/lib/trend-signal/safety.test.ts src/components/trend-signal-panel.test.ts` 初版122 passed、exit0。
- 真正單檔經 App `runCustom` 執行器，三核心×三進場模式與直接 Web 引擎的19序列比對；單檔測試22 passed、exit0。另有手刻停損/成交反例，不只比較同一投影函式。
- 完整測試第一次 exit1：3734 passed、1 failed、2 skipped。失敗是既有 `flash-order-link.test.tsx` 的 CDFJ6 固定最後交易日恰為今日，實際時鐘過13:30後 mock確認流程被到期守門拒絕，guard未建立。僅將此測試 beforeEach 固定到期前日期、afterEach 還原 Date，未改送單實作；定向77 passed、exit0。
- 最終 `npm test -- --maxWorkers=2`：236檔 passed／1檔 skipped，**3736 passed／2 skipped**，exit0（49.93s）。`npm run build`（產物查核、`tsc -b`、`vite build`）exit0；保留既有target／dynamic-import警告。詳細stdout在 `/tmp/tsp-shared-risk-full-tests-final.log`、`/tmp/tsp-shared-risk-build-final.log`。
- 獨立 `trading_auditor` 使用自行產生的1800棒、3核心×4進場模式：202筆虛擬交易／491筆出場，19輸出與獨立時間/stopHistory oracle一致；84個盤中prefix驗無回填。另驗缺下一分鐘取消、正常/跨盤/live、同棒停損優先與3口完整費稅，exit0。初次300棒沒有成交，不當風控證據，改用非零成交資料；顯示模式補審14情境／28次新版單檔執行，exit0。探針只在記憶體執行，沒有實際券商或原生App驗收。
- Web目視使用隔離demo／合成資料，同一回放時點2026-08-27 02:00，截圖 `images/trend-signal-pro-custom-risk-1.1.3.png` 與 `images/trend-signal-pro-custom-risk-1.1.3-web.png`，1600×1200。模型有OPEN虛擬多單，右側審計與圖上價位可對照；畫面行情未連線，數字不代表實績。QA自建Vite/Chrome已清理。

### 交付與限制

單檔 SHA256 `0a19cdfdb255a2551b27694d6183bb558459c135be098f2d1906b685e350b0f2`，已逐byte同步到 `C:\Users\zongc\shioaji-pro-app\docs\trend-signal-pro-custom.js`，舊檔備份與回條在 `/home/zongc/tw-futures-codex/.local/tsp-custom-delivery/`；程式碼已複製到Windows剪貼簿。未變更Windows checkout的其他檔案。

原生UI輔助腳本以 `powershell.exe -NoProfile -NonInteractive -STA -File` 載入WSL UNC路徑時，被Windows未簽章／RemoteSigned規則拒絕（exit1）。沒有改執行原則或操作App；改提供官方App內標準貼上／驗證／儲存流程。建立時選微台、1m、全盤、主圖疊加，預期偵測19輸出；請使用新名稱保留既有指標。

沒有讀取券商憑證、重新登入、啟停正式App/sidecar、送改撤單或啟用自動交易。App沒有Web Feed的已確認資料凍結，歷史修訂、載入起點、僅日盤與收棒時點不同都可能造成差異。已持倉遇缺分鐘的觸價未知仍保留；這輪未重跑真實兩年Gate5，不改寫舊比較結果。Web審計與完整App UI/真實行情驗收範圍分開。

## 2026-10-21：App 本圖週期模式（tsp-chart-1.2.0）與第三輪審查（Claude 接手）

Codex 在 1.2.0 進行到「完整測試與新畫面驗收」時配額中斷，改動沒有 commit。Claude 把當時的工作樹逐位元組複製到
`review/tsp-custom-mtf`（Codex 原 worktree 與分支未動），確認完整測試、`tsc -b`、build 都過，再做一輪 AI review（`/code-review` high）並修正。

### 1.2.0 本圖週期模式（使用者要求）

使用者 2026-10-21 16:55 的要求：「1. 不管任何時態都要能使用這個指標。2. 進出點以及風控都要清楚標示。3. 趨勢線要以線呈現，
如果結合移動停損就呈現階梯線並且標示。」Codex 提出「各週期重新計算」後，使用者回「繼續」。

> 下一節（tsp-app-1.3.0）依使用者澄清取代本小節「1m 主圖也以 1m 為主趨勢」與高週期進出場的做法；本小節保留作紀錄。

- App 單檔改由 `chart-custom.ts` 產生：1m／5m／15m／60m／1D 都用主圖自己的 OHLCV 重算趨勢、提示與虛擬風控（`trendTrack`、
  `computeEntries`、`risk/virtual` 與 Web 共用），1m 主圖也以 1m 為主趨勢。這是**另一個模型**（ID 與 `tsp-chart-1.2.0` 分開），
  不是原 5m 趨勢＋1m 觸發的縮放；Web 原生面板仍是原模型，兩年 Gate 5 只適用原模型。
- 原模型在 App 的對照路徑仍是 `custom-adapter.ts` 的 `computeCustomTsp`（1.1.3 單檔即此模型），由測試對照 Web；1.2.0 的安裝步驟要求新建
  指標、保留舊版，兩個模型可以並存。不另加切換參數：兩者共用一組輸出樣式時，原模型的歷史趨勢線會在宿主跨空值連線。
- 驗證：`custom-script.test.ts` 用 App 執行器跑產物，5 個週期 × 3 個核心 × 3 種進場模式，19 條輸出與獨立建立的預期逐根相同；
  `chart-custom.test.ts` 涵蓋週期推斷、session 歸屬、日K日終、未來 OHLC 不參與、live 只做保護停損等反例。

### 第三輪審查發現與處理

| # | 等級 | 發現 | 處理 |
|---|---|---|---|
| F1 | P1 | 補抓固定只抓 `dateStrOffset(1)..(0)`：指標隱藏或斷線超過一天（例：週五 13:00 隱藏、週一 09:00 顯示），中間整段兩份歷史都沒有，涵蓋水位卻推進到現在，被當成「沒有成交」凍結 | 補抓從第一個待補分鐘的前一天起（最多回推 20 天）。hook 回歸：修正前起點是 10-22，應為 10-20 |
| F2 | P1 | SSE 沒斷但中間漏收成交（上游斷線、訂閱被丟；`stream.ts` 註明每日維護會在 SSE 不斷線時丟掉訂閱）：之後一筆成交就讓缺口內與兩端的殘缺分鐘被確認並凍結；45 秒補抓只對完全沒有後續成交的分鐘有效 | 逐筆帶 `total_volume`，上一筆累計＋本筆量對不上就從這筆重新起算，缺口兩端的分鐘等歷史。feed 回歸附對照（沒有累計量時 10:03 以殘缺 K 棒確認）；整天模擬加一段靜默漏收，最後與完整資料逐根相同 |
| R1 | P1 | 產物 `--check` 逐位元組比對，Windows checkout（core.autocrlf，`desktop-agent-build.yml` 的 windows 矩陣跑 `pnpm build`／`pnpm test`）必定失敗 | 比對前把 CRLF 正規化；LF、CRLF 兩種檔案都驗證通過 |
| R2 | P1 | 接收起點用本機時鐘：本機慢時，開始接收前的分鐘被當成已收到 | 起點取第一筆成交的交易所時間；回歸：本機慢 30 秒時 10:01 不確認 |
| R3 | P2 | 補抓回空陣列也推進涵蓋水位（非 patch 時還清空歷史） | 空回應不推進、不覆寫 |
| R4 | P2 | 每次補抓用新 revision 寫入共用快取（上限 100、FIFO），安靜時段約 100 分鐘就擠掉主圖與 20 天歷史 | 補抓改用 `fetchChartHistoryFresh`：不進共用快取；150 次補抓後 20 天快取仍命中 |
| R5 | — | App 單檔換成本圖模式，1m 主圖不再與 Web 一致 | 使用者要求的設計，保留；說明見上節 |
| R6 | — | 下一根 1m 缺 K 棒時取消進場，連確定沒有成交的分鐘也取消 | 保留：引擎只拿到 K 棒，分不出沒有成交與資料遺失，依完整性原則取消（只影響下一分鐘沒有成交的進場，多在冷清夜盤） |
| R7 | P3 | 週期以時間間距 gcd 推斷，極稀疏資料可能誤判 | 未改：一根以下不產生訊號；已有 `chartTf` 參數可明訂 |
| R8 | P3 | 展示頁本圖審計的出場原因代碼對不上（`TRAIL`／`BREAKEVEN`） | 改用共用 `exitText`。同項另指日K錯一天，查證 `aggregate()` 日K 是日曆日開端，與 App 相同，不成立 |
| R9 | P3 | 日K模式 FILL／STOP_MOVE 文字只有時分 | 改用帶日期的時鐘文字（原模型輸出不變） |
| R10 | P3 | 週期文字用正則改寫、留下不用的心跳參數、`TfMinutes` 放寬為 number | 移除 `observe` 的心跳參數；`buildTf`／`holeBefore` 收窄為 `NativeTf`；正則只改完整的 1m／5m 字樣且不用 lookbehind（舊版 WKWebView 不支援）。共用文字的週期參數化列為後續 |

另修：伺服器歷史已涵蓋的分鐘再收到成交時，原本會併進歷史最後一根而重複計量，改為以歷史為準並計入晚到筆數；Dashboard 顯示累計量接不上的次數。

### 驗證

- 修正前反例：F1 的 hook 測試在舊起點下失敗（10-22 ≠ 10-20）；F2 的對照組證明沒有連續性檢查時殘缺 K 棒會被確認；R2、R3、R4 各有測試。
- `npm test`：237 files passed／1 skipped、3814 tests passed／2 skipped；`npm run build`（產物查核、`tsc -b`、`vite build`）exit 0。
- 真實 TMF 即時路徑回放（3 演算法 × 2 期間 × 885 次重算，逐筆帶累計量）：0 不一致，比對事件數不變；每段補抓由 2 次增為 6 次
  （開始接收與重連後跨在起點上的分鐘，量測報告結果 5）。

### 尚未驗證與限制

- 官方 App 內貼上、儲存、載入 1.2.0 單檔尚未實測；原生桌面 App 的 Web 面板未實測；P4 未授權。
- 每次重新起算後，跨在接收起點上的那一分鐘要多等一次補抓（約 10–20 秒）。累計量檢查依賴 SSE `total_volume`。
- 共用的提示、風控文字仍以 1m／5m 命名，本圖模式靠正則改寫，只影響展示頁審計文字（App 只畫線與點）。

## 2026-10-21：App 單檔依原意分派週期（tsp-app-1.3.0）

使用者澄清：「原意是 5 分 K 是主趨勢並判斷進出場，1 分 K 是精準進出場」，1.2.0 讓 1m 主圖以 1m 為主趨勢與原意不同。
App 自訂指標只拿得到主圖本身的 OHLCV，依此分派（`app-custom.ts`；`custom-entry.ts` 改呼叫 `computeAppCustomTsp`）：

| 主圖 | 計算 | 說明 |
|---|---|---|
| 1m | 原模型：`runTrendSignal`（由 1m 聚合 5m 主趨勢、1m 精準提示、1m 虛擬風控） | 與 Web 逐值相同；趨勢線只畫最後一段連續 5m 趨勢 |
| 5m | `chart-custom.ts` 的 5m 主趨勢；只有 IMMEDIATE 建立虛擬部位 | BUY／SELL 與 1m 主圖同一組；下一根 5m 開盤＝下一根 1m 開盤，成交時刻與價格相同；停損擺動點與 ATR 以 5m 近似；需要 1m 的進場模式不畫部位 |
| 15m／60m／1D | 只畫該週期趨勢線（高週期輔助） | 拿不到 5m 主趨勢，不另算訊號與部位（原規格：15m／60m 只做輔助） |

- 19 條輸出改回 1.1.3 的名稱（`1m 微型提示`、`1m 結構提示`），已建立 1.1.3 指標的可直接貼上新程式碼更新；5m 與高週期的提示列為空。
- `runChartSignal` 新增 `risk` 選項（預設開，既有本圖引擎測試不變）；趨勢線「只畫最後一段」抽成 `keepLastChartSegment`，1m 原模型另用 5m 分段。
- 上節第三輪審查 R5（1m 主圖與 Web 不一致）由此解決：1m 主圖重新與 Web 逐值相同。
- 驗證（`custom-script.test.ts`，App 執行器跑產物）：1m 主圖三核心 × 三進場模式 19 條輸出與 Web 逐值相同，訊號、提示、成交價、初始停損另做獨立核對；
  5m 主圖 BUY／SELL／失效與 1m 主圖相同、三核心第一筆 IMMEDIATE 進場的開盤時刻與成交價相同、需要 1m 的模式不畫部位；15m／60m／日K 只有趨勢線。
- 展示頁 `chartAudit=1` 改用同一個分派並顯示計算方式；順手修正它的結果型別收窄（原本 `tsc` 單獨檢查有 6 個錯誤）。

## 2026-10-21：風控優化與 5m 主圖三進場模式（tsp-1.2.0、tsp-app-1.4.0）

使用者要求：「5m 主圖也要有3 種趨勢演算法 × 3 種進場模式。另外風控也要優化」。

### 風控（tsp-1.2.0）

- 先加風控模型候選（commit `5c8ddf4`，預設不變）並在看結果前寫定採用規則（量測報告結果 7）：模型 1（初始停損依提示當下已收的 5m
  擺動點與 5m ATR）樣本內、外各 7/9 組每筆較好 → 通過；模型 2（不保本、進場即移動停損）兩段都較差 → 不通過，已移除。
- 補充量測顯示模型 1 的好處依賴預算：規格預算 NT$1,000 下樣本外 35–53% 的提示 1 口就超過預算被拒絕，留下的部位只有 1/9 組每筆較好。
  改預設是規格 §2 的預設值變更，交由使用者決定。使用者看過 1 口風險分佈（樣本外中位 NT$766–1,094、P90 NT$1,822–3,280）後回覆
  「2000～2500是可接受的」。
- 實作：`RiskConfig.stopTf`（5 預設／1 原規則；參數 `stopTf`，step 4 只接受 1 或 5）、預算預設 NT$2,500、`TSP_ALGO_VERSION` → `tsp-1.2.0`。
  `virtual.ts` 以 `lastAtOrBefore(m5.bars, 提示時間)` 取 5m（收盤 label，只會拿到已收的桶）；回歸測試改動提示之後同桶的 1m，初始停損不變。
  面板的初始停損依據顯示週期（`5m ATR`）。規格 §2 已加註本次決定。
- Web 舊實例：`newInstance` 會存下全部參數，舊實例的預算是明確存下的 1,000，直接改預設會變成「5m 停損＋NT$1,000」這組量測較差的組合。
  `upgradeTspParams` 在 `loadInstances` 與 `newInstance`（「存為我的預設」）處理沒有 `stopTf` 的舊參數：補 `stopTf=5`，預算仍是 1,000 的升到 2,500，
  改過的保留；補上後不再升級。App 自訂指標只送使用者宣告的參數，宣告過 `budget=1000` 的要自行修改（使用說明已註明）。
- 新預設與舊預設（1m 停損＋NT$1,000）比較：樣本內、外各 7/9 組每筆較好、9 組合計虧損少 41–46%；1m 主圖 18 格仍全部為負（結果 7.6）。
- 測試調整：`risk.test.ts` 既有情境測的是成交與出場機制，明確固定 `stopTf: 1, budget: 1000`，新預設另有測試；`custom-adapter` 的未收棒因果測試只有
  8 根 5m（ATR14 未暖身）改用 `stopTf: 1`；面板警示去重測試原本假設最後一個事件可提醒，5m 停損持倉較久、最後是移動停損事件，改取最後一個可提醒的事件。

### 5m 主圖三進場模式（tsp-app-1.4.0）

- 5m 主圖對 IMMEDIATE、MICRO_TREND、PRICE_STRUCTURE（及先前策略假說）都建立虛擬部位並畫提示；提示與停損都以 5m K 棒計算。
  IMMEDIATE 與 1m 主圖同一根成交、同價、同一個初始停損與 R（兩者現在都依已收 5m）。
- 5m 主圖的微型趨勢與主趨勢在同一組 K 棒上：沿用 1m 預設會完全相同、永遠不提示。未宣告時用 `M5_MICRO_DEFAULTS`
  （`microStMult=1`、`microDcLength=5`、`microKamaHyst=0.05`），只依提示頻率在樣本內選（結果 7.3）；都在測試範圍最靈敏的一端，
  頻率仍只有 1m 主圖的 14–65%。宣告了就照用。
- 提示輸出改名為 `微型提示`、`結構提示`（5m 主圖上是 5m 提示）。App 存檔時依輸出名稱保留樣式，貼上更新後這兩條回到預設樣式；
  `chart-custom.ts` 的「本圖」名稱一併移除。
- 驗證（`custom-script.test.ts`，App 執行器跑產物）：5m 主圖三核心 × 三進場模式都有部位，每筆在提示的下一根 5m 開盤以開盤價 ± 1 tick 成交，
  圖上提示點等於提示事件；三核心第一筆 IMMEDIATE 的成交時刻、價格、初始停損、R、保本價與 1m 主圖相同；未宣告微型參數時有微型提示，
  宣告成與主趨勢相同的值時沒有。

### 驗證與限制

- `npm test`：237 files passed／1 skipped、3802 tests passed／2 skipped；`tsc -b` 通過；自訂單檔已重建且 `--check` 一致。
- 研究腳本改用 `stopTf` 後重跑：與 `5c8ddf4` 共同的 108 格（含預算 NT$1,000）逐欄相同；模型 2 只能在 `5c8ddf4` 重現。
- 尚未驗證：官方 App 內貼上、儲存、載入 1.4.0 單檔；dev App 未更新到本分支（先前啟動展示伺服器的權限被拒，未繞過）；P4 未授權。
- 5m 停損的 1 口風險約是 1m 的 2 倍；TMF 樣本外有 3–17% 的提示 1 口就超過 NT$2,500 而被拒絕。所有組合成本後仍為負，量測不支持任何交易優勢。
