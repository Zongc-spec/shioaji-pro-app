// 起點不變性（研究量測，不在 CI 執行）：從 373 個不同起點各取 3000 根 5m 計算 SuperTrend，
// 量測方向與線值（差 > 0.5 點）最晚在起點後第幾根才與全量計算永久一致 → 決定暖身長度。
// 用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { supertrend } from '../../../src/lib/indicators';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = `${process.env.TSP_CHAR_OUT ?? tmpdir()}/start-invariance.txt`;
test('start invariance', () => {
    const lines = readFileSync(CSV, 'utf8').split('\n');
    const m1: Candle[] = [];
    const FROM = wallClockToUtc('2025-09-01T00:00:00');
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        const t = wallClockToUtc(dt!);
        if (t < FROM) continue;
        m1.push({ time: t, open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    const b5 = aggregate(m1, 5);
    const out: string[] = [];
    for (const [p, mult] of [[10, 2], [10, 3], [10, 4]] as const) {
        const full = supertrend(b5, p, mult);
        const dirFull = b5.map((_, i) => (full.up[i]!.value !== undefined ? 1 : full.down[i]!.value !== undefined ? -1 : 0));
        let starts = 0, ok = 0, firstMismatch: string[] = [], maxSettle = 0, maxLine = 0, maxLineFromStart = 0, maxFirst = 0, maxDirFromStart = 0; const dirLasts: number[] = []; const lineLasts: number[] = [];
        // 每 137 根取一個起點（約 11 小時），涵蓋日夜盤各種位置
        for (let s = 137; s < b5.length - 3000; s += 137) {
            starts++;
            const sub = b5.slice(s, s + 3000);
            const r = supertrend(sub, p, mult);
            const dir = sub.map((_, i) => (r.up[i]!.value !== undefined ? 1 : r.down[i]!.value !== undefined ? -1 : 0));
            // 第一次切換（ATR 可用後）
            let first = -1;
            for (let i = 1; i < dir.length; i++) if (dir[i - 1] !== 0 && dir[i] !== 0 && dir[i] !== dir[i - 1]) { first = i; break; }
            if (first < 0) continue;
            // 第一次切換之後：方向與線值是否與全量計算相同
            let dirLast = -1, lineLast = -1, dirDiffs = 0;
            for (let i = 0; i < dir.length; i++) {
                if (dir[i] === 0) continue;
                const fv = full.up[s + i]!.value ?? full.down[s + i]!.value;
                const sv = r.up[i]!.value ?? r.down[i]!.value;
                if (dir[i] !== dirFull[s + i]) { dirLast = i; dirDiffs++; }
                if (Math.abs((fv ?? 0) - (sv ?? 0)) > 0.5) lineLast = i;
            }
            if (dirLast < 0) ok++;
            else {
                maxSettle = Math.max(maxSettle, dirLast - first);
                if (firstMismatch.length < 3) firstMismatch.push(`start ${s} first-flip ${first} dir-diffs ${dirDiffs} last ${dirLast}`);
            }
            maxLine = Math.max(maxLine, lineLast < 0 ? 0 : lineLast - first);
            maxLineFromStart = Math.max(maxLineFromStart, lineLast < 0 ? 0 : lineLast);
            maxFirst = Math.max(maxFirst, first);
            maxDirFromStart = Math.max(maxDirFromStart, dirLast);
            dirLasts.push(dirLast); lineLasts.push(lineLast);
        }
        out.push(`ST(${p},${mult}): starts=${starts} 方向在第一次切換後完全相同=${ok} (${(100 * ok / starts).toFixed(1)}%), 方向不同最多延續=${maxSettle} 根; 線值差>0.5點最多延續=${maxLine} 根(自起點 ${maxLineFromStart} 根); 第一次切換最晚=${maxFirst} 根; 自起點方向最後不同=${maxDirFromStart} 根; p99 方向=${[...dirLasts].sort((a,b)=>a-b)[Math.floor(0.99*(dirLasts.length-1))]} 線值=${[...lineLasts].sort((a,b)=>a-b)[Math.floor(0.99*(lineLasts.length-1))]}; ${firstMismatch.join(' | ')}`);
    }
    writeFileSync(OUT, out.join('\n') + '\n');
});
