// Trend Signal Pro — 自訂指標版（對應原生 tsp-1.1.1 的趨勢核心與 1m 提示）
//
// 用法：Shioaji Pro「指標 → 自訂指標 → 建立」，位置選「主圖疊加」，把本檔全部貼進程式碼欄 →
// 驗證 → 儲存，再到指標選單加入。參數都可以不設（用下方預設）；要調整時在「參數」表加同名代號，
// 例如 algo（0 SuperTrend／1 Donchian＋ATR／2 KAMA）。
//
// 只畫圖、不送任何委託。沒有原生版的 Dashboard、虛擬風控、審計與通知。
// 演算法、預設參數、暖身、已收 K 棒與提示規則與原生 Trend Signal Pro 相同
// （repo 測試 src/lib/trend-signal/custom-script.test.ts 逐根比對）。
// 自行設計的公開方法，不是 Universal Indicator／Ultimate AI 原版，未驗證優於原版。
//
// 依主圖週期：
//   1m      5m 趨勢由已收 1m 聚合而來（每根 1m 只看當時已收的 5m），並畫 1m 進場提示
//   5m      5m 趨勢核心
//   其他    該週期自己的趨勢（相當於 Dashboard 的高週期輔助，不是 5m 訊號）
// 只用已收 K 棒：後面已經有下一根 K 棒（下一分鐘的成交已送達），或該盤已收盤（含 4 分鐘定盤寬限），
// 那一根才算收完；不靠時鐘猜。1m 主圖聚合出的 5m 缺任何一分鐘就排除（不產生訊號與提示），
// 桶內出現缺口後的 1m 也不提示。
// 自訂指標每次重算都從頭來、沒有凍結：主圖「更新歷史」改了舊 K 棒時，結果可能跟著變（原生版不會）。
// 圓點：綠／紅＝多／空趨勢線；BUY／SELL＝趨勢切換；失效＝Donchian＋ATR 跌破追蹤帶（不是反向）；
// 1m 微型／結構＝5m 方向內的進場提示（不是委託，也不是另一組 BUY／SELL）。

const num = (k, d) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : d);
const T = {
    algo: Math.round(num('algo', 0)),
    stPeriod: Math.round(num('stPeriod', 10)),
    stMult: num('stMult', 3),
    dcLength: Math.round(num('dcLength', 20)),
    dcAtrMult: num('dcAtrMult', 3),
    kamaLength: Math.round(num('kamaLength', 10)),
    kamaFast: Math.round(num('kamaFast', 2)),
    kamaSlow: Math.round(num('kamaSlow', 30)),
    kamaHyst: num('kamaHyst', 0.3),
};
const E = {
    hintWindow: Math.round(num('hintWindow', 0)),
    microStMult: num('microStMult', 3),
    microDcLength: Math.round(num('microDcLength', 20)),
    microKamaHyst: num('microKamaHyst', 0.3),
    pivotLeft: Math.round(num('pivotLeft', 2)),
    pivotRight: Math.round(num('pivotRight', 2)),
    minPullbackAtr: num('minPullbackAtr', 0.5),
};

const HOUR = 3600;
const GRACE = 240; // 收盤定盤寬限（13:46–13:49、05:01–05:04 歸剛收的那一盤）

// Wilder ATR（前 n 根真實波幅的平均起算）；資料不足為 null
function atrOf(h, l, c, n) {
    const out = new Array(c.length).fill(null);
    let prev = null;
    let seed = 0;
    for (let i = 0; i < c.length; i++) {
        const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
        if (prev === null) {
            seed += tr;
            if (i === n - 1) {
                prev = seed / n;
                out[i] = prev;
            }
            continue;
        }
        prev = (prev * (n - 1) + tr) / n;
        out[i] = prev;
    }
    return out;
}

// A：SuperTrend — (H+L)/2 ± 倍數 × ATR 的棘輪帶，收盤穿越生效帶即翻轉
function supertrend(h, l, c, period, mult) {
    const a = atrOf(h, l, c, period);
    const line = new Array(c.length).fill(null);
    const dir = new Array(c.length).fill(null);
    let pu = NaN;
    let pl = NaN;
    let up = true;
    let pc = NaN;
    for (let i = 0; i < c.length; i++) {
        if (a[i] === null) {
            pc = c[i];
            continue;
        }
        const mid = (h[i] + l[i]) / 2;
        let upper = mid + mult * a[i];
        let lower = mid - mult * a[i];
        if (!Number.isNaN(pu) && !(upper < pu || pc > pu)) upper = pu;
        if (!Number.isNaN(pl) && !(lower > pl || pc < pl)) lower = pl;
        if (up && c[i] < lower) up = false;
        else if (!up && c[i] > upper) up = true;
        line[i] = up ? lower : upper;
        dir[i] = up ? 1 : -1;
        pu = upper;
        pl = lower;
        pc = c[i];
    }
    return { line, dir };
}

// C：Donchian 突破＋ATR 追蹤帶 — 突破前 n 根極值進入 LONG／SHORT；近 n 根極值 ∓ k × ATR14 的棘輪帶，
// 收盤穿越即 NEUTRAL（0）
function donchianAtr(h, l, c, length, k) {
    const n = Math.max(2, Math.round(length));
    const a = atrOf(h, l, c, 14);
    const line = new Array(c.length).fill(null);
    const dir = new Array(c.length).fill(null);
    let state = null;
    let band = 0;
    for (let i = 0; i < c.length; i++) {
        const av = a[i];
        if (i < n || av === null) continue;
        let hh = -Infinity;
        let ll = Infinity;
        let top = -Infinity;
        let bottom = Infinity;
        for (let j = i - n; j <= i; j++) {
            if (j < i) {
                hh = Math.max(hh, h[j]);
                ll = Math.min(ll, l[j]);
            }
            if (j > i - n) {
                top = Math.max(top, h[j]);
                bottom = Math.min(bottom, l[j]);
            }
        }
        const cl = c[i];
        if (cl > hh && state !== 1) {
            state = 1;
            band = top - k * av;
        } else if (cl < ll && state !== -1) {
            state = -1;
            band = bottom + k * av;
        } else if (state === 1) {
            band = Math.max(band, top - k * av);
        } else if (state === -1) {
            band = Math.min(band, bottom + k * av);
        } else {
            state = 0;
        }
        if ((state === 1 && cl < band) || (state === -1 && cl > band)) state = 0;
        dir[i] = state;
        line[i] = state === 1 || state === -1 ? band : null;
    }
    return { line, dir };
}

// B：KAMA＋ATR 遲滯 — 自適應均線自身回落（回升）超過 hyst × ATR14 才翻轉
function kamaLine(c, n, fast, slow) {
    const fc = 2 / (fast + 1);
    const sc = 2 / (slow + 1);
    const out = new Array(c.length).fill(null);
    let k = c.length ? c[0] : 0;
    for (let i = 0; i < c.length; i++) {
        if (i < n) {
            k = c[i];
            continue;
        }
        const change = Math.abs(c[i] - c[i - n]);
        let vol = 0;
        for (let j = i - n + 1; j <= i; j++) vol += Math.abs(c[j] - c[j - 1]);
        const er = vol > 0 ? change / vol : 0;
        const s2 = (er * (fc - sc) + sc) ** 2;
        k = k + s2 * (c[i] - k);
        out[i] = k;
    }
    return out;
}

function kamaTrend(h, l, c, P) {
    const kl = kamaLine(c, P.kamaLength, P.kamaFast, P.kamaSlow);
    const a = atrOf(h, l, c, 14);
    const dir = new Array(c.length).fill(null);
    let d = 0;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < c.length; i++) {
        const k = kl[i];
        const av = a[i];
        if (k === null || av === null) continue;
        if (d === 0) {
            const prev = i > 0 ? kl[i - 1] : null;
            d = prev !== null && k < prev ? -1 : 1;
            hi = k;
            lo = k;
        } else if (d === 1) {
            hi = Math.max(hi, k);
            if (k < hi - P.kamaHyst * av) {
                d = -1;
                lo = k;
            }
        } else {
            lo = Math.min(lo, k);
            if (k > lo + P.kamaHyst * av) {
                d = 1;
                hi = k;
            }
        }
        dir[i] = d;
    }
    return { line: kl, dir };
}

// 狀態：1 LONG、-1 SHORT、0 NEUTRAL、null UNKNOWN（暖身內一律 null）；線只在 LONG／SHORT 時有值
function track(h, l, c, P) {
    const raw = P.algo === 1 ? donchianAtr(h, l, c, P.dcLength, P.dcAtrMult)
        : P.algo === 2 ? kamaTrend(h, l, c, P)
            : supertrend(h, l, c, P.stPeriod, P.stMult);
    const warm = P.algo === 1 ? P.dcLength + 120 : P.algo === 2 ? 5 * P.kamaSlow : 15 * P.stPeriod;
    const st = raw.dir.map((d, i) => (i < warm || d === null ? null : d));
    const ln = raw.line.map((v, i) => (st[i] === 1 || st[i] === -1 ? v : null));
    return { st, line: ln };
}

// BUY（1）／SELL（-1）：由已知的其他狀態進入 LONG／SHORT；前一根未知不算
const switchAt = (st, i) => {
    if (i < 1 || st[i - 1] === null || st[i - 1] === st[i]) return 0;
    return st[i] === 1 ? 1 : st[i] === -1 ? -1 : 0;
};
// 失效：LONG／SHORT → NEUTRAL，回傳原方向
const invalidAt = (st, i) => (i >= 1 && st[i] === 0 && (st[i - 1] === 1 || st[i - 1] === -1) ? st[i - 1] : 0);

// 期貨交易時段收盤（日盤 13:45、夜盤 05:00）；收盤定盤寬限內的 K 棒歸剛收的那一盤
function sessionEnd(t) {
    const d0 = Math.floor(t / 86400) * 86400;
    const tod = t - d0;
    if (tod <= 5 * HOUR + GRACE) return d0 + 5 * HOUR;
    if (tod <= 13.75 * HOUR + GRACE) return d0 + 13.75 * HOUR;
    return d0 + 86400 + 5 * HOUR;
}

// 正規交易分鐘（日盤 08:46–13:45、夜盤 15:01–05:00；不含定盤寬限與週末）：5m 的完整性以它為準
function regularMinute(t) {
    const d0 = Math.floor(t / 86400) * 86400;
    const tod = t - d0;
    const start = tod <= 5 * HOUR ? d0 - 86400 + 15 * HOUR : tod <= 13.75 * HOUR ? d0 + 8.75 * HOUR : d0 + 15 * HOUR;
    const end = tod <= 5 * HOUR ? d0 + 5 * HOUR : tod <= 13.75 * HOUR ? d0 + 13.75 * HOUR : d0 + 86400 + 5 * HOUR;
    if (!(t > start && t <= end)) return false;
    const wd = new Date(start * 1000).getUTCDay();
    return wd !== 0 && wd !== 6;
}

// 已確認轉折：左側 left 根嚴格較低（高）、右側 right 根不高於（不低於）；右側收完才成立
function pivots(hl, n, left, right, isHigh) {
    const out = [];
    for (let j = left; j + right < n; j++) {
        const v = hl[j];
        let ok = true;
        for (let k = j - left; k < j && ok; k++) ok = isHigh ? v > hl[k] : v < hl[k];
        for (let k = j + 1; k <= j + right && ok; k++) ok = isHigh ? v >= hl[k] : v <= hl[k];
        if (ok) out.push({ index: j, price: v, confirm: j + right });
    }
    return out;
}
function lastConfirmed(ps, m) {
    let lo = 0;
    let hi = ps.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ps[mid].confirm <= m) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}
function latestBefore(ps, m, before) {
    for (let k = lastConfirmed(ps, m); k >= 0; k--) if (ps[k].index < before) return ps[k];
    return null;
}

// ---- 主程式 ----

const n = close.length;
const now = Math.floor(Date.now() / 1000) + 8 * HOUR;
// 已收 K 棒數：最後一根要等下一根出現（下一分鐘的成交已送達），或該盤收盤（含寬限）再過 10 秒
let nc = n;
if (nc > 0 && !(now >= sessionEnd(time[nc - 1]) + GRACE + 10)) nc--;
const asOf = nc > 0 ? time[nc - 1] : -Infinity;
let step = Infinity;
for (let i = Math.max(1, nc - 300); i < nc; i++) {
    const d = time[i] - time[i - 1];
    if (d > 0 && d < step) step = d;
}

const nul = () => new Array(n).fill(null);
const longLine = nul();
const shortLine = nul();
const buy = nul();
const sell = nul();
const invalid = nul();
const microHint = nul();
const structHint = nul();
const ax = atrOf(high, low, close, 14);
const off = (i) => (ax[i] !== null ? ax[i] : high[i] - low[i]);
const below = (i, k) => low[i] - k * off(i);
const above = (i, k) => high[i] + k * off(i);

if (step > 60) {
    // 5m（或其他週期）主圖：直接在主圖 K 棒上算
    const tr = track(high.slice(0, nc), low.slice(0, nc), close.slice(0, nc), T);
    for (let i = 0; i < nc; i++) {
        if (tr.st[i] === 1) longLine[i] = tr.line[i];
        else if (tr.st[i] === -1) shortLine[i] = tr.line[i];
        const s = switchAt(tr.st, i);
        if (s === 1) buy[i] = below(i, 0.5);
        else if (s === -1) sell[i] = above(i, 0.5);
        const v = invalidAt(tr.st, i);
        if (v === 1) invalid[i] = above(i, 0.5);
        else if (v === -1) invalid[i] = below(i, 0.5);
    }
} else if (nc > 0) {
    // 1m 主圖：已收 1m → 5m（與主圖聚合相同：收盤 label＝向上取整到 5 分）
    let t5 = [];
    let h5 = [];
    let l5 = [];
    let c5 = [];
    let last5 = [];
    const present = [];
    const hole = []; // 1m 所屬的 5m 桶在它之前已缺正規分鐘（資料不完整）：這根不提示
    for (let i = 0; i < nc; i++) {
        const lb = Math.ceil(time[i] / 300) * 300;
        const k = t5.length - 1;
        const reg = regularMinute(time[i]) ? 1 : 0;
        let before = 0;
        for (let m = lb - 240; m < time[i]; m += 60) if (regularMinute(m)) before++;
        hole.push(before > (k < 0 || t5[k] !== lb ? 0 : present[k]));
        if (k < 0 || t5[k] !== lb) {
            t5.push(lb);
            h5.push(high[i]);
            l5.push(low[i]);
            c5.push(close[i]);
            last5.push(i);
            present.push(reg);
        } else {
            h5[k] = Math.max(h5[k], high[i]);
            l5[k] = Math.min(l5[k], low[i]);
            c5[k] = close[i];
            last5[k] = i;
            present[k] += reg;
        }
    }
    // 最後一個 5m 桶：收盤 label ≤ 最後一根已收 1m，或該盤已收盤（含寬限）才算收完
    const kl = t5.length - 1;
    if (kl >= 0 && !(t5[kl] <= asOf || now >= sessionEnd(time[last5[kl]]) + GRACE)) {
        t5.pop();
        h5.pop();
        l5.pop();
        c5.pop();
        last5.pop();
        present.pop();
    }
    // 缺任何正規分鐘的 5m 排除：不參與趨勢計算，也不產生訊號與提示（與原生相同）
    const keep = [];
    for (let k = 0; k < t5.length; k++) {
        let expected = 0;
        for (let m = t5[k] - 240; m <= t5[k]; m += 60) if (regularMinute(m)) expected++;
        if (present[k] >= expected) keep.push(k);
    }
    if (keep.length < t5.length) {
        t5 = keep.map((k) => t5[k]);
        h5 = keep.map((k) => h5[k]);
        l5 = keep.map((k) => l5[k]);
        c5 = keep.map((k) => c5[k]);
        last5 = keep.map((k) => last5[k]);
    }
    const tr5 = track(h5, l5, c5, T);
    // 每根 1m（含進行中的那一根）只看當時已收的 5m
    let j = -1;
    for (let i = 0; i < n; i++) {
        const ti = Math.min(time[i], asOf);
        while (j + 1 < t5.length && t5[j + 1] <= ti) j++;
        if (j < 0) continue;
        if (tr5.st[j] === 1) longLine[i] = tr5.line[j];
        else if (tr5.st[j] === -1) shortLine[i] = tr5.line[j];
    }

    const H1 = high.slice(0, nc);
    const L1 = low.slice(0, nc);
    const C1 = close.slice(0, nc);
    // 1m 微型趨勢：與 5m 同一演算法，只換靈敏度參數
    const micro = track(H1, L1, C1, { ...T, stMult: E.microStMult, dcLength: E.microDcLength, kamaHyst: E.microKamaHyst }).st;
    const atr1 = atrOf(H1, L1, C1, 14);
    const pivHigh = pivots(H1, nc, E.pivotLeft, E.pivotRight, true);
    const pivLow = pivots(L1, nc, E.pivotLeft, E.pivotRight, false);

    for (let k = 0; k < t5.length; k++) {
        const want = switchAt(tr5.st, k);
        const v = invalidAt(tr5.st, k);
        const at = last5[k]; // 該 5m 的最後一根 1m（完整時就是收盤那一根）
        if (v === 1) invalid[at] = above(at, 0.5);
        else if (v === -1) invalid[at] = below(at, 0.5);
        if (want === 0) continue;
        if (want === 1) buy[at] = below(at, 0.5);
        else sell[at] = above(at, 0.5);

        // 這段趨勢可提示的 1m：訊號收棒後到 5m 離開該方向為止；可選翻轉後 N 根 5m（不跨盤）；
        // 5m 過期（換盤後尚未收第一根、資料缺洞）、5m 桶內已缺 1m、每盤最後一根 1m 不提示
        let kk = k + 1;
        while (kk < t5.length && tr5.st[kk] === want) kk++;
        const endedAt = kk < t5.length ? t5[kk] : Infinity;
        const windowEnd = E.hintWindow > 0 ? Math.min(t5[k] + E.hintWindow * 300, sessionEnd(time[at])) : Infinity;
        const seg = [];
        let jj = k;
        for (let m = at + 1; m < nc; m++) {
            const t = time[m];
            if (t >= endedAt || t > windowEnd) break;
            while (jj + 1 < t5.length && t5[jj + 1] <= t) jj++;
            if (!(t5[jj] >= Math.ceil(t / 300) * 300 - 300) || t >= sessionEnd(t) || hole[m]) continue;
            seg.push(m);
        }

        // MICRO_TREND：1m 由反向或中性轉回同向
        for (const m of seg) {
            const prev = m >= 1 ? micro[m - 1] : undefined;
            if (micro[m] !== want || prev === undefined || prev === null || prev === want) continue;
            microHint[m] = want === 1 ? below(m, 0.3) : above(m, 0.3);
        }

        // PRICE_STRUCTURE：回檔轉折確認後收盤突破回檔起點；提示後要有新的回檔轉折
        const pull = want === 1 ? pivLow : pivHigh;
        const start = want === 1 ? pivHigh : pivLow;
        let after = t5[k];
        let plIndex = -1;
        let broken = false;
        let scanned = -1;
        let topKey = '';
        let top = 0;
        for (const m of seg) {
            const q = lastConfirmed(pull, m);
            const pl = q >= 0 ? pull[q] : null;
            if (!pl || !(time[pl.index] > after)) continue;
            if (pl.index !== plIndex) {
                plIndex = pl.index;
                broken = false;
                scanned = pl.index;
            }
            for (let x = scanned + 1; x <= m && !broken; x++) broken = want === 1 ? close[x] < pl.price : close[x] > pl.price;
            scanned = m;
            if (broken) continue;
            const ph = latestBefore(start, m, pl.index);
            if (!ph) continue;
            if (topKey !== `${ph.index}:${pl.index}`) {
                topKey = `${ph.index}:${pl.index}`;
                top = want === 1 ? -Infinity : Infinity;
                for (let x = ph.index; x <= pl.index; x++) top = want === 1 ? Math.max(top, high[x]) : Math.min(top, low[x]);
            }
            const depth = want === 1 ? top - pl.price : pl.price - top;
            const a = atr1[m];
            if (a === null || depth < E.minPullbackAtr * a) continue;
            if (want === 1 ? close[m] > top : close[m] < top) {
                structHint[m] = want === 1 ? below(m, 0.6) : above(m, 0.6);
                after = time[m];
            }
        }
    }
}

plot('多方趨勢線', longLine, { kind: 'points', color: '#1fd286' });
plot('空方趨勢線', shortLine, { kind: 'points', color: '#ff4d6a' });
plot('BUY', buy, { kind: 'points', color: '#00e5ff' });
plot('SELL', sell, { kind: 'points', color: '#ff2bd6' });
plot('失效', invalid, { kind: 'points', color: '#e0a43c' });
plot('1m 微型提示', microHint, { kind: 'points', color: '#8fd3ff' });
plot('1m 結構提示', structHint, { kind: 'points', color: '#b06fff' });
