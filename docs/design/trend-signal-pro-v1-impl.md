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

### Gate 結果（V1.1）

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

未完成與待辦：

- 原生桌面 App 未實測（同 P5；需私有 repo 與本機 sidecar）。
- 進 main 前需依 DEV.md 跑一輪 AI review（`/code-review`）與 QA 驗收；本次只推送開發分支，未開 PR。
