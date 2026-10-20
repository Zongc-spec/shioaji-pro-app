# Shioaji Pro — 5m 主控、1m 執行、15m/1h 輔助趨勢與 R 倍數風控

版本：V1.0 設計規格（2026-10-20）  
狀態：**2026-10-20 依使用者確認修訂；P0–P3、P5 已實作於 `codex/trend-signal-pro-v1`（只觀察，未交易）；P4 未授權**

> **修訂摘要（2026-10-20）**：使用者釐清本指標是功能對齊 Universal Indicator Ultimate AI 的**獨立趨勢指標**，
> 不是把交易策略假說包裝成指標。§1.1 的 EMA21 複合條件改為訊號註記、§1.2 的 EMA9／VWAP／KD 改為可選的舊假說
> 比較模式；核心改為可切換的趨勢演算法（SuperTrend 預設、Donchian、KAMA），1m 進場時機改為 IMMEDIATE（基準）、
> MICRO_TREND、PRICE_STRUCTURE 三個獨立模式。設計、量測與驗收見
> [重設計提案](trend-signal-pro-v1-redesign.md)、[量測報告](../research/trend-signal-algorithms-2026-10.md)、
> [實作紀錄](trend-signal-pro-v1-impl.md)、[使用說明](../trend-signal-pro.md)。原 §1.1／§1.2 條件見 git 歷史 `6efd140`。  
適用標的：臺指類期貨，優先 TMF（微型臺指）、MTX（小型臺指）  
來源：依使用者交易工作流設計的獨立規則，**不是 Universal Indicator 的複製、還原或原版演算法**。

## 0. 設計不變條件

1. **5m 主控**：5m 收棒確認的趨勢與 BUY/SELL 決定方向、入場資格、主要趨勢出場。持有多單時，5m 確認 SELL 應立即進入平多流程；空單對稱。不得等待 1m 的反向交叉才處理。
2. **1m 執行**：在 5m 允許的方向尋找 pullback+reversal 入場位置；可提供預警及精細出場參考，但不得改寫 5m 核心方向。不強制每個 5m 訊號都要成交。
3. **15m/60m 只輔助**：僅展示同向／逆向／盤整、關鍵價、風險標註。V1 預設 **不以高週期拒絕下單、不改變持倉規則與口數**。
4. **保護性風控優先**：初始停損、觸發式保本及移動停損可在 5m 翻轉前出場；不得為了等 5m 收棒延遲保護性平倉。
5. **先觀察、再模擬、最後才考慮實單**：V1 預設 `read_only = true`、`auto_entry = false`、`auto_exit = false`。啟用任何發單能力需獨立明確確認，不以安裝指標等同授權自動下單。
6. **不偷看未來**：各週期只使用當時已收盤的 K 棒。進行中的 K 棒最多呈現「預覽」，不得倒灌歷史 BUY/SELL、不得用高週期未完成數值判斷歷史訊號。
7. **R 在入場成交後固定**：因填單價與初始停損價而定，之後移動停損不能重新定義 1R/2R/3R。所有價格以交易所合法 tick 取整。

## 1. 四週期用途與訊號規則

| 週期 | 身分 | 規則輸出 | 是否控制交易 |
|---|---|---|---|
| 5m | 唯一趨勢主控 | UP / DOWN / UNKNOWN；BUY、SELL（趨勢切換）；綠紅趨勢線（SuperTrend／Donchian／KAMA 可切換） | 是 |
| 1m | 進出場時機 | IMMEDIATE／MICRO_TREND／PRICE_STRUCTURE 時機事件；1m 微型趨勢；1m 結構停損參考 | 只決定時機，不改 5m 訊號 |
| 15m | 結構輔助 | 方向、短線結構強弱、附近高低點 | 否 |
| 60m | 背景輔助 | 方向、較大支撐壓力、逆勢提示 | 否 |

### 1.1 5m 趨勢（核心，2026-10-20 修訂）

- 指標：已收棒 5m 的趨勢演算法，預設 **SuperTrend(ATR 10, 倍數 3)**，可切換 Donchian(20)、KAMA(10,2,30)＋0.3 ATR 遲滯。
- 方向：UP／DOWN；暖身期間（SuperTrend 15 × ATR 週期、KAMA 5 × 慢速常數）輸出 UNKNOWN，不與任何方向混淆。
- BUY：已確認收棒方向由 DOWN 轉 UP 的那一根；SELL 鏡像。UNKNOWN → 有方向不是訊號；BUY／SELL 嚴格交替。
  產生不可變 signal id 與時間戳，只由趨勢參數決定（改進場或風控參數不改訊號）。
- 註記（不影響訊號）：收盤對 EMA21 與 EMA21 斜率同向／逆向；15m／60m 同向／逆向。
- 若持有 LONG，新的 5m SELL 觸發**立即平多（下一根 1m 開盤）**，不等 1m；SHORT 反之。

### 1.2 1m 進場時機（5m 訊號內，2026-10-20 修訂）

每個 5m 訊號後 3 根 5m 內（不跨盤別；反向訊號確認即結束）各模式獨立判定，只決定時機、不改 5m 訊號：

1. **IMMEDIATE**（比較基準、虛擬風控預設）：5m 收棒後下一根 1m 開盤。
2. **MICRO_TREND**：1m 微型趨勢（1m SuperTrend，倍數獨立設定，預設 1.0）在訊號後由反向轉回與 5m 同向；1m 一直同向不觸發。
3. **PRICE_STRUCTURE**：訊號後形成的回檔轉折（左右各 2 根，右側收盤後才確認）確認後，收盤突破回檔起點；收盤跌破轉折即失效。
4. 舊假說（可選比較，參數固定、不再擴充）：EMA9／當盤 VWAP 回測＋KD(9,3,3) 交叉＋K ≥ 80 追價過濾。

不得使用未確認 K 棒或未來轉折；不得假設等待確認一定比較好（量測見量測報告結果 4）。觸發後只產生「待人工確認」的
時機事件；訊號時間與虛擬成交時間分開儲存。1m 反向只作警告，不推翻 5m。

### 1.3 高週期輔助

- 15m／60m 使用各自已完成 K 棒的 SuperTrend + EMA21，顯示 LONG/SHORT/NEUTRAL/UNKNOWN、最後更新時間。
- 增加 `ALIGN`、`DIVERGE`、`NEUTRAL` 標籤及最近關鍵價。
- 當兩者都與 5m 反向時，以黃字提示「高週期逆向」，不鎖定交易。未來若要作為硬條件，須另開策略版本並單獨驗收。

## 2. 初始停損、R 與口數限制

- 初始停損（多）：`min(最近 5 根已完成 1m 的確認擺動低點 - 1 tick, 進場成交價 - 1.5 × 1m ATR14)`。擺動低點的確認必須明確指定使用已完成 K 棒；若無有效擺動低點，僅用 1.5 ATR 備援並標示。
- 空單鏡像。實際停損可被設定為 5m 結構參考，但必須重新估算風險；**不能為了符合風險上限任意將停損移近、破壞技術失效邏輯**。
- `R_points = abs(actual_average_entry_fill - immutable_initial_stop)`；固定 1R/2R/3R：多單 `entry + k*R_points`，空單 `entry - k*R_points`，按 tick 正規化。
- 單筆計畫總風險（新臺幣） = `R_points × 每點價值 × 口數 + 預估來回手續費 + 保守滑價緩衝`。若超預算：減口數或拒絕開倉。此為**預估風險**；跳空、滑價、故障可能造成超額實現虧損。
- 預設風險預算 `NT$1,000 / 筆` 可設；預設手續費採使用者目前常用 TMF 單邊 NT$12，須允許逐商品／逐帳戶覆寫；滑價成本按 ticks × 每點價值另計。
- 依期交所：TMF 每點 NT$10；MTX 每點 NT$50。必須按照實際商品規格載入，嚴禁以 TMF 風控參數直接套用 MTX。
- 新倉前校驗帳戶、商品、期別、保證金、已有持倉、有效行情與現在執行環境；風險預算涵蓋本訊號的**全部口數**，不以每口單獨算 1,000。

## 3. 1R／2R／3R 與混合式出場

多空鏡像。下列是**待驗證的預設提案，不代表獲利最佳化結果**：

- +1R：到價提醒，將停損上移到約 `成交均價 + 估算來回成本與滑價緩衝折算點數`（空單反向）；保本是淨成本保護目標而非成交保證。
- +2R：開始動態停損追蹤；多口時可設定第 1 層停利。
- +3R：顯示第 3R 達標訊號；多口時可設定第 2 層停利，餘額保留趨勢延伸倉。
- 剩餘倉動態停損（多）：`S_new = max(S_old, 上一根已確認5m SuperTrend支撐 - 1 tick, 入場後可驗證最高價 - 1.2 × 已完成5m ATR14)`；若無法取得必要來源，則不盲目更新。空單採 `min` 及鏡像。
- 如果計算出的新停損已在當前可執行行情的錯誤一側，不建立無效觸價單，改由明確的「已穿價／立即處理」流程處置。
- Stop 價格只能向獲利方向移動；每次修改保護單必須有 ack、對應持倉量、取消／修改結果核對，不允許孤兒 OCO 訂單。
- 任何時間的 5m 確認反轉、緊急停損觸發或交易員手動全部平倉，都要使其他關聯保護單同步取消／核對，避免殘留反向委託。

**口數對應（最多 3 層，與現有 Bracket tiers 結構相容）：**

| 口數 | 提案方式 |
|---|---|
| 1 | +1R 保本、+2R 啟動移動停損；由 5m 反轉或保護停損出場。可自行改成 2R 或 3R 全出。單口不能部分停利。 |
| 2 | 1 口在 2R 出場；1 口保留追蹤。3R 為後者提醒／延伸管理價，非預設自動全出。 |
| 3 | 第 1 口 2R；第 2 口 3R；第 3 口追蹤。 |
| 4+ | 2R、3R、追蹤三層的口數可自訂，系統不得因整數口數分配產生零口或超賣。 |

每個 +R 階段均紀錄觸價、委託、實際成交與剩餘口數，不得以「到價」等同「已實現獲利」。

## 4. 操作畫面

- **主圖 5m**：可切換 1m 顯示，仍維持 5m 主控；綠／紅 SuperTrend、5m BUY/SELL 箭頭、1m 精準觸發標記（依原始時間定位）、初始停損、1R／2R／3R 水平線、動態 Stop（階梯線）。
- **右側 1m 小圖**：顯示最近 120 根 1m、1m 微型趨勢線、5m 訊號與 MICRO_TREND／PRICE_STRUCTURE 進場點（2026-10-20 修訂；不顯示 EMA9／VWAP／KD）。
- **右上 MTF Dashboard**：5m `主控`（最醒目）、1m `觸發`、15m `輔助`、60m `背景`；每一格有狀態、值與最後收棒時間，UNKNOWN 和 stale 必須可見。
- **右下 R 面板**：商品、帳號（必要遮蔽）、方向、成交均價、初始風險點數／金額、初始 stop、1R／2R／3R、已實現／未實現損益、有效持倉、保護單狀態、目前 trailing stop。
- **模式切換**：觀察（預設）、模擬警示、模擬交易（另授權）、正式交易（初版不開放自動進場）。
- **訊號審計**：按訊號 ID 顯示因由、引用的各週期 bar close time、計算版本、行情來源、下單結果／拒絕原因；可匯出離線檢查。

## 5. Shioaji Pro 現有程式整合點

參考來源：`https://github.com/Sinotrade/shioaji-pro-app`（已檢查 2026-10-20 公開 main，**實際實作前仍須以自己的 Fork 當下版本複核差異**）。

- `src/components/candle-chart.tsx`：目前可選 1m／5m／15m／60m，主圖使用 lightweight-charts；新增 5m 主控視覺、1m marker、價位線，避免污染原有買賣委託圖層。
- `src/lib/indicator-defs.ts`、`src/lib/indicators.ts`：已含 SuperTrend、EMA、VWAP、KD、ATR；採用現有純函式，新增必要的 `trend-signal` 計算及訊號狀態。
- `src/lib/custom-runtime.ts`、`src/components/custom-indicator-editor.tsx`：自訂 JS 僅能直接輸出 series 的 line/histogram/points，無法直接完成完整 MTF Dashboard／箭頭／保護性交易；完整模組應實作為原生功能。
- `src/lib/chart-history.ts`、`src/lib/shioaji.ts`、現有 1m→5m/15m/60m aggregation：建立**單一共享、可稽核**的 normalized 1m K 棒資料來源和 confirmed-bar MTF pipeline，避免不同 pane 狀態不一致。
- `src/lib/conditional/trailing.ts`、`src/lib/conditional/bracket-rules.ts`、`src/lib/trigger-engine.ts`：已有 trailing、breakeven、最多 3 層 bracket 基礎。先檢查現有契約的能力邊界，必要時加 adapter；**不要平行開第二套下單執行引擎**。
- `src/lib/execution/background.ts`、`src/lib/execution/bracket-contract.ts`：桌面背景引擎有 ownership 機制；新增訊號模式不應繞過 background health、環境、帳號及單一 owner 規則。
- 注意現有內建 VWAP（`src/lib/indicators.ts`）是依 `Math.floor(time / 86400)` 重設，並非期交所台灣日夜盤交易時段完整定義；本模組必須先釐清基礎資料的時區與 session anchor，不能直接照搬為「當盤 VWAP」。
- 注意 source code 授權為 `AGPL-3.0-only`，開發 Fork 與對外提供服務時應遵守授權。

## 6. 安全控制與例外

- 僅在同一交易商品、期別及已確認帳戶的持倉上做保護。不可因 5m 換方向自動對其他期別／帳號反向開新倉。
- 資料斷層、延遲、歷史回補、盤別切換、換月、假日／到期日、夜盤跨午夜要獨立測試；`stale/unknown` 禁止產生新的可交易訊號。
- 切換圖表週期、重開 App、斷線重連不得重播已執行訊號或重複送單；每次訊號有 `symbol + contract_month + session + timeframe + closed_bar_end + direction + algorithm_version` 可追溯識別碼。
- 部分成交、撤單失敗、保護單重建失敗、送單結果不明：必須顯示高優先警告和當前委託核對，不盲目重掛；絕不可聲稱已保護。
- 背景程式持續執行**不等於交易所原生停損**；主機斷電、連線故障或行情停滯等情況可能無法即時送出委託。上線前須核對到底哪個保護留在券商／交易所端。
- 手動平倉優先於程式；多個不同 trigger 同時觸發只允許一個受控 exit workflow，避免超額出場變成反向開倉。
- 停損滑價及波動跳躍可能造成實際損失超過估算上限。禁止文案「保證風險不超過 NT$1,000」。

## 7. 分階段實作及 Gate

**P0 — 現況核對／凍結基線**：以自己 Fork 最新 commit 確認上述 API、圖表層、已有括號單及單元測試；紀錄基準 SHA，在 `codex/trend-signal-pro-v1`；不改既有實單行為。

**P1 — Pure signal engine／MTF 資料層**：產生 canonical 1m/5m/15m/60m confirmed bars、5m 趨勢核心（可切換演算法）、1m 進場時機模組、15m/60m 輔助；驗收 A1–A10（不偷看未來、不重繪、交替、模組獨立、起點不變、週期切換不漂移、確定性、數值對照）。此階段禁止發單。

**P2 — UI／Dashboard**：K 線信號箭頭、5m 趨勢綠紅線、1m EMA／VWAP／KD、四週期面板、訊號審計、失效或延遲 badge，主圖拖曳及切期別 regression。此階段禁止發單。

**P3 — Pure risk planner**：初始停損、NT$風險預算、R 階段、整數口數分配、ticker tick rounding、trailing monotonic、空單鏡像。先僅顯示虛擬計畫與警示，不送任何委託。

**P4 — Simulation-only bracket adapter**：經人工允許的模擬委託才調用既有 bracket owner；實際成交重新定價、OCO／分批成交／重連／手動平倉驗收；正式帳號仍不能自動入場。

**P5 — Acceptance**：`npm test`、`npm run build`、新增 deterministic replay 測試、會話與夜盤案例、完整操作影片或截圖；明確報告通過／未過 Gate。另有人為確認前**不啟用正式自動交易**。

### 必驗案例

1. 5m BUY 出現時，所選 1m 時機條件未成立 → 不進場；窗口過後也不補單（2026-10-20 修訂：適用所有確認型模式）。
2. 5m 已收棒 SELL，持有多單 → 出場流程觸發，不等待 1m 死叉；不自動直接翻空。
3. 15m 或 1h 與 5m 反向 → 面板警示，但不更改 V1 訊號或口數。
4. 尚未收完的 5m/15m/60m K 棒臨時反轉，收盤恢復 → 不產生永久訊號；重啟與重放輸出一致。
5. 1、2、3、4 口對照 R 階段；口數加總與平倉紀錄正確；一口不得出現 0.5 口分批。
6. TMF 與 MTX 同樣 50 點停損，金額計算不能相同。
7. 部分成交、滑價、連線斷線、重連、重放 callback、換月、跨午夜／日夜盤及交易日邊界。
8. 盤中手動平倉後，舊 stop/take 被正確核銷；未知送單結果不會重送。
9. 5m 趨勢線和 1m 訊號繪圖，切換 1m/5m/15m 不造成時間漂移。
10. 既有 SuperTrend、自訂指標、chart 交易模式、條件單、background bracket、手動下單均無 regression。

## 8. Codex 執行指示（可直接貼上）

請在我目前 Fork 的 `Zongc-spec/shioaji-pro-app` 專案依本文件開始規劃與實作，**不要改動其他專案**。先核對真正 repo/root/branch/HEAD，確認有乾淨工作樹與合法的開發分支，絕不猜測既有 Fork 路徑。先完成 P0 的檔案與 contract inspection、寫出短設計決策記錄，再進行 P1→P3 並逐階段執行測試；P4 限模擬且須再次要求確認，P5 驗收。禁止真實送單、禁止自動打開正式交易、禁止建立平行保護引擎、禁止虛構回測結果。使用 5m 主控／1m 執行／15m & 1h 只輔助的邏輯，保證 confirmed-bar/no-lookahead，所有風險預算按商品乘數及成交結果計算。所有每階段結果須回報：更動檔案、正式規則、測試結果、未處理風險與 commit SHA。若遇到交易安全性不明或 P0 基線不符，停止修改並提出阻塞原因，不可跳過 Gate。

## 9. 官方與原始碼參考

- Shioaji Pro：https://github.com/Sinotrade/shioaji-pro-app
- 自訂指標 API：https://github.com/Sinotrade/shioaji-pro-app/blob/main/docs/backtest-ta-reference.md
- 官方 TMF：https://www.taifex.com.tw/cht/2/tMF
- 官方 MTX：https://www.taifex.com.tw/cht/2/mTX
- Universal Indicator 產品介紹（功能參考，不複製商業演算法）：https://www.universal-indicator.com/