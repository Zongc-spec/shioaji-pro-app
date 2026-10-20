# Trend Signal Pro V1.0 — 實作紀錄與 Gate

規格：[trend-signal-pro-v1.md](trend-signal-pro-v1.md)。本文件記錄 P0 基線、
實作前定案的設計決策，以及各階段 Gate 的實際結果。

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

## Gate 狀態

| 階段 | 狀態 | 證據 |
|---|---|---|
| P0 基線 | 完成 | 本節 |
| P1 Signal engine / MTF | 進行中 | — |
| P2 UI / Dashboard | 未開始 | — |
| P3 Risk planner（虛擬） | 未開始 | — |
| P4 模擬交易 adapter | **未授權，不實作** | — |
| P5 Acceptance | 未開始 | — |
