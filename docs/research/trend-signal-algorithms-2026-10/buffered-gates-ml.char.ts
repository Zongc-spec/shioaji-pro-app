// 一次性研究量測（不在 CI 執行）：結果 10 — 加緩衝的趨勢強度判斷與機器學習候選的指標性質。
// 事前規則見 ../trend-signal-algorithms-2026-10.md 結果 10.0；資料、指標、參照包絡與結果 9 共用（trend-lib.ts）。
//
//   D=docs/research/trend-signal-algorithms-2026-10
//   TSP_CHAR_CSV=<兩年 1m CSV> TSP_FRESH_CSV=<結果 8 新資料 CSV> TSP_CHAR_OUT=<輸出目錄> \
//   npx vitest run --config "$PWD/$D/vitest.config.mjs" --root "$D" buffered-gates-ml
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import { ALGORITHMS, kamaLine } from '../../../src/lib/trend-signal/trend/algorithms';
import { configFromParams } from '../../../src/lib/trend-signal/config';
import type { TrendParams } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';
import {
    PERIOD_LIST, PERIODS, check, choppiness, closes, dmi, efficiency, emaArr, envelopes, fmt, loadSpliced, productDir,
    propsByPeriod, referenceSet, rolling, type Period, type State,
} from './trend-lib';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const FRESH_CSV = process.env.TSP_FRESH_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const IS_END = PERIODS.IS[1];

// ---- A. 加緩衝的趨勢強度判斷 ----

/** 開、關雙門檻；第一次打開之前未知，之後在兩門檻之間維持上一根 */
function schmitt(xs: (number | undefined)[], openIf: (x: number) => boolean, closeIf: (x: number) => boolean): (boolean | undefined)[] {
    let st: boolean | undefined;
    return xs.map((x) => {
        if (x === undefined) return st;
        if (st === undefined) st = openIf(x) ? true : undefined;
        else if (st && closeIf(x)) st = false;
        else if (!st && openIf(x)) st = true;
        return st;
    });
}

function neutralGate(base: State[], gate: (boolean | undefined)[]): State[] {
    return base.map((d, i) => (d === null || gate[i] === undefined ? null : gate[i] ? d : 0));
}

/** 打開時跟核心方向；關閉時維持上一個輸出、不接受翻轉；沒有 NEUTRAL */
function holdGate(base: State[], gate: (boolean | undefined)[]): State[] {
    let s: State = null;
    return base.map((d, i) => {
        if (d === null || gate[i] === undefined) return s;
        if (gate[i]) s = d;
        return s;
    });
}

// ---- B. 機器學習 ----

const FEATURES = ['r1', 'r3', 'r6', 'r12', 'r24', '距EMA20', '距EMA50', 'EMA20斜率', 'ST方向', '距ST線', 'KAMA方向', 'KAMA斜率',
    '效率比', 'ADX', 'Choppiness', 'DI差', '%b−0.5', 'ATR比', '量比', '夜盤', '時段進度'] as const;
// 濾網用：這些特徵乘上翻轉方向（「往翻轉方向」為正）
const DIRECTIONAL = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16]);

function features(b5: Candle[], a14: (number | undefined)[]): (number[] | null)[] {
    const c = closes(b5);
    const e20 = emaArr(c, 20);
    const e50 = emaArr(c, 50);
    const p = configFromParams({}).trend as TrendParams;
    const st = ALGORITHMS.supertrend.compute(b5, { ...p, algo: 'supertrend', stMult: 3 });
    const kp = { ...p, algo: 'kama' } as TrendParams;
    const kline = kamaLine(b5, kp.kamaLength, kp.kamaFast, kp.kamaSlow);
    const kdir = ALGORITHMS.kama.compute(b5, kp).dir;
    const er = efficiency(b5);
    const { pdi, mdi, adx } = dmi(b5);
    const chop = choppiness(b5);
    const mean = rolling(b5, 20, (w) => w.reduce((s, x) => s + x.close, 0) / w.length);
    const sd = rolling(b5, 20, (w) => {
        const m = w.reduce((s, x) => s + x.close, 0) / w.length;
        return Math.sqrt(w.reduce((s, x) => s + (x.close - m) ** 2, 0) / w.length);
    });
    const atrEma = emaArr(a14, 100);
    return b5.map((x, i) => {
        const av = a14[i];
        if (i < 150 || av === undefined || av <= 0) return null;
        const ses = tradingSessionOf('FUT', x.time);
        let vol = 0;
        for (let j = i - 20; j < i; j++) vol += b5[j]!.volume;
        const vals = [
            (x.close - c[i - 1]!) / av, (x.close - c[i - 3]!) / av, (x.close - c[i - 6]!) / av, (x.close - c[i - 12]!) / av, (x.close - c[i - 24]!) / av,
            e20[i] === undefined ? NaN : (x.close - e20[i]!) / av,
            e50[i] === undefined ? NaN : (x.close - e50[i]!) / av,
            e20[i] === undefined || e20[i - 3] === undefined ? NaN : (e20[i]! - e20[i - 3]!) / av,
            st.dir[i] === 1 ? 1 : st.dir[i] === -1 ? -1 : NaN,
            st.line[i] === undefined ? NaN : (x.close - st.line[i]!) / av,
            kdir[i] === 1 ? 1 : kdir[i] === -1 ? -1 : NaN,
            kline[i] === undefined || kline[i - 3] === undefined ? NaN : (kline[i]! - kline[i - 3]!) / av,
            er[i] ?? NaN,
            adx[i] ?? NaN,
            chop[i] ?? NaN,
            pdi[i] === undefined || mdi[i] === undefined ? NaN : (pdi[i]! - mdi[i]!) / 100,
            mean[i] === undefined || !sd[i] ? NaN : (x.close - (mean[i]! - 2 * sd[i]!)) / (4 * sd[i]!) - 0.5,
            atrEma[i] ? av / atrEma[i]! : NaN,
            vol > 0 ? x.volume / (vol / 20) : NaN,
            ses.night ? 1 : 0,
            (x.time - ses.start) / (ses.end - ses.start),
        ];
        return vals.every((v) => Number.isFinite(v)) ? vals : null;
    });
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

interface Scaler { mu: number[]; sd: number[] }
function fitScaler(X: number[][]): Scaler {
    const d = X[0]!.length;
    const mu = new Array(d).fill(0);
    const sd = new Array(d).fill(0);
    for (const x of X) for (let k = 0; k < d; k++) mu[k] += x[k]!;
    for (let k = 0; k < d; k++) mu[k] /= X.length;
    for (const x of X) for (let k = 0; k < d; k++) sd[k] += (x[k]! - mu[k]) ** 2;
    for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k] / X.length) || 1;
    return { mu, sd };
}
const scale = (s: Scaler, x: number[]) => x.map((v, k) => (v - s.mu[k]!) / s.sd[k]!);

/** L2 邏輯迴歸，全批次梯度下降 500 次、學習率 0.1、λ 0.001（截距不懲罰），初值 0 */
function fitLogistic(X: number[][], y: number[]) {
    const scaler = fitScaler(X);
    const Z = X.map((x) => scale(scaler, x));
    const d = Z[0]!.length;
    const w = new Array(d + 1).fill(0);
    const n = Z.length;
    for (let it = 0; it < 500; it++) {
        const g = new Array(d + 1).fill(0);
        for (let r = 0; r < n; r++) {
            const z = Z[r]!;
            let s = w[d];
            for (let k = 0; k < d; k++) s += w[k] * z[k]!;
            const e = sigmoid(s) - y[r]!;
            for (let k = 0; k < d; k++) g[k] += e * z[k]!;
            g[d] += e;
        }
        for (let k = 0; k < d; k++) w[k] -= 0.1 * (g[k] / n + 0.001 * w[k]);
        w[d] -= 0.1 * (g[d] / n);
    }
    const predict = (x: number[]) => {
        const z = scale(scaler, x);
        let s = w[d];
        for (let k = 0; k < d; k++) s += w[k] * z[k]!;
        return sigmoid(s);
    };
    return { predict, weights: w as number[] };
}

/** 梯度提升：100 棵深度 2、學習率 0.1、每葉至少 200 列、IS 的 32 分位切點分箱、對數損失（葉值為牛頓步 ΣG／ΣH） */
function fitBoosting(X: number[][], y: number[]) {
    const d = X[0]!.length;
    const n = X.length;
    const cuts: number[][] = [];
    for (let k = 0; k < d; k++) {
        const v = X.map((x) => x[k]!).sort((a, b) => a - b);
        const cs: number[] = [];
        for (let q = 1; q < 32; q++) {
            const c = v[Math.floor((q * v.length) / 32)]!;
            if (cs.at(-1) !== c) cs.push(c);
        }
        cuts.push(cs);
    }
    const binOf = (k: number, x: number) => {
        const cs = cuts[k]!;
        let lo = 0, hi = cs.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (x < cs[m]!) hi = m;
            else lo = m + 1;
        }
        return lo; // 0..cs.length
    };
    const B: Uint8Array[] = Array.from({ length: d }, (_, k) => Uint8Array.from(X.map((x) => binOf(k, x[k]!))));
    const mean = y.reduce((s, v) => s + v, 0) / n;
    const F0 = Math.log(mean / (1 - mean));
    const F = new Float64Array(n).fill(F0);
    type Node = { leaf: number } | { k: number; bin: number; left: Node; right: Node };
    const trees: Node[] = [];
    const MIN = 200;
    function bestSplit(rows: number[], g: Float64Array, h: Float64Array) {
        let G = 0, H = 0;
        for (const r of rows) { G += g[r]!; H += h[r]!; }
        let best: { k: number; bin: number; gain: number } | null = null;
        for (let k = 0; k < d; k++) {
            const nb = cuts[k]!.length + 1;
            const hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Int32Array(nb);
            const bk = B[k]!;
            for (const r of rows) { const b = bk[r]!; hg[b] = hg[b]! + g[r]!; hh[b] = hh[b]! + h[r]!; hc[b] = hc[b]! + 1; }
            let GL = 0, HL = 0, CL = 0;
            for (let b = 0; b < nb - 1; b++) {
                GL += hg[b]!; HL += hh[b]!; CL += hc[b]!;
                const CR = rows.length - CL;
                if (CL < MIN || CR < MIN) continue;
                const GR = G - GL, HR = H - HL;
                if (HL <= 0 || HR <= 0) continue;
                const gain = (GL * GL) / HL + (GR * GR) / HR - (G * G) / H;
                if (!best || gain > best.gain) best = { k, bin: b, gain };
            }
        }
        return { G, H, best };
    }
    function grow(rows: number[], depth: number, g: Float64Array, h: Float64Array): Node {
        const { G, H, best } = bestSplit(rows, g, h);
        if (depth === 0 || !best || best.gain <= 0) return { leaf: H > 0 ? (0.1 * G) / H : 0 };
        const L: number[] = [], R: number[] = [];
        const bk = B[best.k]!;
        for (const r of rows) (bk[r]! <= best.bin ? L : R).push(r);
        return { k: best.k, bin: best.bin, left: grow(L, depth - 1, g, h), right: grow(R, depth - 1, g, h) };
    }
    const all = Array.from({ length: n }, (_, r) => r);
    const evalNode = (node: Node, bins: (k: number) => number): number => ('leaf' in node ? node.leaf
        : evalNode(bins(node.k) <= node.bin ? node.left : node.right, bins));
    for (let t = 0; t < 100; t++) {
        const g = new Float64Array(n), h = new Float64Array(n);
        for (let r = 0; r < n; r++) {
            const p = sigmoid(F[r]!);
            g[r] = y[r]! - p;
            h[r] = p * (1 - p);
        }
        const tree = grow(all, 2, g, h);
        trees.push(tree);
        for (let r = 0; r < n; r++) F[r] = F[r]! + evalNode(tree, (k) => B[k]![r]!);
    }
    const predict = (x: number[]) => {
        let s = F0;
        for (const tree of trees) s += evalNode(tree, (k) => binOf(k, x[k]!));
        return sigmoid(s);
    };
    const used = new Map<string, number>();
    const walk = (node: Node) => {
        if ('leaf' in node) return;
        used.set(FEATURES[node.k]!, (used.get(FEATURES[node.k]!) ?? 0) + 1);
        walk(node.left);
        walk(node.right);
    };
    trees.forEach(walk);
    return { predict, used };
}

type Model = { predict: (x: number[]) => number };
const orient = (x: number[], d: number) => x.map((v, k) => (DIRECTIONAL.has(k) ? v * d : v));

/** 濾網的訓練列：基底翻轉後第 0–5 根（基底仍在新方向），標籤＝之後 6 根基底不離開新方向；只用 IS 且標籤不越過 IS 結束 */
function filterRows(base: State[], X: (number[] | null)[], b5: Candle[]) {
    const Xs: number[][] = [], ys: number[] = [];
    for (let f = 1; f < base.length; f++) {
        const d = base[f];
        if ((d !== 1 && d !== -1) || base[f - 1] === null || base[f - 1] === d) continue;
        if (b5[f]!.time < PERIODS.IS[0]) continue;
        for (let k = 0; k <= 5; k++) {
            const i = f + k;
            if (i + 6 >= base.length || b5[i + 6]!.time > IS_END) break;
            if (base[i] !== d) break;
            const x = X[i];
            if (!x) continue;
            let stay = 1;
            for (let j = i + 1; j <= i + 6; j++) if (base[j] !== d) stay = 0;
            Xs.push(orient(x, d));
            ys.push(stay);
        }
    }
    return { Xs, ys };
}

/** 基底與輸出不同時，預測機率 ≥ 0.5 的第一根採用基底方向 */
function filterState(base: State[], X: (number[] | null)[], model: Model): State[] {
    let s: State = null;
    return base.map((d, i) => {
        if (d === null) return s;
        if (s === null) s = d;
        else if (d !== s && (d === 1 || d === -1)) {
            const x = X[i];
            if (x && model.predict(orient(x, d)) >= 0.5) s = d;
        }
        return s;
    });
}

/** 方向的訓練列：12 根後收盤高於當根＝1；只用 IS 且標籤不越過 IS 結束 */
function directionRows(X: (number[] | null)[], b5: Candle[]) {
    const Xs: number[][] = [], ys: number[] = [];
    for (let i = 0; i + 12 < b5.length; i++) {
        if (b5[i]!.time < PERIODS.IS[0] || b5[i + 12]!.time > IS_END) continue;
        const x = X[i];
        if (!x) continue;
        Xs.push(x);
        ys.push(b5[i + 12]!.close > b5[i]!.close ? 1 : 0);
    }
    return { Xs, ys };
}

function directionState(X: (number[] | null)[], model: Model): State[] {
    let s: State = null;
    return X.map((x) => {
        if (!x) return s;
        const p = model.predict(x);
        if (p >= 0.55) s = 1;
        else if (p <= 0.45) s = -1;
        return s;
    });
}

// ---- 主程式 ----

test('結果 10：加緩衝的趨勢強度判斷與機器學習（TMF，唯讀）', () => {
    if (!CSV || !FRESH_CSV) throw new Error('請以 TSP_CHAR_CSV、TSP_FRESH_CSV 指定 1m CSV');
    const { m1, b5, a14, overlap, dayN } = loadSpliced(CSV, FRESH_CSV);
    const refRows = referenceSet(b5).map(([name, S]) => ({ name, p: propsByPeriod(S, b5, dayN) }));
    const env = envelopes(refRows);

    // A：加緩衝的判斷
    const { adx } = dmi(b5);
    const gateDefs: [string, (boolean | undefined)[]][] = [
        ['ADX 25／20', schmitt(adx, (x) => x >= 25, (x) => x < 20)],
        ['Choppiness 50／61.8', schmitt(choppiness(b5), (x) => x <= 50, (x) => x >= 61.8)],
        ['效率比 0.3／0.2', schmitt(efficiency(b5), (x) => x >= 0.3, (x) => x < 0.2)],
    ];
    const bases: [string, State[]][] = [
        ['ST(10,3)', productDir(b5, { algo: 'supertrend', stMult: 3 })],
        ['KAMA 0.3', productDir(b5, { algo: 'kama', kamaHyst: 0.3 })],
    ];
    // [名稱, 狀態, 判定用的期間]
    const cands: [string, State[], Period[]][] = [];
    for (const [bn, base] of bases) {
        for (const [gn, gate] of gateDefs) {
            cands.push([`${bn}＋${gn}（轉 NEUTRAL）`, neutralGate(base, gate), PERIOD_LIST]);
            cands.push([`${bn}＋${gn}（維持）`, holdGate(base, gate), PERIOD_LIST]);
        }
    }

    // B：機器學習（只用 IS 訓練、凍結；判定只用 OOS、FRESH）
    const X = features(b5, a14);
    const base2 = productDir(b5, { algo: 'supertrend', stMult: 2 });
    const fr = filterRows(base2, X, b5);
    const dr = directionRows(X, b5);
    const mlInfo: string[] = [];
    const rate = (ys: number[]) => fmt((100 * ys.reduce((s, v) => s + v, 0)) / ys.length);
    mlInfo.push(`濾網訓練列 ${fr.Xs.length}（標籤 1 的比例 ${rate(fr.ys)}%）；方向訓練列 ${dr.Xs.length}（標籤 1 的比例 ${rate(dr.ys)}%）`);
    const lrF = fitLogistic(fr.Xs, fr.ys);
    const gbF = fitBoosting(fr.Xs, fr.ys);
    const lrD = fitLogistic(dr.Xs, dr.ys);
    const gbD = fitBoosting(dr.Xs, dr.ys);
    const ML_PERIODS: Period[] = ['OOS', 'FRESH'];
    cands.push(['ML 濾網（邏輯迴歸）', filterState(base2, X, lrF), ML_PERIODS]);
    cands.push(['ML 濾網（梯度提升）', filterState(base2, X, gbF), ML_PERIODS]);
    cands.push(['ML 方向（邏輯迴歸）', directionState(X, lrD), ML_PERIODS]);
    cands.push(['ML 方向（梯度提升）', directionState(X, gbD), ML_PERIODS]);

    // 方向模型的分類表現（描述用）：各段 12 根後漲跌的命中率與對數損失
    const clsRows: string[] = [];
    for (const [name, m] of [['邏輯迴歸', lrD], ['梯度提升', gbD]] as const) {
        for (const q of PERIOD_LIST) {
            let n = 0, hit = 0, ll = 0;
            for (let i = 0; i + 12 < b5.length; i++) {
                const t = b5[i]!.time;
                if (t < PERIODS[q][0] || t > PERIODS[q][1] || b5[i + 12]!.time > PERIODS[q][1]) continue;
                const x = X[i];
                if (!x) continue;
                const y = b5[i + 12]!.close > b5[i]!.close ? 1 : 0;
                const p = Math.min(1 - 1e-9, Math.max(1e-9, m.predict(x)));
                n++;
                if ((p >= 0.5 ? 1 : 0) === y) hit++;
                ll -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
            }
            clsRows.push(`| ${name} | ${q}${q === 'IS' ? '（訓練）' : ''} | ${n} | ${fmt((100 * hit) / n)} | ${fmt(ll / n, 4)} |`);
        }
    }

    const candRows = cands.map(([name, S, judgedIn]) => {
        const p = propsByPeriod(S, b5, dayN);
        const checks = PERIOD_LIST.map((q) => ({ ...check(q, p[q], env[q]), used: judgedIn.includes(q) }));
        return { name, p, checks, pass: checks.filter((c) => c.used).every((c) => c.ok) };
    });

    let md = '# 結果 10：加緩衝的趨勢強度判斷與機器學習\n\n';
    md += `資料：1m ${m1.length} 根，重疊段 ${overlap} 根逐欄相同；5m ${b5.length} 根；日盤交易日 IS ${dayN.IS}、OOS ${dayN.OOS}、FRESH ${dayN.FRESH}\n\n`;
    md += `${mlInfo.join('\n\n')}\n\n`;
    for (const q of PERIOD_LIST) {
        md += `## ${q}\n\n參照 Pareto 點（延遲, 3 根失效%）：${env[q].f3.front.map((x) => `(${x.lag}, ${fmt(x.v)})`).join('、')}\n\n`;
        md += '| 演算法 | 訊號/日 | 3 根內失效% | 6 根內失效% | 延遲中位 | 段長中位 | 包絡 3 根 | 包絡 6 根 | 本段 |\n|---|---|---|---|---|---|---|---|---|\n';
        for (const r of candRows) {
            const c = r.checks.find((x) => x.q === q)!;
            const verdict = !c.used ? '訓練資料，不判' : c.ok ? '成立' : c.why || '不成立';
            md += `| ${r.name} | ${fmt(r.p[q].perDay, 2)} | ${fmt(r.p[q].fail3)} | ${fmt(r.p[q].fail6)} | ${r.p[q].lag} | ${r.p[q].seg} | ${fmt(c.e3)} | ${fmt(c.e6)} | ${verdict} |\n`;
        }
        md += '\n';
    }
    md += '## 判定\n\n| 候選 | IS | OOS | FRESH | 結果 |\n|---|---|---|---|---|\n';
    for (const r of candRows) {
        md += `| ${r.name} | ${r.checks.map((c) => (!c.used ? '不判' : c.ok ? '成立' : c.why || '不成立')).join(' | ')} | ${r.pass ? '**通過**' : '不通過'} |\n`;
    }
    md += '\n## 方向模型的分類表現（描述）\n\n| 模型 | 期間 | 列數 | 命中率% | 對數損失 |\n|---|---|---|---|---|\n' + clsRows.join('\n') + '\n';
    md += `\n（全猜一邊的對數損失為 ${fmt(Math.log(2), 4)}）\n\n## 邏輯迴歸係數（標準化後）\n\n| 特徵 | 濾網 | 方向 |\n|---|---|---|\n`;
    FEATURES.forEach((name, k) => { md += `| ${name} | ${fmt(lrF.weights[k], 3)} | ${fmt(lrD.weights[k], 3)} |\n`; });
    md += `| 截距 | ${fmt(lrF.weights[FEATURES.length], 3)} | ${fmt(lrD.weights[FEATURES.length], 3)} |\n`;
    md += `\n## 梯度提升用到的特徵（分裂次數）\n\n濾網：${[...gbF.used].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、')}\n\n`;
    md += `方向：${[...gbD.used].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、')}\n`;
    writeFileSync(`${OUT}/buffered-gates-ml.md`, md);
    writeFileSync(`${OUT}/buffered-gates-ml.json`, JSON.stringify({ days: dayN, cands: candRows, lr: { filter: lrF.weights, direction: lrD.weights }, features: FEATURES }, null, 2));
});
