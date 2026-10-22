// Trend Signal Pro tsp-app-1.5.1 — Web/App 共用計算函式，官方 App 自訂指標
// 由 npm run build:tsp-custom 產生；請修改 src/lib/trend-signal 的共用來源。
// 5m 是主趨勢並判斷進出場，1m 是精準進出場；App 只給主圖本身的 K 棒，所以依主圖週期：
//   1m 主圖：原模型（由 1m 聚合 5m 主趨勢、1m 精準提示、虛擬風控），與 Web 逐根相同。
//   5m 主圖：5m 主趨勢＋三種進場模式與虛擬風控，全部用 5m K 棒（提示看不到 5 分鐘內的回檔）。
// 初始停損預設依 5m 擺動點與 5m ATR（stopTf=5；1＝1m 原規則），每筆風險預算預設 NT$2,500。
//   15m／60m／日K：只畫該週期趨勢線作高週期輔助，不產生訊號、進出場與風控。
// 預設明訂微台：tick=1、每點10元、單邊手續費12元、單邊期交稅0.00002；不自動辨識商品或真實持倉。
// 輸出19條：趨勢/提示、初始/目前停損、保本、1R/2R/3R、虛擬進出場；全部為觀察與虛擬計算。
// 趨勢線只顯示最後一段有效趨勢；目前風控為虛線，目前停損為階梯虛線。
// 三角形與 Buy/Sell 文字需要支援 plot markers 的 App；舊 App 會忽略 markers，仍畫圓點。
// 舊指標已保存的樣式優先：請將六項風控輸出改為虛線、目前停損選階梯線，或新建指標。
// 不讀帳密、不連網、不送改撤單；沒有原生Feed的資料凍結、LIVE徽章或完整審計面板。
// 更新歷史/載入起點/參數變更仍會重算；與Web比對需相同資料、asOf、商品規格與完整設定。
(function() {
	//#region src/lib/utils/kbars.ts
	function aggregate(candles, minutes) {
		if (minutes <= 1) return candles;
		const out = [];
		let cur = null;
		const bucketSec = minutes * 60;
		for (const c of candles) {
			const bucket = minutes >= 1440 ? Math.floor(c.time / 86400) * 86400 : Math.ceil(c.time / bucketSec) * bucketSec;
			if (!cur || cur.time !== bucket) {
				if (cur) out.push(cur);
				cur = {
					...c,
					time: bucket
				};
			} else {
				cur.high = Math.max(cur.high, c.high);
				cur.low = Math.min(cur.low, c.low);
				cur.close = c.close;
				cur.volume += c.volume;
			}
		}
		if (cur) out.push(cur);
		return out;
	}
	var TW_OFFSET_SEC = 8 * 3600;
	function nowWallClockUtc() {
		return msToWallClockUtc(Date.now());
	}
	function msToWallClockUtc(ms) {
		return Math.floor(ms / 1e3) + TW_OFFSET_SEC;
	}
	//#endregion
	//#region src/lib/intraday-session.ts
	var H = 3600;
	var DAY$1 = 86400;
	function sessionWindowFor(secType, t) {
		const d0 = Math.floor(t / DAY$1) * DAY$1;
		const tod = t - d0;
		if (secType === "FUT" || secType === "OPT") {
			if (tod <= 5 * H) return {
				start: d0 - DAY$1 + 15 * H,
				end: d0 + 5 * H,
				night: true
			};
			if (tod <= 13.75 * H) return {
				start: d0 + 8.75 * H,
				end: d0 + 13.75 * H,
				night: false
			};
			return {
				start: d0 + 15 * H,
				end: d0 + DAY$1 + 5 * H,
				night: true
			};
		}
		return {
			start: d0 + 9 * H,
			end: d0 + 13.5 * H,
			night: false
		};
	}
	//#endregion
	//#region src/lib/trend-signal/config.ts
	/** 計算規則版本：改動任何訊號／進場／風控規則都要升版，舊 ID 才不會混淆。
	*  1.1.0：TrendCore 四態（含 NEUTRAL）與 Donchian＋ATR、整段趨勢的多次 1m 提示（V1.1）
	*  1.1.1：缺分鐘的 5m 不參與計算、5m 桶內缺分鐘後的 1m 不提示、即時資料以涵蓋判定已收並凍結
	*  1.1.2：停用重啟重設接收涵蓋、心跳不推進資料確認、補抓回應順序與多口進場稅分配修正
	*  1.1.3：虛擬進場的下一分鐘缺棒時取消，不延後到下一根現存 K 棒
	*  1.2.0：初始停損預設改依 5m 擺動點與 5m ATR（stopTf=5；1 為原規則）、每筆預算預設 NT$2,500（使用者決定，研究結果 7） */
	var TSP_ALGO_VERSION = "tsp-1.2.0";
	var TREND_ALGOS = [
		"supertrend",
		"donchian",
		"kama"
	];
	var ENTRY_MODES = [
		"IMMEDIATE",
		"MICRO_TREND",
		"PRICE_STRUCTURE",
		"PULLBACK_KD"
	];
	var TSP_PARAMS = [
		{
			key: "algo",
			label: "趨勢｜演算法（0 SuperTrend／1 Donchian／2 KAMA）",
			def: 0,
			min: 0,
			max: 2
		},
		{
			key: "stPeriod",
			label: "趨勢｜SuperTrend ATR 週期",
			def: 10,
			min: 1,
			max: 100
		},
		{
			key: "stMult",
			label: "趨勢｜SuperTrend 倍數（靈敏度，小＝快）",
			def: 3,
			min: .5,
			max: 10,
			step: .5
		},
		{
			key: "dcLength",
			label: "趨勢｜Donchian 突破週期",
			def: 20,
			min: 2,
			max: 200
		},
		{
			key: "dcAtrMult",
			label: "趨勢｜Donchian ATR 追蹤帶倍數（觸及＝趨勢失效）",
			def: 3,
			min: .5,
			max: 10,
			step: .5
		},
		{
			key: "kamaLength",
			label: "趨勢｜KAMA 效率比週期",
			def: 10,
			min: 2,
			max: 100
		},
		{
			key: "kamaFast",
			label: "趨勢｜KAMA 快速常數",
			def: 2,
			min: 1,
			max: 50
		},
		{
			key: "kamaSlow",
			label: "趨勢｜KAMA 慢速常數",
			def: 30,
			min: 2,
			max: 200
		},
		{
			key: "kamaHyst",
			label: "趨勢｜KAMA 翻轉遲滯（× ATR14）",
			def: .3,
			min: 0,
			max: 3,
			step: .05
		},
		{
			key: "emaPeriod",
			label: "註記｜EMA 週期（只標示，不影響訊號）",
			def: 21,
			min: 2,
			max: 200
		},
		{
			key: "entryMode",
			label: "進場｜風控採用（0 IMMEDIATE／1 MICRO_TREND／2 PRICE_STRUCTURE／3 先前策略假說・未驗證 EMA9·VWAP·KD）",
			def: 0,
			min: 0,
			max: 3
		},
		{
			key: "hintWindow",
			label: "進場｜提示範圍（0 整段 5m 趨勢／N 翻轉後 N 根 5m）",
			def: 0,
			min: 0,
			max: 20
		},
		{
			key: "microStMult",
			label: "進場｜1m 微型趨勢 SuperTrend 倍數",
			def: 3,
			min: .25,
			max: 10,
			step: .25
		},
		{
			key: "microDcLength",
			label: "進場｜1m 微型趨勢 Donchian 週期",
			def: 20,
			min: 2,
			max: 200
		},
		{
			key: "microKamaHyst",
			label: "進場｜1m 微型趨勢 KAMA 遲滯（× ATR14）",
			def: .3,
			min: 0,
			max: 3,
			step: .05
		},
		{
			key: "pivotLeft",
			label: "進場｜結構轉折左側 K 棒",
			def: 2,
			min: 1,
			max: 10
		},
		{
			key: "pivotRight",
			label: "進場｜結構轉折右側確認 K 棒",
			def: 2,
			min: 1,
			max: 10
		},
		{
			key: "minPullbackAtr",
			label: "進場｜最小回檔（× 1m ATR14）",
			def: .5,
			min: 0,
			max: 5,
			step: .05
		},
		{
			key: "budget",
			label: "風控｜每筆風險預算 NT$",
			def: 2500,
			min: 100,
			max: 1e6,
			step: 100
		},
		{
			key: "feePerSide",
			label: "風控｜單邊手續費 NT$/口",
			def: 12,
			min: 0,
			max: 1e3
		},
		{
			key: "slipTicks",
			label: "風控｜滑價緩衝（tick/邊）",
			def: 1,
			min: 0,
			max: 20
		},
		{
			key: "qty",
			label: "風控｜計畫口數上限",
			def: 1,
			min: 1,
			max: 50
		},
		{
			key: "stopTf",
			label: "風控｜初始停損週期（5 主趨勢 5m／1 進場 1m 的擺動點與 ATR）",
			def: 5,
			min: 1,
			max: 5,
			step: 4
		},
		{
			key: "swingBars",
			label: "風控｜擺動高低點 K 棒數（停損週期）",
			def: 5,
			min: 3,
			max: 30
		},
		{
			key: "stopAtr",
			label: "風控｜初始停損 ATR 倍數（停損週期 ATR14）",
			def: 1.5,
			min: .5,
			max: 5,
			step: .1
		},
		{
			key: "trailAtr",
			label: "風控｜移動停損 ATR 倍數（5m）",
			def: 1.2,
			min: .5,
			max: 5,
			step: .1
		},
		{
			key: "singleExit",
			label: "風控｜單口出場（1 追蹤／2 2R／3 3R）",
			def: 1,
			min: 1,
			max: 3
		},
		{
			key: "tierMode",
			label: "風控｜多口分配（0 規格表／1 自訂）",
			def: 0,
			min: 0,
			max: 1
		},
		{
			key: "tp2Lots",
			label: "風控｜自訂 2R 停利口數",
			def: 1,
			min: 0,
			max: 50
		},
		{
			key: "tp3Lots",
			label: "風控｜自訂 3R 停利口數",
			def: 1,
			min: 0,
			max: 50
		}
	];
	var DEFAULTS = Object.fromEntries(TSP_PARAMS.map((p) => [p.key, p.def]));
	function param(p, key) {
		const def = TSP_PARAMS.find((d) => d.key === key);
		const v = p[key];
		if (typeof v !== "number" || !Number.isFinite(v)) return def.def;
		return Math.min(def.max, Math.max(def.min, v));
	}
	var int = (p, key) => Math.round(param(p, key));
	function configFromParams(p = {}) {
		const trend = {
			algo: TREND_ALGOS[int(p, "algo")] ?? "supertrend",
			stPeriod: int(p, "stPeriod"),
			stMult: param(p, "stMult"),
			dcLength: int(p, "dcLength"),
			dcAtrMult: param(p, "dcAtrMult"),
			kamaLength: int(p, "kamaLength"),
			kamaFast: int(p, "kamaFast"),
			kamaSlow: int(p, "kamaSlow"),
			kamaHyst: param(p, "kamaHyst")
		};
		const note = {
			emaPeriod: int(p, "emaPeriod"),
			emaSlopeBars: 2,
			atrPeriod: 14,
			rsiPeriod: 14,
			keyBars: 20
		};
		const entry = {
			mode: ENTRY_MODES[int(p, "entryMode")] ?? "IMMEDIATE",
			windowBars: int(p, "hintWindow"),
			microMult: param(p, "microStMult"),
			microDcLength: int(p, "microDcLength"),
			microKamaHyst: param(p, "microKamaHyst"),
			pivotLeft: int(p, "pivotLeft"),
			pivotRight: int(p, "pivotRight"),
			minPullbackAtr: param(p, "minPullbackAtr")
		};
		const singleExit = int(p, "singleExit");
		return {
			trend,
			note,
			entry,
			risk: {
				budget: param(p, "budget"),
				feePerSide: param(p, "feePerSide"),
				slipTicks: int(p, "slipTicks"),
				qty: int(p, "qty"),
				swingBars: int(p, "swingBars"),
				stopAtr: param(p, "stopAtr"),
				trailAtr: param(p, "trailAtr"),
				singleExit: singleExit === 2 ? 2 : singleExit === 3 ? 3 : 1,
				tierMode: int(p, "tierMode") >= 1 ? "custom" : "auto",
				tp2Lots: int(p, "tp2Lots"),
				tp3Lots: int(p, "tp3Lots"),
				stopTf: int(p, "stopTf") === 1 ? 1 : 5
			}
		};
	}
	configFromParams(DEFAULTS);
	/** 1m 微型趨勢：與 5m 同一個 TrendCore 演算法，只換各演算法的靈敏度參數（V1.1 §4）；
	*  其餘參數（ATR 週期、KAMA 週期、Donchian 追蹤帶倍數）沿用趨勢設定 */
	function microParams(cfg) {
		return {
			...cfg.trend,
			stMult: cfg.entry.microMult,
			dcLength: cfg.entry.microDcLength,
			kamaHyst: cfg.entry.microKamaHyst
		};
	}
	function fnv1a(s) {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(16).padStart(8, "0");
	}
	function fingerprint(obj) {
		const entries = Object.entries(obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		return fnv1a(JSON.stringify(entries));
	}
	/** 訊號只由趨勢參數決定：ID 只帶趨勢參數的指紋，改進場或風控參數不改訊號 ID */
	var trendKey = (cfg) => `${TSP_ALGO_VERSION}#${fingerprint(cfg.trend)}`;
	/** 每種進場模式都會計算；「風控採用哪一個」不影響事件本身，不進指紋 */
	var entryKey = (cfg) => {
		const { mode: _mode, ...rest } = cfg.entry;
		return fingerprint(rest);
	};
	var riskKey = (cfg) => fingerprint(cfg.risk);
	var configKey = (cfg) => `${trendKey(cfg)}.${fingerprint(cfg.note)}.${entryKey(cfg)}.${riskKey(cfg)}`;
	//#endregion
	//#region src/lib/trend-signal/core/session.ts
	var pad = (n) => String(n).padStart(2, "0");
	/** 牆鐘秒 → 'YYYY-MM-DD' */
	function wallDate(t) {
		const d = /* @__PURE__ */ new Date(t * 1e3);
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	}
	/** 牆鐘秒 → 'YYYY-MM-DD HH:MM' */
	function wallTime(t) {
		const d = /* @__PURE__ */ new Date(t * 1e3);
		return `${wallDate(t)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
	}
	/** 牆鐘秒 → 'HH:MM' */
	function wallHm(t) {
		const d = /* @__PURE__ */ new Date(t * 1e3);
		return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
	}
	/** 牆鐘秒 → 'YYYY-MM-DDTHH:MM'（事件 ID 用） */
	function wallIso(t) {
		return wallTime(t).replace(" ", "T");
	}
	/** 1m K 棒 label 所屬的交易時段。收盤後 CLOSE_GRACE 內的定盤 K 棒
	*  （例：期貨 13:46–13:49）歸剛收的那一盤，不歸下一盤。 */
	function tradingSessionOf(secType, label) {
		let w = sessionWindowFor(secType, label);
		const p = sessionWindowFor(secType, label - 240);
		if (p.start !== w.start && label > p.end && label <= p.end + 240) w = p;
		return {
			...w,
			key: `${wallDate(w.start)}${w.night ? "N" : "D"}`
		};
	}
	/** asOf 是否在交易時段內（週末開始的時段不存在；國定假日無從得知，
	*  由資料延遲判定補上） */
	function isSessionOpen(secType, t) {
		const s = tradingSessionOf(secType, t);
		const wd = (/* @__PURE__ */ new Date(s.start * 1e3)).getUTCDay();
		if (wd === 0 || wd === 6) return false;
		return t > s.start && t <= s.end;
	}
	/** 1m label 是否為正規交易分鐘（期貨日盤 08:46–13:45、夜盤 15:01–05:00；不含收盤定盤寬限與週末）。
	*  週期 K 棒的完整性以它為準：桶內每個正規分鐘都要有 1m。 */
	function isRegularMinute(secType, label) {
		const w = sessionWindowFor(secType, label);
		if (!(label > w.start && label <= w.end)) return false;
		const wd = (/* @__PURE__ */ new Date(w.start * 1e3)).getUTCDay();
		return wd !== 0 && wd !== 6;
	}
	//#endregion
	//#region src/lib/trend-signal/core/bars.ts
	/** label ≤ asOf 的 1m K 棒才算已收。回傳新陣列：未排序或 label 重複
	*  （後者覆蓋前者）的輸入先正規化。 */
	function confirmed1m(bars, asOf) {
		let sorted = true;
		for (let i = 1; i < bars.length; i++) if (bars[i].time <= bars[i - 1].time) {
			sorted = false;
			break;
		}
		const src = sorted ? bars : normalize(bars);
		let n = src.length;
		while (n > 0 && !(src[n - 1].time <= asOf)) n--;
		return src.slice(0, n);
	}
	function normalize(bars) {
		const byTime = /* @__PURE__ */ new Map();
		for (const b of bars) byTime.set(b.time, b);
		return [...byTime.values()].sort((a, b) => a.time - b.time);
	}
	/** 由已收 1m 建立某週期的已收 K 棒。最後一個桶只有在 label ≤ asOf，
	*  或其所屬時段已收盤（含 CLOSE_GRACE）時才保留。每根記下缺少的正規交易分鐘數
	*  （完整性；用 completeOnly() 排除不完整的桶）。 */
	function buildTf(m1, tf, secType, asOf) {
		const sessionOfLabel = /* @__PURE__ */ new Map();
		const sessionOf = (label) => {
			let s = sessionOfLabel.get(label);
			if (s === void 0) {
				s = tradingSessionOf(secType, label);
				sessionOfLabel.set(label, s);
			}
			return s;
		};
		if (tf === 1) {
			const ss = m1.map((b) => sessionOf(b.time));
			return {
				tf,
				bars: m1,
				lastMinute: m1.map((b) => b.time),
				session: ss.map((s) => s.key),
				sessionEnd: ss.map((s) => s.end),
				missing: m1.map(() => 0)
			};
		}
		const bars = aggregate(m1, tf);
		const sec = tf * 60;
		const lastMinute = [];
		const present = [];
		let j = -1;
		let cur = NaN;
		for (const c of m1) {
			const bucket = Math.ceil(c.time / sec) * sec;
			if (bucket !== cur) {
				cur = bucket;
				j += 1;
				present[j] = 0;
			}
			lastMinute[j] = c.time;
			if (isRegularMinute(secType, c.time)) present[j] += 1;
		}
		const missing = bars.map((b, k) => {
			let expected = 0;
			for (let t = b.time - sec + 60; t <= b.time; t += 60) if (isRegularMinute(secType, t)) expected++;
			return Math.max(0, expected - present[k]);
		});
		const ss = lastMinute.map((t) => sessionOf(t));
		const session = ss.map((s) => s.key);
		const sessionEnd = ss.map((s) => s.end);
		const n = bars.length;
		if (n > 0) {
			const lastLabel = bars[n - 1].time;
			const closedAt = sessionEnd[n - 1] + 240;
			if (!(lastLabel <= asOf || asOf >= closedAt)) {
				bars.pop();
				lastMinute.pop();
				session.pop();
				sessionEnd.pop();
				missing.pop();
			}
		}
		return {
			tf,
			bars,
			lastMinute,
			session,
			sessionEnd,
			missing
		};
	}
	/** 只留完整的桶（每個正規交易分鐘都有 1m）；排除的桶不參與趨勢計算，也不產生任何事件。
	*  缺分鐘可能是斷線、上游缺料，也可能是冷清時段真的沒有成交 — 無法分辨時一律保守排除。 */
	function completeOnly(s) {
		const keep = [];
		const gaps = [];
		s.bars.forEach((b, i) => {
			if (s.missing[i] > 0) gaps.push({
				tf: s.tf,
				label: b.time,
				missing: s.missing[i]
			});
			else keep.push(i);
		});
		if (gaps.length === 0) return {
			series: s,
			gaps
		};
		const pick = (a) => keep.map((i) => a[i]);
		return {
			series: {
				tf: s.tf,
				bars: pick(s.bars),
				lastMinute: pick(s.lastMinute),
				session: pick(s.session),
				sessionEnd: pick(s.sessionEnd),
				missing: pick(s.missing)
			},
			gaps
		};
	}
	/** 每根 1m 所屬的 tf 桶，在它之前是否已缺正規交易分鐘（只看這根以前，因果）。
	*  1m 提示略過這些位置：桶內出現缺口後到該桶收盤都不提示，下一個桶再由 freshAt 判定過期。 */
	function holeBefore(m1, secType, tf = 5) {
		const sec = tf * 60;
		const out = [];
		let cur = NaN;
		let present = 0;
		for (const c of m1) {
			const bucket = Math.ceil(c.time / sec) * sec;
			if (bucket !== cur) {
				cur = bucket;
				present = 0;
			}
			let expected = 0;
			for (let t = bucket - sec + 60; t < c.time; t += 60) if (isRegularMinute(secType, t)) expected++;
			out.push(expected > present);
			if (isRegularMinute(secType, c.time)) present++;
		}
		return out;
	}
	/** IndicatorPoint[]（以時間為鍵）→ 與 bars 對齊的陣列 */
	function alignPoints(bars, pts) {
		const at = /* @__PURE__ */ new Map();
		for (const p of pts) at.set(p.time, p.value);
		return bars.map((b) => at.get(b.time));
	}
	/** 最後一根 label ≤ t 的索引（bars 依時間排序）；沒有回 -1 */
	function lastAtOrBefore(bars, t) {
		let lo = 0;
		let hi = bars.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = lo + hi >> 1;
			if (bars[mid].time <= t) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return ans;
	}
	/** 第一根 label > t 的索引；沒有回 bars.length */
	function firstAfter(bars, t) {
		return lastAtOrBefore(bars, t) + 1;
	}
	/** 時點 t 所在的 tf 分鐘收盤桶（與 aggregate() 同一個 label 公式） */
	function tfBucket(t, tf) {
		const sec = tf * 60;
		return Math.ceil(t / sec) * sec;
	}
	/** 時點 t 已知的最後一根 tf K 棒（label ≤ t）是否就是前一個桶或更新。否則中間缺了
	*  整根（換盤、資料缺洞），那根的狀態已過期，不能當「現在」的狀態用。 */
	function freshAt(lastLabel, t, tf) {
		return lastLabel !== null && lastLabel !== void 0 && lastLabel >= tfBucket(t, tf) - tf * 60;
	}
	//#endregion
	//#region src/lib/indicators.ts
	function ema(bars, period) {
		return emaOf(bars.map((b) => ({
			time: b.time,
			value: b.close
		})), period);
	}
	function emaOf(points, period) {
		const out = [];
		const k = 2 / (period + 1);
		let prev = null;
		let seedSum = 0;
		let seedCount = 0;
		for (const p of points) {
			if (p.value === void 0) continue;
			if (prev === null) {
				seedSum += p.value;
				seedCount += 1;
				if (seedCount === period) {
					prev = seedSum / period;
					out.push({
						time: p.time,
						value: prev
					});
				}
				continue;
			}
			prev = p.value * k + prev * (1 - k);
			out.push({
				time: p.time,
				value: prev
			});
		}
		return out;
	}
	function trueRanges(bars) {
		const tr = [];
		for (let i = 0; i < bars.length; i++) {
			const b = bars[i];
			if (i === 0) {
				tr.push(b.high - b.low);
				continue;
			}
			const pc = bars[i - 1].close;
			tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
		}
		return tr;
	}
	function rma(values, period) {
		const out = [];
		let prev = null;
		let seed = 0;
		for (let i = 0; i < values.length; i++) {
			if (prev === null) {
				seed += values[i];
				if (i === period - 1) {
					prev = seed / period;
					out.push(prev);
				} else out.push(void 0);
				continue;
			}
			prev = (prev * (period - 1) + values[i]) / period;
			out.push(prev);
		}
		return out;
	}
	function atr(bars, period = 14) {
		const smoothed = rma(trueRanges(bars), period);
		const out = [];
		for (let i = 0; i < bars.length; i++) {
			const v = smoothed[i];
			if (v !== void 0) out.push({
				time: bars[i].time,
				value: v
			});
		}
		return out;
	}
	function supertrend(bars, period = 10, mult = 3) {
		const atrLine = rma(trueRanges(bars), period);
		const up = [];
		const down = [];
		let prevUpper = NaN;
		let prevLower = NaN;
		let trendUp = true;
		let prevClose = NaN;
		for (let i = 0; i < bars.length; i++) {
			const b = bars[i];
			const a = atrLine[i];
			if (a === void 0) {
				up.push({ time: b.time });
				down.push({ time: b.time });
				prevClose = b.close;
				continue;
			}
			const mid = (b.high + b.low) / 2;
			let upper = mid + mult * a;
			let lower = mid - mult * a;
			if (!Number.isNaN(prevUpper) && !(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;
			if (!Number.isNaN(prevLower) && !(lower > prevLower || prevClose < prevLower)) lower = prevLower;
			if (trendUp && b.close < lower) trendUp = false;
			else if (!trendUp && b.close > upper) trendUp = true;
			up.push(trendUp ? {
				time: b.time,
				value: lower
			} : { time: b.time });
			down.push(trendUp ? { time: b.time } : {
				time: b.time,
				value: upper
			});
			prevUpper = upper;
			prevLower = lower;
			prevClose = b.close;
		}
		return {
			up,
			down
		};
	}
	function rsi(bars, period = 14) {
		const gains = [];
		const losses = [];
		for (let i = 1; i < bars.length; i++) {
			const chg = bars[i].close - bars[i - 1].close;
			gains.push(Math.max(0, chg));
			losses.push(Math.max(0, -chg));
		}
		const avgG = rma(gains, period);
		const avgL = rma(losses, period);
		const out = [];
		for (let i = 0; i < gains.length; i++) {
			const g = avgG[i];
			const l = avgL[i];
			if (g === void 0 || l === void 0) continue;
			const v = l === 0 ? 100 : 100 - 100 / (1 + g / l);
			out.push({
				time: bars[i + 1].time,
				value: v
			});
		}
		return out;
	}
	function stoch(bars, kPeriod = 9, kSmooth = 3, dPeriod = 3) {
		const rsv = [];
		for (let i = kPeriod - 1; i < bars.length; i++) {
			let hi = -Infinity;
			let lo = Infinity;
			for (let j = i - kPeriod + 1; j <= i; j++) {
				hi = Math.max(hi, bars[j].high);
				lo = Math.min(lo, bars[j].low);
			}
			const range = hi - lo;
			rsv.push({
				time: bars[i].time,
				value: range === 0 ? 50 : (bars[i].close - lo) / range * 100
			});
		}
		const k = smaOf(rsv, kSmooth);
		return {
			k,
			d: smaOf(k, dPeriod)
		};
	}
	function smaOf(points, period) {
		const out = [];
		let sum = 0;
		const vals = [];
		for (const p of points) {
			if (p.value === void 0) continue;
			vals.push(p.value);
			sum += p.value;
			if (vals.length > period) sum -= vals[vals.length - period - 1];
			if (vals.length >= period) out.push({
				time: p.time,
				value: sum / period
			});
		}
		return out;
	}
	//#endregion
	//#region src/lib/trend-signal/risk/plan.ts
	function decimalsOf(tick) {
		const s = String(tick);
		const exp = /e-(\d+)$/.exec(s);
		if (exp) return Number(exp[1]);
		const i = s.indexOf(".");
		return i < 0 ? 0 : Math.min(8, s.length - i - 1);
	}
	var EPS = 1e-9;
	var fix = (v, tick) => Number(v.toFixed(decimalsOf(tick)));
	var floorTick = (p, tick) => fix(Math.floor(p / tick + EPS) * tick, tick);
	var ceilTick = (p, tick) => fix(Math.ceil(p / tick - EPS) * tick, tick);
	/** 往不利方向取整（多單停損往下、空單往上）— 不為了風控把停損移近 */
	var awayTick = (dir, p, tick) => dir === "LONG" ? floorTick(p, tick) : ceilTick(p, tick);
	/** 往有利方向取整（目標至少 k×R） */
	var towardTick = (dir, p, tick) => dir === "LONG" ? ceilTick(p, tick) : floorTick(p, tick);
	/** 最近 n 根已收 K 棒（結尾 m；1m 或 5m，依 stopTf）內的確認擺動低點（多）／高點（空）：
	*  左鄰嚴格較高（低）、右鄰不低於（不高於），右鄰必須也已收 → k ≤ m − 1。
	*  多個時取最低（最高），即最保守的結構失效點。 */
	function swingPoint(bars, m, n, dir) {
		let best;
		for (let k = m - 1; k >= Math.max(1, m - n + 1); k--) {
			const cur = bars[k];
			const left = bars[k - 1];
			const right = bars[k + 1];
			if (dir === "LONG") {
				if (cur.low < left.low && cur.low <= right.low) best = best === void 0 ? cur.low : Math.min(best, cur.low);
			} else if (cur.high > left.high && cur.high >= right.high) best = best === void 0 ? cur.high : Math.max(best, cur.high);
		}
		return best;
	}
	/** 單邊期交稅（新臺幣，元以下四捨五入）：契約價值 × 稅率 */
	function futuresTax(price, pointValue, taxRate, qty = 1) {
		return taxRate > 0 ? Math.round(price * pointValue * qty * taxRate) : 0;
	}
	/** 單口來回成本（新臺幣）：手續費兩邊 + 滑價緩衝兩邊 + 期交稅兩邊（以進場價估） */
	function roundTripCost(cfg, tick, pointValue, price = 0, taxRate = 0) {
		return 2 * cfg.feePerSide + 2 * cfg.slipTicks * tick * pointValue + 2 * futuresTax(price, pointValue, taxRate);
	}
	/** 依口數分配 2R／3R／追蹤三層（整數、加總等於口數、不產生零口以外的負數） */
	function allocateTiers(qty, cfg) {
		if (qty <= 0) return {
			r2: 0,
			r3: 0,
			trail: 0
		};
		if (qty === 1) {
			if (cfg.singleExit === 2) return {
				r2: 1,
				r3: 0,
				trail: 0
			};
			if (cfg.singleExit === 3) return {
				r2: 0,
				r3: 1,
				trail: 0
			};
			return {
				r2: 0,
				r3: 0,
				trail: 1
			};
		}
		if (cfg.tierMode === "custom") {
			const r2 = Math.min(Math.max(0, cfg.tp2Lots), qty);
			const r3 = Math.min(Math.max(0, cfg.tp3Lots), qty - r2);
			return {
				r2,
				r3,
				trail: qty - r2 - r3
			};
		}
		if (qty === 2) return {
			r2: 1,
			r3: 0,
			trail: 1
		};
		if (qty === 3) return {
			r2: 1,
			r3: 1,
			trail: 1
		};
		const r2 = Math.floor(qty / 3);
		const r3 = Math.floor(qty / 3);
		return {
			r2,
			r3,
			trail: qty - r2 - r3
		};
	}
	/** 初始停損（多）＝ min(擺動低點 − 1 tick, 進場 − stopAtr × ATR)，擺動點與 ATR 取 stopTf 週期；空單鏡像。
	*  R 由進場價與初始停損決定，之後不再改變。 */
	function planRisk(inp) {
		const { direction: dir, entry, tick, cfg } = inp;
		const sign = dir === "LONG" ? 1 : -1;
		const requestedQty = inp.fixedQty ?? cfg.qty;
		const base = {
			status: "REJECTED_RISK",
			direction: dir,
			entry,
			entryBasis: inp.entryBasis,
			stop: NaN,
			stopBasis: "atr-fallback",
			swing: inp.swing,
			atrStop: NaN,
			riskPoints: NaN,
			r1: NaN,
			r2: NaN,
			r3: NaN,
			breakevenStop: NaN,
			costPoints: NaN,
			tick,
			pointValue: inp.pointValue ?? NaN,
			requestedQty,
			qty: 0,
			riskPerLot: NaN,
			totalRisk: NaN,
			budget: cfg.budget,
			overBudget: false,
			tiers: {
				r2: 0,
				r3: 0,
				trail: 0
			}
		};
		if (!(tick > 0) || !Number.isFinite(entry)) return {
			...base,
			reason: "價格或跳動點資料無效"
		};
		if (inp.pointValue === null || !(inp.pointValue > 0)) return {
			...base,
			reason: "商品每點價值未知，無法換算新臺幣風險"
		};
		if (inp.atr === void 0 || !(inp.atr > 0)) return {
			...base,
			reason: "ATR 資料不足，無法計算停損"
		};
		const atrStop = entry - sign * cfg.stopAtr * inp.atr;
		let raw = atrStop;
		let basis = "atr-fallback";
		if (inp.swing !== void 0) {
			const swingStop = inp.swing - sign * tick;
			raw = dir === "LONG" ? Math.min(swingStop, atrStop) : Math.max(swingStop, atrStop);
			basis = raw === swingStop ? "swing" : "atr";
		}
		const stop = awayTick(dir, raw, tick);
		const riskPoints = fix(sign * (entry - stop), tick);
		if (!(riskPoints > 0)) return {
			...base,
			atrStop,
			stop,
			stopBasis: basis,
			reason: "停損不在進場價的保護側"
		};
		const pv = inp.pointValue;
		const cost = roundTripCost(cfg, tick, pv, entry, inp.taxRate ?? 0);
		const costPoints = cost / pv;
		const riskPerLot = riskPoints * pv + cost;
		const affordable = Math.floor(cfg.budget / riskPerLot + EPS);
		const qty = inp.fixedQty ?? Math.max(0, Math.min(requestedQty, affordable));
		const plan = {
			...base,
			stop,
			stopBasis: basis,
			atrStop,
			riskPoints,
			r1: towardTick(dir, entry + sign * riskPoints, tick),
			r2: towardTick(dir, entry + sign * 2 * riskPoints, tick),
			r3: towardTick(dir, entry + sign * 3 * riskPoints, tick),
			breakevenStop: towardTick(dir, entry + sign * costPoints, tick),
			costPoints,
			qty,
			riskPerLot,
			totalRisk: riskPerLot * qty,
			overBudget: riskPerLot * qty > cfg.budget + EPS
		};
		if (qty < 1) return {
			...plan,
			qty: 0,
			totalRisk: riskPerLot,
			reason: `單口預估風險 NT$${Math.round(riskPerLot).toLocaleString("en-US")} 超過預算 NT$${cfg.budget.toLocaleString("en-US")}`
		};
		return {
			...plan,
			status: "OK",
			tiers: allocateTiers(qty, cfg)
		};
	}
	/** 移動停損（多）：max(舊停損, 5m 趨勢線支撐 − 1 tick, 入場後最高價 − trailAtr × 5m ATR)。
	*  趨勢線只在它是翻轉價位的演算法（SuperTrend、Donchian＋ATR）參與；缺少的來源不參與，
	*  全部缺少時不更新。空單用 min 鏡像。 */
	function trailStop(dir, current, stSupport, extreme, atr5, tick, trailAtr) {
		const sign = dir === "LONG" ? 1 : -1;
		const cands = [];
		if (stSupport !== void 0) cands.push(stSupport - sign * tick);
		if (atr5 !== void 0 && atr5 > 0) cands.push(extreme - sign * trailAtr * atr5);
		let next = current;
		for (const c of cands) {
			const v = awayTick(dir, c, tick);
			next = dir === "LONG" ? Math.max(next, v) : Math.min(next, v);
		}
		return next;
	}
	//#endregion
	//#region src/lib/trend-signal/risk/virtual.ts
	function exitText$1(reason) {
		switch (reason) {
			case "STOP": return "初始停損";
			case "BREAKEVEN_STOP": return "保本停損";
			case "TRAIL_STOP": return "移動停損";
			case "TP2R": return "2R 停利";
			case "TP3R": return "3R 停利";
			case "REVERSAL": return "5m 反轉平倉";
			case "TREND_INVALID": return "5m 失效平倉";
		}
	}
	/** 成交發生在 1m K 棒（收盤 label）的哪裡：開盤＝label − 60 那一刻；盤中＝label − 60 到 label 之間 */
	function fillWhen(label, at) {
		return at === "open" ? `${wallHm(label - 60)} 開盤` : `${wallHm(label - 60)}–${wallHm(label)} 盤中`;
	}
	var dirWord = (d) => d === "LONG" ? "多" : "空";
	function runVirtual(inp) {
		const { m1, m5, t5, cfg, tick } = inp;
		const openTime = inp.clock?.openTime ?? ((t) => t - 60);
		const baseLabel = inp.clock?.baseLabel ?? "1m";
		const trendLabel = inp.clock?.trendLabel ?? "5m";
		const clockText = baseLabel.startsWith("1D") ? wallTime : wallHm;
		const when = (t, at) => inp.clock ? at === "open" ? `${clockText(openTime(t))} ${baseLabel}開盤` : `${clockText(openTime(t))}–${clockText(t)} ${baseLabel}棒內` : fillWhen(t, at);
		const reasonText = (reason) => exitText$1(reason).replace("5m", trendLabel);
		const slip = cfg.slipTicks * tick;
		const atr1 = alignPoints(m1, atr(m1, 14));
		const atr5 = alignPoints(m5.bars, atr(m5.bars, 14));
		const signalAtIndex = new Map(inp.signals.map((s) => [s.index, s]));
		const invalidAtIndex = new Map(inp.invalidations.map((v) => [v.index, v]));
		const queue = [...inp.entries].sort((a, b) => a.barTime - b.barTime);
		let q = 0;
		const events = [];
		const log = (time, kind, ref, text) => events.push({
			time,
			kind,
			ref,
			text
		});
		const trades = [];
		let trade = null;
		let pendingEntry = null;
		let pendingExit = null;
		let pendingStop = null;
		const better = (dir, a, b) => dir === "LONG" ? Math.max(a, b) : Math.min(a, b);
		const queueStop = (stop, reason) => {
			if (!trade) return;
			const base = pendingStop?.stop ?? trade.stop;
			if (better(trade.direction, base, stop) === base) return;
			pendingStop = {
				stop,
				reason
			};
		};
		const closeQty = (t, price, qty, reason, at) => {
			if (!trade || qty <= 0) return;
			const sign = trade.direction === "LONG" ? 1 : -1;
			const n = Math.min(qty, trade.openQty);
			const pv = trade.plan.pointValue;
			const previouslyClosedQty = trade.qty - trade.openQty;
			trade.fills.push({
				time: t,
				at,
				price,
				qty: n,
				reason
			});
			trade.openQty -= n;
			const points = sign * (price - trade.fillPrice) * n;
			trade.realizedPoints += points;
			const entryTax = futuresTax(trade.fillPrice, pv, inp.taxRate, previouslyClosedQty + n) - futuresTax(trade.fillPrice, pv, inp.taxRate, previouslyClosedQty);
			const cost = 2 * cfg.feePerSide * n + entryTax + futuresTax(price, pv, inp.taxRate, n);
			trade.costNtd += cost;
			trade.realizedNtd += points * pv - cost;
			log(at === "open" ? openTime(t) : t, "EXIT", trade.id, `${reasonText(reason)} ${n} 口 @ ${price}（${when(t, at)}）`);
			if (trade.openQty === 0) {
				trade.status = "CLOSED";
				trade.exitReason = reason;
				trade.closedAt = t;
				trade = null;
				pendingExit = null;
				pendingStop = null;
			}
		};
		const activate = (upTo, inclusive) => {
			while (q < queue.length) {
				const e = queue[q];
				const bt = e.barTime;
				if (inclusive ? bt > upTo : bt >= upTo) break;
				q++;
				if (pendingEntry) {
					log(bt, "WARN", e.id, "已有待成交的虛擬進場，略過這次提示");
					continue;
				}
				if (trade && !pendingExit) {
					log(bt, "WARN", e.id, "已有虛擬部位，略過這次提示（不加碼）");
					continue;
				}
				const idx = lastAtOrBefore(m1, bt);
				const j5 = cfg.stopTf === 5 ? lastAtOrBefore(m5.bars, bt) : -1;
				const swing = cfg.stopTf === 5 ? j5 >= 1 ? swingPoint(m5.bars, j5, cfg.swingBars, e.direction) : void 0 : idx >= 1 ? swingPoint(m1, idx, cfg.swingBars, e.direction) : void 0;
				const a = cfg.stopTf === 5 ? j5 >= 0 ? atr5[j5] : void 0 : idx >= 0 ? atr1[idx] : void 0;
				const plan = planRisk({
					direction: e.direction,
					entry: e.refPrice,
					entryBasis: "estimate",
					swing,
					atr: a,
					tick,
					pointValue: inp.pointValue,
					taxRate: inp.taxRate,
					cfg
				});
				if (plan.status !== "OK" || a === void 0 || idx < 0) {
					log(bt, "WARN", e.id, `${e.mode} 提示被風控拒絕：${plan.reason ?? `${baseLabel} ATR 不足`}`);
					continue;
				}
				pendingEntry = {
					entry: e,
					plan,
					swing,
					atr: a,
					sessionEnd: inp.m1SessionEnd[idx]
				};
				log(bt, "PLAN", e.id, `${e.mode} 第 ${e.seq} 次${dirWord(e.direction)}單提示（${e.reason}），待下一根 ${baseLabel} 開盤虛擬成交（觀察模式不送單）`);
			}
		};
		const process5m = (j) => {
			const bar = m5.bars[j];
			const sig = signalAtIndex.get(j);
			const inv = invalidAtIndex.get(j);
			if (trade && sig && trade.direction !== sig.direction) {
				pendingExit = {
					ref: sig.id,
					reason: "REVERSAL"
				};
				log(bar.time, "WARN", trade.id, `${trendLabel} 確認反向 ${sig.kind}：下一根 ${baseLabel} 開盤平${dirWord(trade.direction)}${inp.clock ? "" : "（不等 1m）"}`);
			} else if (trade && inv && inv.from === trade.direction) {
				pendingExit = {
					ref: inv.id,
					reason: "TREND_INVALID"
				};
				log(bar.time, "WARN", trade.id, `${trendLabel} ${dirWord(inv.from)}方趨勢失效（NEUTRAL）：下一根 ${baseLabel} 開盤平${dirWord(trade.direction)}${inp.clock ? "" : "（不等 1m）"}`);
			}
			if (trade && trade.trailing && !pendingExit) {
				const dir = trade.direction;
				const support = t5.stopLine && t5.dir[j] === dir ? t5.line[j] : void 0;
				const next = trailStop(dir, pendingStop?.stop ?? trade.stop, support, trade.extreme, atr5[j], tick, cfg.trailAtr);
				queueStop(next, "trail");
				const through = dir === "LONG" ? next >= bar.close : next <= bar.close;
				if (pendingStop?.reason === "trail" && pendingStop.stop === next && through) log(bar.time, "WARN", trade.id, `移動停損 ${next} 已在 ${trendLabel} 收盤 ${bar.close} 的錯誤一側：不建立觸價單，下一根開盤立即處理`);
			}
		};
		const openAt = (t, open) => {
			if (trade && pendingExit) closeQty(t, trade.direction === "LONG" ? open - slip : open + slip, trade.openQty, pendingExit.reason, "open");
			if (pendingEntry && !trade) {
				const pe = pendingEntry;
				pendingEntry = null;
				if (inp.clock ? openTime(t) >= pe.sessionEnd : t > pe.sessionEnd) log(openTime(t), "WARN", pe.entry.id, "進場成交 K 棒已跨到下一盤，取消（不跨盤進場）");
				else if (inp.clock ? !inp.clock.isNext(pe.entry.barTime, t) : t !== pe.entry.barTime + 60) log(openTime(t), "WARN", pe.entry.id, `下一根 ${baseLabel} 缺資料，取消虛擬進場（不延後到下一根現存 K 棒）`);
				else {
					const dir = pe.entry.direction;
					const fill = dir === "LONG" ? open + slip : open - slip;
					const plan = planRisk({
						direction: dir,
						entry: fill,
						entryBasis: "fill",
						swing: pe.swing,
						atr: pe.atr,
						tick,
						pointValue: inp.pointValue,
						taxRate: inp.taxRate,
						cfg,
						fixedQty: pe.plan.qty
					});
					if (plan.status !== "OK") log(openTime(t), "WARN", pe.entry.id, `成交價 ${fill} 無法重新定價（${plan.reason ?? "風控拒絕"}），虛擬單取消`);
					else {
						const vt = {
							id: `${pe.entry.id}|VT#${inp.key}`,
							entryId: pe.entry.id,
							entryMode: pe.entry.mode,
							signalId: pe.entry.signalId,
							direction: dir,
							signalTime: pe.entry.barTime,
							fillTime: t,
							fillAt: openTime(t),
							fillPrice: fill,
							plan,
							qty: plan.qty,
							openQty: plan.qty,
							stop: plan.stop,
							stopKind: "initial",
							stopHistory: [{
								time: t,
								stop: plan.stop,
								reason: "initial"
							}],
							trailing: false,
							hit: {
								r1: null,
								r2: null,
								r3: null
							},
							extreme: fill,
							fills: [],
							status: "OPEN",
							exitReason: null,
							closedAt: null,
							realizedPoints: 0,
							costNtd: 0,
							realizedNtd: 0,
							warnings: []
						};
						if (plan.overBudget) vt.warnings.push(`成交價重新定價後預估風險 NT$${Math.round(plan.totalRisk)} 超過預算 NT$${cfg.budget}`);
						trades.push(vt);
						trade = vt;
						log(openTime(t), "FILL", vt.id, `虛擬${dirWord(dir)}單 ${plan.qty} 口 @ ${fill}（${when(t, "open")}；${clockText(pe.entry.barTime)} 收棒的提示），停損 ${plan.stop}，R ${plan.riskPoints} 點`);
						for (const w of vt.warnings) log(openTime(t), "WARN", vt.id, w);
					}
				}
			}
			if (trade && pendingStop) {
				trade.stop = pendingStop.stop;
				trade.stopKind = pendingStop.reason;
				trade.stopHistory.push({
					time: t,
					stop: pendingStop.stop,
					reason: pendingStop.reason
				});
				log(openTime(t), "STOP_MOVE", trade.id, `${pendingStop.reason === "breakeven" ? "保本" : "移動"}停損 → ${pendingStop.stop}（${clockText(openTime(t))} 開盤起生效）`);
				pendingStop = null;
			}
		};
		const stopCheck = (t, bar) => {
			if (!trade) return;
			const long = trade.direction === "LONG";
			if (long ? bar.low > trade.stop : bar.high < trade.stop) return;
			const gapped = long ? bar.open <= trade.stop : bar.open >= trade.stop;
			const px = long ? Math.min(trade.stop, bar.open) - slip : Math.max(trade.stop, bar.open) + slip;
			const reason = trade.stopKind === "initial" ? "STOP" : trade.stopKind === "breakeven" ? "BREAKEVEN_STOP" : "TRAIL_STOP";
			closeQty(t, px, trade.openQty, reason, gapped ? "open" : "intrabar");
		};
		const targetCheck = (t, bar) => {
			if (!trade) return;
			const vt = trade;
			const long = vt.direction === "LONG";
			vt.extreme = long ? Math.max(vt.extreme, bar.high) : Math.min(vt.extreme, bar.low);
			const reached = (level) => long ? bar.high >= level : bar.low <= level;
			const p = vt.plan;
			if (vt.hit.r1 === null && reached(p.r1)) {
				vt.hit.r1 = t;
				log(t, "TARGET", vt.id, `+1R ${p.r1} 到價：停損移至保本 ${p.breakevenStop}（下一根生效）`);
				queueStop(p.breakevenStop, "breakeven");
			}
			if (vt.hit.r2 === null && reached(p.r2)) {
				vt.hit.r2 = t;
				vt.trailing = true;
				log(t, "TARGET", vt.id, `+2R ${p.r2} 到價：啟動移動停損`);
				if (p.tiers.r2 > 0) closeQty(t, p.r2, p.tiers.r2, "TP2R", "intrabar");
			}
			if (trade === vt && vt.hit.r3 === null && reached(p.r3)) {
				vt.hit.r3 = t;
				log(t, "TARGET", vt.id, `+3R ${p.r3} 到價`);
				if (p.tiers.r3 > 0) closeQty(t, p.r3, p.tiers.r3, "TP3R", "intrabar");
			}
		};
		let next5 = 0;
		for (const bar of m1) {
			const t = bar.time;
			while (next5 < m5.bars.length && m5.bars[next5].time < t) process5m(next5++);
			activate(t, false);
			openAt(t, bar.open);
			stopCheck(t, bar);
			targetCheck(t, bar);
			while (next5 < m5.bars.length && m5.bars[next5].time === t) process5m(next5++);
			activate(t, true);
		}
		while (next5 < m5.bars.length) process5m(next5++);
		activate(inp.asOf, true);
		const live = inp.live;
		const lastConfirmed = m1[m1.length - 1]?.time ?? -Infinity;
		if (live && live.time > inp.asOf && live.time > lastConfirmed) {
			openAt(live.time, live.open);
			stopCheck(live.time, live);
		}
		const open = trade;
		const pe = pendingEntry;
		const px = pendingExit;
		return {
			trades,
			events,
			open,
			pendingEntry: pe ? {
				entry: pe.entry,
				plan: pe.plan
			} : null,
			pendingExit: px && open ? px : null
		};
	}
	//#endregion
	//#region src/lib/trend-signal/trend/mtf.ts
	function tfAt(series, track, t) {
		const index = lastAtOrBefore(series.bars, t);
		const barTime = index >= 0 ? series.bars[index].time : null;
		return {
			index,
			state: index >= 0 ? track.dir[index] : "UNKNOWN",
			barTime,
			stale: !freshAt(barTime, t, series.tf),
			incomplete: index >= 0 && series.missing[index] > 0
		};
	}
	//#endregion
	//#region src/lib/trend-signal/trend/algorithms.ts
	var SUPERTREND = {
		id: "supertrend",
		label: "SuperTrend",
		stopLine: true,
		warmup: (p) => 15 * p.stPeriod,
		compute: (bars, p) => {
			const r = supertrend(bars, p.stPeriod, p.stMult);
			const line = new Array(bars.length);
			const dir = new Array(bars.length);
			for (let i = 0; i < bars.length; i++) {
				const u = r.up[i]?.value;
				const d = r.down[i]?.value;
				line[i] = u ?? d;
				dir[i] = u !== void 0 ? 1 : d !== void 0 ? -1 : null;
			}
			return {
				line,
				dir
			};
		}
	};
	var DONCHIAN = {
		id: "donchian",
		label: "Donchian＋ATR",
		stopLine: true,
		warmup: (p) => p.dcLength + 120,
		compute: (bars, p) => {
			const n = Math.max(2, Math.round(p.dcLength));
			const k = p.dcAtrMult;
			const a = alignPoints(bars, atr(bars, 14));
			const line = new Array(bars.length);
			const dir = new Array(bars.length);
			let state = null;
			let band = 0;
			for (let i = 0; i < bars.length; i++) {
				const av = a[i];
				if (i < n || av === void 0) {
					line[i] = void 0;
					dir[i] = null;
					continue;
				}
				let hh = -Infinity;
				let ll = Infinity;
				let top = -Infinity;
				let bottom = Infinity;
				for (let j = i - n; j <= i; j++) {
					const x = bars[j];
					if (j < i) {
						hh = Math.max(hh, x.high);
						ll = Math.min(ll, x.low);
					}
					if (j > i - n) {
						top = Math.max(top, x.high);
						bottom = Math.min(bottom, x.low);
					}
				}
				const c = bars[i].close;
				if (c > hh && state !== 1) {
					state = 1;
					band = top - k * av;
				} else if (c < ll && state !== -1) {
					state = -1;
					band = bottom + k * av;
				} else if (state === 1) band = Math.max(band, top - k * av);
				else if (state === -1) band = Math.min(band, bottom + k * av);
				else state = 0;
				if (state === 1 && c < band || state === -1 && c > band) state = 0;
				dir[i] = state;
				line[i] = state === 1 || state === -1 ? band : void 0;
			}
			return {
				line,
				dir
			};
		}
	};
	/** Kaufman 自適應均線：效率比高（趨勢）時接近快速 EMA，低（盤整）時接近慢速 */
	function kamaLine(bars, n, fast, slow) {
		const fc = 2 / (fast + 1);
		const sc = 2 / (slow + 1);
		const out = new Array(bars.length);
		let k = bars[0]?.close ?? 0;
		for (let i = 0; i < bars.length; i++) {
			const c = bars[i].close;
			if (i < n) {
				k = c;
				out[i] = void 0;
				continue;
			}
			const change = Math.abs(c - bars[i - n].close);
			let vol = 0;
			for (let j = i - n + 1; j <= i; j++) vol += Math.abs(bars[j].close - bars[j - 1].close);
			const s2 = ((vol > 0 ? change / vol : 0) * (fc - sc) + sc) ** 2;
			k = k + s2 * (c - k);
			out[i] = k;
		}
		return out;
	}
	var ALGORITHMS = {
		supertrend: SUPERTREND,
		donchian: DONCHIAN,
		kama: {
			id: "kama",
			label: "KAMA",
			stopLine: false,
			warmup: (p) => 5 * p.kamaSlow,
			compute: (bars, p) => {
				const kl = kamaLine(bars, p.kamaLength, p.kamaFast, p.kamaSlow);
				const a = alignPoints(bars, atr(bars, 14));
				const dir = new Array(bars.length);
				let d = 0;
				let hi = 0;
				let lo = 0;
				for (let i = 0; i < bars.length; i++) {
					const k = kl[i];
					const av = a[i];
					if (k === void 0 || av === void 0) {
						dir[i] = null;
						continue;
					}
					if (d === 0) {
						const prev = i > 0 ? kl[i - 1] : void 0;
						d = prev !== void 0 && k < prev ? -1 : 1;
						hi = k;
						lo = k;
					} else if (d === 1) {
						hi = Math.max(hi, k);
						if (k < hi - p.kamaHyst * av) {
							d = -1;
							lo = k;
						}
					} else {
						lo = Math.min(lo, k);
						if (k > lo + p.kamaHyst * av) {
							d = 1;
							hi = k;
						}
					}
					dir[i] = d;
				}
				return {
					line: kl,
					dir
				};
			}
		}
	};
	//#endregion
	//#region src/lib/trend-signal/trend/signals.ts
	/** 某週期的趨勢線與狀態；自資料起點的暖身根數內一律 UNKNOWN，NEUTRAL 沒有線 */
	function trendTrack(series, p) {
		const algo = ALGORITHMS[p.algo];
		const raw = algo.compute(series.bars, p);
		const warm = algo.warmup(p);
		const dir = raw.dir.map((d, i) => i < warm || d === null ? "UNKNOWN" : d === 1 ? "LONG" : d === -1 ? "SHORT" : "NEUTRAL");
		const line = raw.line.map((v, i) => dir[i] === "LONG" || dir[i] === "SHORT" ? v : void 0);
		return {
			tf: series.tf,
			algo: p.algo,
			line,
			dir,
			stopLine: algo.stopLine
		};
	}
	/** BUY = 已收棒狀態由 SHORT／NEUTRAL 轉 LONG；SELL 鏡像。前一根 UNKNOWN（暖身）時
	*  不知道之前的狀態，不算切換 — 否則暖身結束、資料起點不同都會憑空多出訊號。 */
	function switchAt(dir, i) {
		if (i < 1) return null;
		const prev = dir[i - 1];
		const cur = dir[i];
		if (prev === void 0 || prev === "UNKNOWN" || prev === cur) return null;
		if (cur === "LONG") return "BUY";
		if (cur === "SHORT") return "SELL";
		return null;
	}
	/** 趨勢失效：LONG／SHORT → NEUTRAL（只有會輸出 NEUTRAL 的演算法才有）；不是 BUY／SELL */
	function invalidAt(dir, i) {
		if (i < 1 || dir[i] !== "NEUTRAL") return null;
		const prev = dir[i - 1];
		return prev === "LONG" || prev === "SHORT" ? prev : null;
	}
	/** 高週期與 5m 的關係：同向 ALIGN、反向 DIVERGE；任一方沒有方向（NEUTRAL／UNKNOWN）為 NEUTRAL */
	function alignmentOf(htf, m5) {
		const known = (d) => d === "LONG" || d === "SHORT";
		if (!known(htf) || !known(m5)) return "NEUTRAL";
		return htf === m5 ? "ALIGN" : "DIVERGE";
	}
	/** 第 i 根的狀態已持續幾根（含 i）；UNKNOWN 為 null */
	function trendAge(dir, i) {
		const d = dir[i];
		if (i < 0 || d === void 0 || d === "UNKNOWN") return null;
		let j = i;
		while (j > 0 && dir[j - 1] === d) j--;
		return i - j + 1;
	}
	/** 最近 n 根已收 K 棒（含 i）的最高價與最低價 */
	function keyLevels(bars, i, n) {
		if (i < 0) return null;
		let high = -Infinity;
		let low = Infinity;
		for (let j = Math.max(0, i - n + 1); j <= i; j++) {
			high = Math.max(high, bars[j].high);
			low = Math.min(low, bars[j].low);
		}
		return Number.isFinite(high) && Number.isFinite(low) ? {
			high,
			low
		} : null;
	}
	/** 收盤對 EMA 與 EMA 斜率是否與訊號同向（舊規格 §1.1 的條件，只當註記） */
	function emaNote(bars, emaV, i, kind, slopeBars) {
		const e = emaV[i];
		const ePrev = i >= slopeBars ? emaV[i - slopeBars] : void 0;
		if (e === void 0 || ePrev === void 0) return "UNKNOWN";
		const c = bars[i].close;
		const up = c > e && e > ePrev;
		const down = c < e && e < ePrev;
		if (kind === "BUY") return up ? "WITH" : down ? "AGAINST" : "MIXED";
		return down ? "WITH" : up ? "AGAINST" : "MIXED";
	}
	function emaSeries(bars, p) {
		return alignPoints(bars, ema(bars, p.emaPeriod));
	}
	function rsiSeries(bars, p) {
		return alignPoints(bars, rsi(bars, p.rsiPeriod));
	}
	//#endregion
	//#region src/lib/trend-signal/trigger/window.ts
	/** 只讀已確認的 5m 狀態：段落的結束點是 5m 收棒時就已知的事實，不含未來資訊 */
	function trendSegment(sig, inp) {
		const { m1, m5, dir5 } = inp;
		let k = sig.index + 1;
		while (k < m5.length && dir5[k] === sig.direction) k++;
		const endedAt = k < m5.length ? m5[k].time : null;
		const windowEnd = inp.windowBars > 0 ? Math.min(inp.chartMinutes === void 0 ? sig.barTime + inp.windowBars * 300 : m5[sig.index + inp.windowBars]?.time ?? Infinity, sig.sessionEnd) : Number.POSITIVE_INFINITY;
		const bars = [];
		let j = sig.index;
		for (let m = firstAfter(m1, sig.barTime); m < m1.length; m++) {
			const t = m1[m].time;
			if (endedAt !== null && t >= endedAt || t > windowEnd) break;
			while (j + 1 < m5.length && m5[j + 1].time <= t) j++;
			if (!freshAt(m5[j].time, t, inp.chartMinutes ?? 5) || t >= inp.m1SessionEnd[m] || inp.m1Hole[m]) continue;
			bars.push(m);
		}
		return {
			signal: sig,
			bars,
			endedAt,
			endState: endedAt !== null ? dir5[k] : null,
			windowEnd
		};
	}
	/** 段落在 asOf 已不再提示的原因；仍可提示為 null */
	function segmentClosed(seg, asOf, windowBars) {
		if (seg.endedAt !== null && seg.endedAt <= asOf) {
			if (seg.endState === "NEUTRAL") return "5m 趨勢失效（NEUTRAL），停止提示";
			if (seg.endState === "UNKNOWN") return "5m 狀態未知，停止提示";
			return "5m 已反向，停止提示";
		}
		if (seg.windowEnd <= asOf) return `已過翻轉後 ${windowBars} 根 5m（post-flip 窗口）`;
		return null;
	}
	/** 提示 ID：所屬 5m 訊號＋模式＋觸發 1m 時間＋進場參數指紋 */
	function hintEvent(seg, mode, key, seq, barTime, refPrice, reason) {
		const sig = seg.signal;
		return {
			id: `${sig.id}|${mode}|${wallIso(barTime)}#${key}`,
			kind: sig.direction === "LONG" ? "POTENTIAL_ENTRY_LONG" : "POTENTIAL_ENTRY_SHORT",
			mode,
			signalId: sig.id,
			direction: sig.direction,
			barTime,
			refPrice,
			seq,
			reason
		};
	}
	//#endregion
	//#region src/lib/trend-signal/trigger/modes.ts
	var STATE_WORD = {
		LONG: "多",
		SHORT: "空",
		NEUTRAL: "中性",
		UNKNOWN: "未知"
	};
	function immediateHints(seg, key) {
		const sig = seg.signal;
		if (sig.barTime >= sig.sessionEnd) return {
			hints: [],
			waiting: "訊號在該盤最後一根 5m，不跨盤進場"
		};
		return {
			hints: [hintEvent(seg, "IMMEDIATE", key, 1, sig.barTime, sig.close, "5m 收棒立即（比較基準）")],
			waiting: "每段 5m 趨勢只提示一次"
		};
	}
	function microTrendHints(seg, m1, micro, key) {
		const want = seg.signal.direction;
		const hints = [];
		for (const m of seg.bars) {
			const prev = micro[m - 1];
			if (micro[m] !== want || prev === void 0 || prev === want || prev === "UNKNOWN") continue;
			const bar = m1[m];
			hints.push(hintEvent(seg, "MICRO_TREND", key, hints.length + 1, bar.time, bar.close, `1m 微型趨勢由${STATE_WORD[prev]}轉${STATE_WORD[want]}`));
		}
		const last = seg.bars[seg.bars.length - 1];
		const cur = last !== void 0 ? micro[last] : void 0;
		return {
			hints,
			waiting: cur === void 0 || cur === "UNKNOWN" ? "等待 1m 微型趨勢" : cur === want ? "1m 已同向；等待回檔（反向或中性）後再轉回同向" : "1m 回檔中；等待轉回同向"
		};
	}
	/** 已確認轉折：左側 left 根嚴格較低（高）、右側 right 根不高於（不低於）。
	*  bars 只含已收 K 棒，所以每個轉折都在 confirm 那根收盤時才成立。 */
	function pivots(bars, left, right, kind) {
		const out = [];
		for (let j = left; j + right < bars.length; j++) {
			const v = kind === "high" ? bars[j].high : bars[j].low;
			let ok = true;
			for (let k = j - left; k < j && ok; k++) {
				const x = kind === "high" ? bars[k].high : bars[k].low;
				ok = kind === "high" ? v > x : v < x;
			}
			for (let k = j + 1; k <= j + right && ok; k++) {
				const x = kind === "high" ? bars[k].high : bars[k].low;
				ok = kind === "high" ? v >= x : v <= x;
			}
			if (ok) out.push({
				index: j,
				price: v,
				confirm: j + right
			});
		}
		return out;
	}
	/** 最後一個 confirm ≤ m 的轉折索引（pivots 依 index 排序，confirm 同樣遞增）；沒有回 -1 */
	function lastConfirmed(ps, m) {
		let lo = 0;
		let hi = ps.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = lo + hi >> 1;
			if (ps[mid].confirm <= m) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return ans;
	}
	/** 已確認且 index < before 的最後一個轉折 */
	function latestBefore(ps, m, before) {
		for (let k = lastConfirmed(ps, m); k >= 0; k--) if (ps[k].index < before) return ps[k];
	}
	function priceStructureHints(seg, m1, atr1, highs, lows, p, key) {
		const long = seg.signal.direction === "LONG";
		const pull = long ? lows : highs;
		const start = long ? highs : lows;
		const hints = [];
		let after = seg.signal.barTime;
		let waiting = "等待 5m 訊號後的回檔轉折確認";
		let plIndex = -1;
		let broken = false;
		let scanned = -1;
		let topKey = "";
		let top = 0;
		for (const m of seg.bars) {
			const k = lastConfirmed(pull, m);
			const pl = k >= 0 ? pull[k] : void 0;
			if (!pl || !(m1[pl.index].time > after)) {
				waiting = hints.length > 0 ? "已提示；等待新的回檔轉折確認" : "等待 5m 訊號後的回檔轉折確認";
				continue;
			}
			if (pl.index !== plIndex) {
				plIndex = pl.index;
				broken = false;
				scanned = pl.index;
			}
			for (let q = scanned + 1; q <= m && !broken; q++) broken = long ? m1[q].close < pl.price : m1[q].close > pl.price;
			scanned = m;
			if (broken) {
				waiting = `回檔轉折 ${pl.price} 已被收盤${long ? "跌破" : "站上"}，等待新的回檔轉折`;
				continue;
			}
			const ph = latestBefore(start, m, pl.index);
			if (!ph) {
				waiting = "等待回檔起點（反向轉折）確認";
				continue;
			}
			if (topKey !== `${ph.index}:${pl.index}`) {
				topKey = `${ph.index}:${pl.index}`;
				top = long ? -Infinity : Infinity;
				for (let q = ph.index; q <= pl.index; q++) top = long ? Math.max(top, m1[q].high) : Math.min(top, m1[q].low);
			}
			const depth = long ? top - pl.price : pl.price - top;
			const a = atr1[m];
			if (a === void 0 || depth < p.minPullbackAtr * a) {
				waiting = "回檔深度不足";
				continue;
			}
			waiting = `回檔轉折 ${pl.price} 已確認，等待收盤${long ? "突破" : "跌破"} ${top}`;
			const c = m1[m].close;
			if (long ? c > top : c < top) {
				hints.push(hintEvent(seg, "PRICE_STRUCTURE", key, hints.length + 1, m1[m].time, c, `回檔轉折 ${pl.price} 確認後，收盤 ${c} ${long ? "突破" : "跌破"}回檔起點 ${top}`));
				after = m1[m].time;
				waiting = "已提示；等待新的回檔轉折確認";
			}
		}
		return {
			hints,
			waiting
		};
	}
	//#endregion
	//#region src/lib/trend-signal/trigger/pullback-kd.ts
	var PULLBACK_KD = {
		ema: 9,
		atr: 14,
		kdPeriod: 9,
		kdK: 3,
		kdD: 3,
		touchTol: .25,
		kdChase: 80,
		volumeFilter: false,
		volumeLookback: 20
	};
	/** 當盤 VWAP：每個交易時段（日盤／夜盤）重新累積，跨午夜不重設 */
	function sessionVwap(bars, session) {
		const out = [];
		let key = "";
		let pv = 0;
		let vol = 0;
		for (let i = 0; i < bars.length; i++) {
			const b = bars[i];
			if (session[i] !== key) {
				key = session[i];
				pv = 0;
				vol = 0;
			}
			if (b.volume > 0) {
				pv += (b.high + b.low + b.close) / 3 * b.volume;
				vol += b.volume;
			}
			out.push(vol > 0 ? pv / vol : void 0);
		}
		return out;
	}
	function kdIndicators(bars, session) {
		const kd = stoch(bars, PULLBACK_KD.kdPeriod, PULLBACK_KD.kdK, PULLBACK_KD.kdD);
		return {
			ema: alignPoints(bars, ema(bars, PULLBACK_KD.ema)),
			atr: alignPoints(bars, atr(bars, PULLBACK_KD.atr)),
			vwap: sessionVwap(bars, session),
			k: alignPoints(bars, kd.k),
			d: alignPoints(bars, kd.d)
		};
	}
	function touches(bar, level, tol) {
		return level !== void 0 && bar.low <= level + tol && bar.high >= level - tol;
	}
	/** 在已收 1m 索引 m 評估 dir 方向的回測確認條件 */
	function evalSetup(bars, ind, m, dir) {
		const none = {
			stage: "NO_DATA",
			touched: null,
			chase: false,
			volumeOk: true
		};
		if (m < 1) return none;
		const a = ind.atr[m];
		const e = ind.ema[m];
		const k = ind.k[m];
		const d = ind.d[m];
		const kPrev = ind.k[m - 1];
		const dPrev = ind.d[m - 1];
		if (a === void 0 || e === void 0 || k === void 0 || d === void 0 || kPrev === void 0 || dPrev === void 0) return none;
		const tol = PULLBACK_KD.touchTol * a;
		let byEma = false;
		let byVwap = false;
		for (const j of [m - 1, m]) {
			const b = bars[j];
			byEma || (byEma = touches(b, ind.ema[j], tol));
			byVwap || (byVwap = touches(b, ind.vwap[j], tol));
		}
		const touched = byEma && byVwap ? "BOTH" : byEma ? "EMA" : byVwap ? "VWAP" : null;
		const close = bars[m].close;
		const reclaim = dir === "LONG" ? close > e : close < e;
		const cross = dir === "LONG" ? k > d && kPrev <= dPrev : k < d && kPrev >= dPrev;
		const chase = PULLBACK_KD.kdChase < 100 && (dir === "LONG" ? k >= PULLBACK_KD.kdChase : k <= 100 - PULLBACK_KD.kdChase);
		let volumeOk = true;
		if (PULLBACK_KD.volumeFilter) {
			const from = m - PULLBACK_KD.volumeLookback;
			if (from < 0) volumeOk = false;
			else {
				let sum = 0;
				for (let j = from; j < m; j++) sum += bars[j].volume;
				volumeOk = bars[m].volume >= sum / PULLBACK_KD.volumeLookback;
			}
		}
		return {
			stage: !touched ? "WAIT_PULLBACK" : !reclaim ? "WAIT_RECLAIM" : !cross ? "WAIT_KD" : "READY",
			touched,
			chase,
			volumeOk
		};
	}
	function pullbackKdHints(seg, m1, ind, key) {
		const hints = [];
		for (const m of seg.bars) {
			const ev = evalSetup(m1, ind, m, seg.signal.direction);
			if (ev.stage !== "READY" || ev.chase || !ev.volumeOk) continue;
			const bar = m1[m];
			hints.push(hintEvent(seg, "PULLBACK_KD", key, hints.length + 1, bar.time, bar.close, `回測 ${ev.touched === "BOTH" ? "EMA9＋VWAP" : ev.touched === "EMA" ? "EMA9" : "VWAP"} 後站回且 KD 交叉（先前策略假說／未驗證）`));
		}
		return {
			hints,
			waiting: "等待回測 EMA9／VWAP 並 KD 交叉（先前策略假說／未驗證）"
		};
	}
	//#endregion
	//#region src/lib/trend-signal/trigger/entries.ts
	function computeEntries(inp) {
		const { signals, m1, p, asOf } = inp;
		if (signals.length === 0) return {
			entries: [],
			states: {}
		};
		const atr1 = alignPoints(m1, atr(m1, 14));
		const highs = pivots(m1, p.pivotLeft, p.pivotRight, "high");
		const lows = pivots(m1, p.pivotLeft, p.pivotRight, "low");
		const kd = p.mode === "PULLBACK_KD" ? kdIndicators(m1, inp.m1Session) : null;
		const entries = [];
		let seg = null;
		let latest = [];
		for (const sig of signals) {
			seg = trendSegment(sig, {
				m1,
				m1SessionEnd: inp.m1SessionEnd,
				m1Hole: inp.m1Hole,
				m5: inp.m5,
				dir5: inp.dir5,
				windowBars: p.windowBars,
				chartMinutes: inp.chartMinutes
			});
			latest = [
				["IMMEDIATE", immediateHints(seg, inp.key)],
				["MICRO_TREND", microTrendHints(seg, m1, inp.micro, inp.key)],
				["PRICE_STRUCTURE", priceStructureHints(seg, m1, atr1, highs, lows, p, inp.key)]
			];
			if (kd) latest.push(["PULLBACK_KD", pullbackKdHints(seg, m1, kd, inp.key)]);
			for (const [, r] of latest) entries.push(...r.hints);
		}
		const closed = segmentClosed(seg, asOf, p.windowBars);
		const fresh = freshAt(inp.m5[inp.m5.length - 1]?.time, asOf, inp.chartMinutes ?? 5);
		const hole = inp.m1Hole[m1.length - 1] === true;
		const states = {};
		for (const [mode, r] of latest) states[mode] = {
			mode,
			active: closed === null,
			hints: r.hints.length,
			last: r.hints[r.hints.length - 1] ?? null,
			waiting: closed ?? (!fresh ? "5m 狀態過期（換盤或缺資料），等待下一根 5m 收棒" : hole ? "這根 5m 已缺 1m（資料不完整），等待下一根完整的 5m 收棒" : r.waiting)
		};
		return {
			entries,
			states
		};
	}
	//#endregion
	//#region src/lib/trend-signal/engine.ts
	function unknownTrack(s, algo) {
		return {
			tf: s.tf,
			algo,
			line: s.bars.map(() => void 0),
			dir: s.bars.map(() => "UNKNOWN"),
			stopLine: false
		};
	}
	/** 最後一根已收 K 棒的狀態（收盤後保留的定盤桶 label 可能晚於 asOf，仍是已收） */
	function tfSnapshot(s, tr, note, m5Dir, asOf, sessionOpen) {
		const i = s.bars.length - 1;
		const bar = i >= 0 ? s.bars[i] : void 0;
		const dir = i >= 0 ? tr.dir[i] : "UNKNOWN";
		const tail = s.bars.slice(Math.max(0, i - 299), i + 1);
		const a = tail.length ? alignPoints(tail, atr(tail, note.atrPeriod))[tail.length - 1] : void 0;
		const r = tail.length ? rsiSeries(tail, note)[tail.length - 1] : void 0;
		const line = i >= 0 ? tr.line[i] : void 0;
		const lv = keyLevels(s.bars, i, note.keyBars);
		return {
			tf: s.tf,
			dir,
			barTime: bar?.time ?? null,
			close: bar?.close,
			line,
			age: trendAge(tr.dir, i),
			distAtr: bar && line !== void 0 && a !== void 0 && a > 0 ? (bar.close - line) / a : void 0,
			atr: a,
			rsi: r,
			align: m5Dir === null ? "NEUTRAL" : alignmentOf(dir, m5Dir),
			keyHigh: lv?.high,
			keyLow: lv?.low,
			stale: sessionOpen && !freshAt(bar?.time, asOf, s.tf),
			incomplete: i >= 0 && s.missing[i] > 0
		};
	}
	function runTrendSignal(input) {
		const cfg = input.config;
		const sec = input.securityType;
		const asOf = input.asOf;
		const sessionOpen = isSessionOpen(sec, asOf);
		const bars1 = confirmed1m(input.bars1m, asOf);
		const m1 = buildTf(bars1, 1, sec, asOf);
		const { series: m5, gaps } = completeOnly(buildTf(bars1, 5, sec, asOf));
		const m15 = buildTf(bars1, 15, sec, asOf);
		const m60 = buildTf(bars1, 60, sec, asOf);
		const t5 = trendTrack(m5, cfg.trend);
		const t1 = trendTrack(m1, microParams(cfg));
		const t15 = input.skipHtf ? unknownTrack(m15, cfg.trend.algo) : trendTrack(m15, cfg.trend);
		const t60 = input.skipHtf ? unknownTrack(m60, cfg.trend.algo) : trendTrack(m60, cfg.trend);
		const ema5 = emaSeries(m5.bars, cfg.note);
		const atr5 = alignPoints(m5.bars, atr(m5.bars, cfg.note.atrPeriod));
		const idBase = `${trendKey(cfg)}|${input.symbol}|${input.contractMonth}`;
		const signals = [];
		const invalidations = [];
		for (let i = 0; i < m5.bars.length; i++) {
			const bar = m5.bars[i];
			const from = invalidAt(t5.dir, i);
			if (from) invalidations.push({
				id: `${idBase}|${m5.session[i]}|5m|${wallIso(bar.time)}|INVALID`,
				barTime: bar.time,
				index: i,
				from
			});
			const kind = switchAt(t5.dir, i);
			if (!kind) continue;
			const h15 = tfAt(m15, t15, bar.time);
			const h60 = tfAt(m60, t60, bar.time);
			const d5 = t5.dir[i];
			signals.push({
				id: `${idBase}|${m5.session[i]}|5m|${wallIso(bar.time)}|${kind}`,
				kind,
				direction: kind === "BUY" ? "LONG" : "SHORT",
				barTime: bar.time,
				index: i,
				session: m5.session[i],
				sessionEnd: m5.sessionEnd[i],
				close: bar.close,
				line: t5.line[i],
				atr: atr5[i],
				notes: {
					ema: emaNote(m5.bars, ema5, i, kind, cfg.note.emaSlopeBars),
					m15: h15.state,
					m60: h60.state,
					m15Align: alignmentOf(h15.state, d5),
					m60Align: alignmentOf(h60.state, d5),
					m15BarTime: h15.barTime,
					m60BarTime: h60.barTime,
					m15Stale: h15.stale,
					m60Stale: h60.stale,
					m15Incomplete: h15.incomplete,
					m60Incomplete: h60.incomplete
				}
			});
		}
		const timing = computeEntries({
			signals,
			m1: m1.bars,
			m1Session: m1.session,
			m1SessionEnd: m1.sessionEnd,
			m1Hole: holeBefore(bars1, sec),
			m5: m5.bars,
			dir5: t5.dir,
			micro: t1.dir,
			asOf,
			p: cfg.entry,
			key: entryKey(cfg)
		});
		const entries = timing.entries;
		const selected = entries.filter((e) => e.mode === cfg.entry.mode);
		const v = runVirtual({
			m1: m1.bars,
			m1SessionEnd: m1.sessionEnd,
			live: input.live ?? null,
			asOf,
			m5,
			t5,
			signals,
			invalidations,
			entries: selected,
			cfg: cfg.risk,
			tick: input.tick,
			pointValue: input.pointValue,
			taxRate: input.taxRate ?? 0,
			key: riskKey(cfg)
		});
		const events = [];
		for (const s of signals) {
			const n = s.notes;
			events.push({
				time: s.barTime,
				kind: "SIGNAL",
				ref: s.id,
				text: `5m ${s.kind} @ ${s.close}（趨勢線 ${s.line ?? "—"}；EMA ${n.ema}；15m ${n.m15}${n.m15Stale ? "（過期）" : ""}／60m ${n.m60}${n.m60Stale ? "（過期）" : ""}）`
			});
		}
		for (const x of invalidations) events.push({
			time: x.barTime,
			kind: "INVALID",
			ref: x.id,
			text: `5m ${x.from === "LONG" ? "多" : "空"}方趨勢失效 → NEUTRAL（不是反向訊號）`
		});
		for (const e of selected) events.push({
			time: e.barTime,
			kind: "ENTRY",
			ref: e.id,
			text: `1m 進場提示 ${e.mode} 第 ${e.seq} 次 ${e.direction === "LONG" ? "多" : "空"} @ ${e.refPrice}（${e.reason}）`
		});
		for (const g of gaps) events.push({
			time: g.label,
			kind: "DATA",
			ref: `${idBase}|5m|${wallIso(g.label)}|GAP`,
			text: `5m ${wallHm(g.label)} 缺 ${g.missing} 根 1m：資料不完整，已排除（不參與趨勢計算，不產生訊號、提示或虛擬進場）`
		});
		events.push(...v.events);
		events.sort((a, b) => a.time - b.time);
		const lastGap = gaps[gaps.length - 1];
		const s5 = tfSnapshot(m5, t5, cfg.note, null, asOf, sessionOpen);
		const s1 = tfSnapshot(m1, t1, cfg.note, s5.dir, asOf, sessionOpen);
		const s15 = tfSnapshot(m15, t15, cfg.note, s5.dir, asOf, sessionOpen);
		const s60 = tfSnapshot(m60, t60, cfg.note, s5.dir, asOf, sessionOpen);
		const latest = signals[signals.length - 1] ?? null;
		const lastInvalid = invalidations[invalidations.length - 1] ?? null;
		const open = v.open;
		const lastBar1 = m1.bars[m1.bars.length - 1];
		return {
			version: TSP_ALGO_VERSION,
			configKey: configKey(cfg),
			taxRate: input.taxRate ?? 0,
			asOf,
			securityType: sec,
			symbol: input.symbol,
			contractMonth: input.contractMonth,
			m1,
			m5,
			m15,
			m60,
			t1,
			t5,
			t15,
			t60,
			ema5,
			signals,
			invalidations,
			gaps,
			entries,
			trades: v.trades,
			events,
			snapshot: {
				m1: s1,
				m5: s5,
				m15: s15,
				m60: s60,
				signal: latest,
				invalid: lastInvalid && (!latest || lastInvalid.barTime > latest.barTime) ? lastInvalid : null,
				recentGap: lastGap && asOf - lastGap.label <= 1800 ? lastGap : null,
				entries: timing.states,
				htfAgainst: s15.align === "DIVERGE" && s60.align === "DIVERGE",
				trade: open ?? v.trades[v.trades.length - 1] ?? null,
				pendingEntry: v.pendingEntry,
				pendingExit: v.pendingExit,
				m1Against: !!open && (s1.dir === "LONG" || s1.dir === "SHORT") && s1.dir !== open.direction
			},
			dataLagSec: lastBar1 ? asOf - lastBar1.time : null,
			sessionOpen
		};
	}
	//#endregion
	//#region src/lib/trend-signal/custom-adapter.ts
	var CUSTOM_TSP_PROFILE = {
		tick: 1,
		pointValue: 10,
		taxRate: 2e-5
	};
	var CUSTOM_TSP_PLOTS = [
		["多方趨勢線", "#1fd286"],
		["空方趨勢線", "#ff4d6a"],
		["BUY", "#00e5ff"],
		["SELL", "#ff2bd6"],
		["失效", "#e0a43c"],
		["微型提示", "#8fd3ff"],
		["結構提示", "#b06fff"],
		["初始停損", "#ff4d6a"],
		["目前停損", "#ffad33"],
		["保本價", "#d0d8e8"],
		["1R", "#7fbf9f"],
		["2R", "#4fc9a5"],
		["3R", "#1fd286"],
		["虛擬進場多", "#00e5ff"],
		["虛擬進場空", "#ff2bd6"],
		["虛擬停損出場", "#ff744d"],
		["虛擬2R出場", "#4fc9a5"],
		["虛擬3R出場", "#1fd286"],
		["虛擬反轉失效出場", "#e0a43c"]
	];
	var empty$1 = (n) => Object.fromEntries(CUSTOM_TSP_PLOTS.map(([k]) => [k, new Array(n).fill(null)]));
	/** 非法輸入必須回報錯誤，不能讓編輯器把全 null 當成有效風控。 */
	function normalizeCustomBars(bars, params = {}) {
		const n = bars.time.length;
		if ([
			bars.open,
			bars.high,
			bars.low,
			bars.close,
			bars.volume
		].some((a) => a.length !== n)) throw new Error("K 棒欄位長度不一致");
		for (const def of TSP_PARAMS) if (params[def.key] !== void 0 && !Number.isFinite(params[def.key])) throw new Error(`參數 ${def.key} 必須是有限數值`);
		const market = (key) => {
			const value = params[key] === void 0 ? CUSTOM_TSP_PROFILE[key] : params[key];
			if (!Number.isFinite(value) || (key === "taxRate" ? value < 0 || value > 1 : value <= 0)) throw new Error(`商品參數 ${key} 無效，請核對契約規格`);
			return value;
		};
		const tick = market("tick"), pointValue = market("pointValue"), taxRate = market("taxRate");
		const byTime = /* @__PURE__ */ new Map();
		for (let i = 0; i < n; i++) {
			const b = {
				time: bars.time[i],
				open: bars.open[i],
				high: bars.high[i],
				low: bars.low[i],
				close: bars.close[i],
				volume: bars.volume[i]
			};
			if (!Object.values(b).every(Number.isFinite) || b.time % 60 !== 0 || b.volume < 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) throw new Error("1m K 棒時間或 OHLCV 無效");
			byTime.set(b.time, b);
		}
		return {
			sorted: [...byTime.values()].sort((a, b) => a.time - b.time),
			tick,
			pointValue,
			taxRate
		};
	}
	function inputFromCustomBars(bars, params = {}, nowWall = nowWallClockUtc()) {
		if (!Number.isFinite(nowWall)) throw new Error("計算時刻無效");
		const { sorted, tick, pointValue, taxRate } = normalizeCustomBars(bars, params);
		if (sorted.length < 2) return null;
		let step = Infinity;
		for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i].time - sorted[i - 1].time);
		if (step !== 60) throw new Error("TSP 風控自訂版只支援 1m 主圖；請切換至 1m 並載入足夠資料");
		const visible = sorted.filter((b) => b.time <= Math.ceil(nowWall / 60) * 60);
		if (visible.length < 2) return null;
		const last = visible[visible.length - 1];
		const session = tradingSessionOf("FUT", last.time);
		const closed = nowWall >= session.end + 240 + 10;
		const confirmed = closed ? visible : visible.slice(0, -1);
		return {
			bars1m: confirmed,
			live: closed ? null : last,
			asOf: closed ? Math.max(last.time, session.end + 240) : confirmed[confirmed.length - 1].time,
			securityType: "FUT",
			symbol: "TMF",
			contractMonth: "CUSTOM",
			tick,
			pointValue,
			taxRate,
			config: configFromParams(params)
		};
	}
	function projectCustomTsp(res, chartTimes, visibleThrough = Infinity, riskHistory = true) {
		const out = empty$1(chartTimes.length);
		const indexes = /* @__PURE__ */ new Map();
		chartTimes.forEach((t, i) => {
			if (t <= visibleThrough) indexes.set(t, [...indexes.get(t) ?? [], i]);
		});
		const put = (key, time, value) => {
			for (const i of indexes.get(time) ?? []) out[key][i] = value;
		};
		chartTimes.forEach((t, i) => {
			if (t > visibleThrough) return;
			const j = lastAtOrBefore(res.m5.bars, Math.min(t, res.asOf));
			const dir = res.t5.dir[j];
			const value = res.t5.line[j];
			if (value !== void 0 && (dir === "LONG" || dir === "SHORT")) out[dir === "LONG" ? "多方趨勢線" : "空方趨勢線"][i] = value;
		});
		for (const s of res.signals) put(s.kind, s.barTime, s.close);
		for (const x of res.invalidations) put("失效", x.barTime, res.m5.bars[x.index].close);
		for (const e of res.entries) {
			if (e.mode === "MICRO_TREND") put("微型提示", e.barTime, e.refPrice);
			if (e.mode === "PRICE_STRUCTURE") put("結構提示", e.barTime, e.refPrice);
		}
		const times = [...indexes.keys()].sort((a, b) => a - b);
		for (const trade of res.trades) {
			put(trade.direction === "LONG" ? "虛擬進場多" : "虛擬進場空", trade.fillTime, trade.fillPrice);
			for (const f of trade.fills) put(f.reason === "TP2R" ? "虛擬2R出場" : f.reason === "TP3R" ? "虛擬3R出場" : f.reason === "REVERSAL" || f.reason === "TREND_INVALID" ? "虛擬反轉失效出場" : "虛擬停損出場", f.time, f.price);
			if (!riskHistory && (res.snapshot.trade?.status !== "OPEN" || trade.id !== res.snapshot.trade.id)) continue;
			const plan = trade.plan;
			let stopIndex = 0;
			let stop = plan.stop;
			for (const t of times) {
				if (t < trade.fillTime) continue;
				if (trade.closedAt !== null && t > trade.closedAt) break;
				while (stopIndex < trade.stopHistory.length && trade.stopHistory[stopIndex].time <= t) stop = trade.stopHistory[stopIndex++].stop;
				for (const [key, value] of [
					["初始停損", plan.stop],
					["目前停損", stop],
					["保本價", plan.breakevenStop],
					["1R", plan.r1],
					["2R", plan.r2],
					["3R", plan.r3]
				]) put(key, t, value);
			}
		}
		return out;
	}
	//#endregion
	//#region src/lib/trend-signal/app-plot-style.ts
	var LEVELS = new Set([
		"初始停損",
		"目前停損",
		"保本價",
		"1R",
		"2R",
		"3R"
	]);
	var exitPlot = (reason) => reason === "TP2R" ? "虛擬2R出場" : reason === "TP3R" ? "虛擬3R出場" : reason === "REVERSAL" || reason === "TREND_INVALID" ? "虛擬反轉失效出場" : "虛擬停損出場";
	var exitText = (side, reason) => {
		switch (reason) {
			case "STOP": return `${side} 停損出場`;
			case "BREAKEVEN_STOP": return `${side} 保本停損出場`;
			case "TRAIL_STOP": return `${side} 移動停損出場`;
			case "TP2R": return `${side} 2R 出場`;
			case "TP3R": return `${side} 3R 出場`;
			case "REVERSAL": return `${side} 反轉出場`;
			case "TREND_INVALID": return `${side} 反轉失效出場`;
		}
	};
	/** TSP App plot 樣式與 marker metadata；marker 只給虛擬進出場（主趨勢 BUY/SELL 仍是圓點），且只投影到既有且有值的輸出點。 */
	function appTspPlotHints(outputs, chartTimes, result, mode, riskHistory) {
		const markers = Object.fromEntries(CUSTOM_TSP_PLOTS.map(([key]) => [key, new Array(chartTimes.length).fill(null)]));
		const indexes = /* @__PURE__ */ new Map();
		chartTimes.forEach((time, i) => indexes.set(time, [...indexes.get(time) ?? [], i]));
		const put = (key, time, marker) => {
			for (const i of indexes.get(time) ?? []) if (typeof outputs[key]?.[i] === "number" && Number.isFinite(outputs[key][i])) markers[key][i] = {
				side: marker.side,
				text: marker.text
			};
		};
		if (result && mode !== "aux") for (const trade of result.trades) {
			const side = trade.direction === "LONG" ? "Sell" : "Buy";
			const entrySide = trade.direction === "LONG" ? "Buy" : "Sell";
			put(trade.direction === "LONG" ? "虛擬進場多" : "虛擬進場空", trade.fillTime, {
				side: entrySide,
				text: `${entrySide} 進場`
			});
			for (const fill of trade.fills) put(exitPlot(fill.reason), fill.time, {
				side,
				text: exitText(entrySide, fill.reason)
			});
		}
		return Object.fromEntries(CUSTOM_TSP_PLOTS.map(([key, color]) => [key, {
			color,
			kind: key.endsWith("趨勢線") ? "line" : LEVELS.has(key) ? riskHistory ? "points" : "dashed" : "points",
			...key === "目前停損" && !riskHistory ? { plot: "step" } : {},
			width: key === "目前停損" || key.endsWith("趨勢線") ? 2 : 1,
			markers: markers[key]
		}]));
	}
	//#endregion
	//#region src/lib/trend-signal/chart-custom.ts
	var CHART_TSP_VERSION = "tsp-chart-1.2.0";
	var DAY = 86400;
	/** 宿主未傳 tf；預設由間距推斷，可用 chartTf 明訂分鐘數消除缺棒歧義。 */
	function inferChartMinutes(times, explicit = 0) {
		if (!Number.isInteger(explicit) || explicit < 0 || explicit > 1440) throw new Error("chartTf 必須為 0（自動）或 1–1440 分鐘");
		if (explicit > 0) return explicit;
		if (times.length < 2) return 1;
		if (times.every((t) => t % DAY === 0)) return 1440;
		const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
		let step = 0;
		for (let i = 1; i < times.length; i++) step = gcd(step, (times[i] - times[i - 1]) / 60);
		if (!Number.isInteger(step) || step < 1 || step > 1440) throw new Error("無法判定主圖週期，請以 chartTf 指定分鐘數");
		return step;
	}
	/** 60m 的 14:00 桶仍屬日盤，不能直接把粗棒 label 當最後成交分鐘。 */
	function chartSession(label, minutes) {
		for (let t = label - minutes * 60 + 60; t <= label; t += 60) {
			if (isRegularMinute("FUT", t)) return tradingSessionOf("FUT", t);
			const session = tradingSessionOf("FUT", t);
			if (t > session.start && t <= session.end + 240) return session;
		}
		return tradingSessionOf("FUT", label);
	}
	function frameFromChart(bars, params = {}, nowWall = nowWallClockUtc()) {
		if (!Number.isFinite(nowWall)) throw new Error("計算時刻無效");
		const normalized = normalizeCustomBars(bars, params);
		const minutes = inferChartMinutes(normalized.sorted.map((b) => b.time), params.chartTf ?? 0);
		const seconds = minutes * 60;
		const daily = minutes === 1440;
		if (normalized.sorted.some((b) => b.time % seconds !== 0)) throw new Error("chartTf 與 K 棒時間未對齊，請核對主圖週期");
		const mapTime = (t) => daily ? t + DAY : t;
		const ceiling = daily ? (Math.floor(nowWall / DAY) + 1) * DAY : Math.ceil(nowWall / seconds) * seconds;
		const visible = normalized.sorted.map((b) => ({
			...b,
			time: mapTime(b.time)
		})).filter((b) => b.time <= ceiling);
		const last = visible.at(-1);
		const settled = last !== void 0 && (daily ? nowWall >= last.time + 10 : nowWall >= Math.max(last.time, chartSession(last.time, minutes).end + 240) + 10);
		const confirmed = settled ? visible : visible.slice(0, -1);
		const live = settled ? null : last ?? null;
		const asOf = confirmed.at(-1)?.time ?? -Infinity;
		const sessions = confirmed.map((b) => daily ? `CALENDAR:${wallDate(b.time - DAY)}` : chartSession(b.time, minutes).key);
		const sessionEnd = confirmed.map((b) => daily ? Infinity : chartSession(b.time, minutes).end);
		const series = {
			tf: minutes,
			bars: confirmed,
			lastMinute: confirmed.map((b) => b.time),
			session: sessions,
			sessionEnd,
			missing: confirmed.map(() => 0)
		};
		const next = new Map(visible.slice(0, -1).map((b, i) => [b.time, visible[i + 1].time]));
		const label = daily ? "1D（日曆日）" : `${minutes}m`;
		const clock = {
			baseLabel: label,
			trendLabel: label,
			openTime: (t) => daily ? t - seconds : Math.max(t - seconds, chartSession(t, minutes).start),
			isNext: (from, to) => daily ? next.get(from) === to : to === from + seconds
		};
		return {
			...normalized,
			minutes,
			seconds,
			daily,
			label,
			mapTime,
			visible,
			confirmed,
			live,
			asOf,
			series,
			clock,
			config: configFromParams(params)
		};
	}
	/** risk=false：只算趨勢、訊號與提示，不建立虛擬部位（App 的高週期輔助） */
	function runChartSignal(frame, opts = {}) {
		const { series, config: cfg, asOf, label } = frame;
		const track = trendTrack(series, cfg.trend);
		const micro = trendTrack(series, microParams(cfg));
		const av = alignPoints(series.bars, atr(series.bars, cfg.note.atrPeriod));
		const signals = [];
		const invalidations = [];
		const key = `${CHART_TSP_VERSION}|chart=${frame.minutes}|${trendKey(cfg)}`;
		series.bars.forEach((b, i) => {
			const id = `${key}|${series.session[i]}|${b.time}`;
			const from = invalidAt(track.dir, i);
			if (from) invalidations.push({
				id: `${id}|INVALID`,
				barTime: b.time,
				index: i,
				from
			});
			const kind = switchAt(track.dir, i);
			if (kind) signals.push({
				id: `${id}|${kind}`,
				kind,
				direction: kind === "BUY" ? "LONG" : "SHORT",
				barTime: b.time,
				index: i,
				session: series.session[i],
				sessionEnd: series.sessionEnd[i],
				close: b.close,
				line: track.line[i],
				atr: av[i],
				notes: {
					ema: "UNKNOWN",
					m15: "UNKNOWN",
					m60: "UNKNOWN",
					m15Align: "NEUTRAL",
					m60Align: "NEUTRAL",
					m15BarTime: null,
					m60BarTime: null,
					m15Stale: true,
					m60Stale: true,
					m15Incomplete: false,
					m60Incomplete: false
				}
			});
		});
		const timing = computeEntries({
			signals,
			m1: series.bars,
			m1Session: series.session,
			m1SessionEnd: series.sessionEnd,
			m1Hole: series.bars.map(() => false),
			m5: series.bars,
			dir5: track.dir,
			micro: micro.dir,
			asOf,
			p: cfg.entry,
			key: `${key}|${entryKey(cfg)}`,
			chartMinutes: frame.minutes
		});
		const v = runVirtual({
			m1: series.bars,
			m1SessionEnd: series.sessionEnd,
			live: frame.live,
			asOf,
			m5: series,
			t5: track,
			signals,
			invalidations,
			entries: opts.risk === false ? [] : timing.entries.filter((e) => e.mode === cfg.entry.mode),
			cfg: cfg.risk,
			tick: frame.tick,
			pointValue: frame.pointValue,
			taxRate: frame.taxRate,
			key: `${key}|${riskKey(cfg)}`,
			clock: frame.clock
		});
		const events = signals.map((s) => ({
			time: s.barTime,
			kind: "SIGNAL",
			ref: s.id,
			text: `本圖 ${label} ${s.kind} @ ${s.close}`
		}));
		events.push(...v.events.map((e) => ({
			...e,
			text: e.text.replace(/(^|[^0-9])[15]m(?![0-9A-Za-z])/g, (_, before) => `${before}${label}`)
		})));
		events.sort((a, b) => a.time - b.time);
		return {
			version: CHART_TSP_VERSION,
			timeframeMinutes: frame.minutes,
			timeframeLabel: label,
			asOf,
			m1: series,
			m5: series,
			t5: track,
			signals,
			invalidations,
			entries: timing.entries,
			trades: v.trades,
			events,
			snapshot: { trade: v.open ?? v.trades.at(-1) ?? null },
			pendingEntry: v.pendingEntry,
			pendingExit: v.pendingExit
		};
	}
	/** 宿主曲線會跨 whitespace 連線：趨勢線只畫最後一段連續有效趨勢（同方向、同盤、相鄰桶），歷史成交點仍保留。 */
	function keepLastChartSegment(projected, frame, dir, mappedTimes) {
		const last = frame.confirmed.length - 1;
		let start = last;
		const direction = dir[last];
		while (start > 0 && dir[start - 1] === direction && (frame.daily || frame.confirmed[start].time - frame.confirmed[start - 1].time === frame.seconds && frame.series.session[start] === frame.series.session[start - 1])) start--;
		for (const key of ["多方趨勢線", "空方趨勢線"]) projected[key] = projected[key].map((v, i) => {
			const time = mappedTimes[i];
			if (time < (frame.confirmed[start]?.time ?? Infinity)) return null;
			if (!frame.daily && time > (frame.confirmed[last]?.time ?? -Infinity) && (time !== frame.confirmed[last].time + frame.seconds || chartSession(time, frame.minutes).key !== frame.series.session[last])) return null;
			return v;
		});
	}
	//#endregion
	//#region src/lib/trend-signal/app-custom.ts
	var APP_TSP_PLOTS = CUSTOM_TSP_PLOTS;
	var empty = (n) => Object.fromEntries(APP_TSP_PLOTS.map(([k]) => [k, new Array(n).fill(null)]));
	/** 5m 主圖的微型趨勢與主趨勢算在同一組 5m K 棒上：沿用 1m 主圖的預設會與主趨勢完全相同、MICRO_TREND 永遠不提示。
	*  改用較靈敏的預設（只依提示頻率選定，研究結果 7.3）；使用者在 App 宣告了該參數就照用 */
	var M5_MICRO_DEFAULTS = {
		microStMult: 1,
		microDcLength: 5,
		microKamaHyst: .05
	};
	/** 主圖週期 → 計算方式 */
	function appModeOf(minutes) {
		return minutes === 1 ? "model" : minutes === 5 ? "m5" : "aux";
	}
	/** 1m 主圖的 5m 趨勢線：只畫最後一段連續的 5m 趨勢（同方向、同盤、相鄰 5m），宿主折線才不會跨段連線 */
	function keepLastModelSegment(out, chartTimes, res) {
		const { bars, session } = res.m5;
		const last = bars.length - 1;
		let start = last;
		while (start > 0 && res.t5.dir[start - 1] === res.t5.dir[last] && bars[start].time - bars[start - 1].time === 300 && session[start] === session[start - 1]) start--;
		const from = bars[start]?.time ?? Number.POSITIVE_INFINITY;
		for (const key of ["多方趨勢線", "空方趨勢線"]) out[key] = out[key].map((v, i) => {
			const t = chartTimes[i];
			if (t < from) return null;
			return t > bars[last].time && tradingSessionOf("FUT", t).key !== session[last] ? null : v;
		});
	}
	function computeAppCustomTsp(bars, params = {}, nowWall = nowWallClockUtc()) {
		if (params.riskHistory !== void 0 && params.riskHistory !== 0 && params.riskHistory !== 1) throw new Error("riskHistory 只接受 0（目前部位）或 1（含歷史部位）");
		const riskHistory = params.riskHistory === 1;
		const { sorted } = normalizeCustomBars(bars, params);
		const mode = appModeOf(inferChartMinutes(sorted.map((b) => b.time), params.chartTf ?? 0));
		let outputs = empty(bars.time.length);
		let result = null;
		if (mode === "model") {
			const input = inputFromCustomBars(bars, params, nowWall);
			const res = input ? runTrendSignal(input) : null;
			if (input && res) {
				outputs = projectCustomTsp(res, bars.time, input.live?.time ?? res.m1.bars.at(-1)?.time ?? -Infinity, riskHistory);
				keepLastModelSegment(outputs, bars.time, res);
			}
			result = res;
		} else {
			const frame = frameFromChart(bars, mode === "m5" ? {
				...M5_MICRO_DEFAULTS,
				...params
			} : params, nowWall);
			const res = runChartSignal(frame, { risk: mode === "m5" });
			const shown = mode === "m5" ? res : {
				...res,
				signals: [],
				invalidations: [],
				entries: [],
				trades: []
			};
			const mapped = bars.time.map(frame.mapTime);
			outputs = projectCustomTsp(shown, mapped, frame.live?.time ?? frame.confirmed.at(-1)?.time ?? -Infinity, riskHistory);
			keepLastChartSegment(outputs, frame, res.t5.dir, mapped);
			result = res;
		}
		const hints = appTspPlotHints(outputs, bars.time, result, mode, riskHistory);
		return {
			mode,
			result,
			outputs,
			order: APP_TSP_PLOTS.map(([key]) => key),
			hints
		};
	}
	//#endregion
	//#region src/lib/trend-signal/custom-entry.ts
	var result = computeAppCustomTsp(bars, p);
	for (const key of result.order) plot(key, result.outputs[key], result.hints[key]);
	//#endregion
})();
