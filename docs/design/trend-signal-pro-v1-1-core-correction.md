# Trend Signal Pro V1.1 — 趨勢訊號核心設計修正（優先規格）

日期：2026-10-20
狀態：需求修正與開發指引；**不代表已驗證任何交易優勢**
範圍：Shioaji Pro Fork `Zongc-spec/shioaji-pro-app`。
**優先順序**：本文件覆蓋 `trend-signal-pro-v1.md` 的 §1.1、§1.2 中對 **趨勢訊號、入場觸發** 的 EMA21／EMA9／VWAP／KD 強制依賴、15 分鐘候選過期等假說；其他資料完整性、風控隔離、唯讀、後續模擬驗收要求繼續有效。若新舊衝突以本文件為準。

## 1. 已確認的使用者需求

1. 目標是**獨立開發**功能與視覺類似 Universal Indicator Ultimate AI 的紅／綠趨勢線、BUY／SELL 標記、跨週期儀表板；不要求原版訊號相同，不宣稱擁有原作者非公開公式。
2. **5m = 唯一核心趨勢方向與主要翻轉訊號**；**1m = 順 5m 方向尋找較佳的實際買賣點**；**15m／60m = 輔助資訊，不否決 5m**。
3. 趨勢核心不得直接使用先前交易研究的 EMA9＋VWAP＋KD 訊號規則作不可變更預設。該規則可留為明確標註的 optional / legacy entry-plugin，初始狀態為 OFF。
4. 風控與訊號**獨立**：停止價、R、部分停利、保本和追蹤停損永不參與產生趨勢方向；保護性風控可先於 5m 收棒生效。
5. 預設只看圖及觀察訊號，不以「啟用指標」等同允許自動交易：read_only=true、auto_entry=false、auto_exit=false。

## 2. 必須拆成四個模組（介面化，禁止綁死）

- `TrendCore`：輸入已完成的單週期 K 棒、參數與演算法版本；輸出 `LONG|SHORT|NEUTRAL|UNKNOWN`、紅綠線值、轉換事件、資料時間、版本；核心不得依賴交易帳戶、下單或 EntryTiming。
- `EntryTiming`：輸入已確認的 **5m TrendCore state** 和當時已完成 1m K 棒；輸出 `POTENTIAL_ENTRY_LONG|POTENTIAL_ENTRY_SHORT|NONE`、reason / candidate id；不得改寫 5m state。
- `MtfContext`：將 1m/5m/15m/60m 同步到真實可知的各時間點，只用已完成 K 棒；15m、60m 輔助方向及 UNKNOWN/STALE；不得向前洩漏尚未收盤的高週期。
- `RiskPlanner`：基於**人工確認的真實成交均價**（或明確標示的虛擬示例入場價）與初始停損生成 SL／1R／2R／3R 及後續保護線；不得反向改寫訊號。

## 3. 趨勢演算法先比較，不預設自己比商業原版好

以純函式實作至少下列三個可配置候選。參數可以調整，所有版本均使用同樣的收盤確認、同步、數據、交易成本與評估切分；不得只選對自己有利的比較案例。

| ID | 趨勢核心候選 | 原理 | 預期權衡（不是測試結論） |
|---|---|---|---|
| A | ATR SuperTrend（如 10,3，純候選初始值） | ATR 追蹤通道與越線狀態切換 | 清楚、容易實作；盤整容易反覆翻轉 |
| B | KAMA adaptive filter + ATR hysteresis | 自適應平滑線，超過波動緩衝才改向 | 可能降低雜訊，但代價可能是較慢確認 |
| C | Donchian price breakout + ATR trailing state | 完成 K 棒區間突破與 ATR 出場帶 | 側重結構突破，可能偏晚且盤整假突破 |

- 5m 的 `BUY/SELL` 是**已收 K 棒上的 TrendCore state 從非 LONG→LONG／非 SHORT→SHORT**；每次狀態切換只能產生一個不可變事件。禁止把 1m KD 交叉當成 5m BUY。
- 圖形可獨立於邏輯樣式（分段平滑、紅綠線、箭頭）；不可把指標線的外觀平滑方式改到會在歷史圖上使用未來數據。
- 所有候選實際輸出與對照指標績效必須經資料驗證，不能自稱更準。原版缺少可重現訊號資料時，明確註記「無法直接比較原版」。

## 4. 1m 進場位置：與核心分離，可並行比較兩套，預設不可自動送單

1. `MICRO_TREND`：只有 5m 已確認 LONG/SHORT 時，1m 使用**同一 TrendCore 家族**的已完成 K 棒反向→同向切換，標記為 `ENTRY_HINT`，而不是主趨勢 BUY/SELL。1m 參數獨立，須顯示更多雜訊的風險。
2. `PRICE_STRUCTURE`：在 5m 仍同向時，1m 使用已確認回撤結構與收盤突破的獨立入場候選。擺動點需要確認延遲且不可事後回填到未確認當時，突破門檻與有效期須寫清楚、可重放驗證。
3. 舊的 `EMA9/VWAP/KD` 規則若保留只能是第三套可選 plugin，名稱明確標註「先前策略假說／未驗證」，預設 OFF；不得作為核心算法唯一實作。

**重要**：5m LONG 狀態可持續允許 1m 順勢提示，直至 5m 變為失效／逆向／UNKNOWN；先前任意 15 分鐘候選到期只能成為可選 `post-flip entry window`，不得默認限制整段趨勢的 1m 提示。若 5m 未知/過期/不完整，1m 不產生可交易提示。

## 5. UI 及訊號語義

- 5m `BUY/SELL` = 5m **主趨勢切換**；1m `ENTRY LONG/SHORT` = 5m 方向內的**執行候選**；不可兩者都顯示 BUY 卻無法辨識來源。
- 顯示 5m/1m/15m/60m 的方向、最後完成 K 棒時間、數據是否陳舊、所選核心算法和版本、計算參數與訊號解釋。
- 1m 畫面切換成 5m 時，時間軸上的訊號標記必須維持原始觸發時間（不得以事後重算錯誤回貼 5m）。
- 高週期逆向只顯示警示，除非日後另立並明確授權的版本，不能變成硬性閘門。

## 6. 研究與驗收 Gate（不捏造績效）

- **Gate 0**：先審查目前 Claude 已完成的檔案與 commit，不刪工作；列出舊假說滲入哪些函式、測試與 UI；設計 adapter 或遷移方法。
- **Gate 1**：三種 `TrendCore` 的 deterministic unit / replay；confirmed-bar/no-lookahead/no-repaint；暖機資料 UNKNOWN、重算相同 signal ID、夜盤 session、資料缺洞、歷史回補、隔夜。
- **Gate 2**：1m `EntryTiming` 至少 MICRO_TREND 與 PRICE_STRUCTURE 兩候選，使用已知時間戳，不與 5m BUY/SELL 混淆；不允許未確認 pivot。
- **Gate 3**：UI 可選 A/B/C 和 EntryTiming；五分主趨勢，四週期面板；測試切換、圖表回放、刷新後無重複訊號。
- **Gate 4**：只讀 `RiskPlanner` 依真實交易乘數與口數生成 R 線；保護線不能產生下單副作用。
- **Gate 5**：相同資料窗與成本、訓練／樣本外時序切分、不同市場型態及日夜盤的公平比較，報告信號翻轉密度、反應延遲、進出場可成交性、成本後表現及回撤；不以單張截圖或勝率一項選贏家。未完成不要指定「最佳」。

禁止對正式交易環境送出任何委託；不可修改既有策略研究 repo、帳戶憑證、真實交易保護行為。P4 以上任何模擬委託連動另需使用者確認。遇到未確認的交易安全問題停止該部分。

## 7. 對 Claude Code 的直接指令

先不要繼續把 EMA／VWAP／KD 擴張為唯一 Trigger。以本文件優先於舊 §1.1／§1.2 修正當前架構。從檢查已存在的程式碼與測試開始，保留已可重用之 UI、資料層及風控成果；再完成可配置的三個 TrendCore 與分離的 EntryTiming，僅以唯讀模式展示候選與公平測試結果。分 Gate 回報證據、失敗測試、變更檔案及 commit SHA；沒有驗證數據不得宣稱比 Universal Indicator 準。
