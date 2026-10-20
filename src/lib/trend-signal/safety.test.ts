// src/lib/trend-signal/safety.test.ts — 交易安全與模組邊界（靜態檢查 import）：
// Trend Signal Pro 不得直接 import 任何能下單或改單的模組；模組依賴只能往下游
// core → trend → trigger → risk（types／config 共用）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(here, '..');
const srcDir = resolve(libDir, '..');

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...sources(p));
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.test-harness\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

/** UI 層的 TSP 檔案（P2 起）也必須遵守同一條下單邊界 */
const UI_FILES = [
    'components/trend-signal-panel.tsx',
    'components/trend-signal-mini-chart.tsx',
    'hooks/use-trend-signal.ts',
].map((f) => join(srcDir, f));

function imports(file: string): { spec: string; resolved: string | null }[] {
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]!);
    return specs.map((spec) => ({ spec, resolved: spec.startsWith('.') ? resolve(dirname(file), spec) : null }));
}

// 能送單、改單、刪單或掛觸價單的模組（直接或間接），TSP 一律不得 import
const ORDER_MODULE = /^lib\/(trade|shioaji|trigger-engine|bracket|bracket-core|bracket-reports|api|trade-mutations|order-confirm|odd-spread-exec|flash-[^/]+)$|^lib\/(execution|conditional)\//;

describe('交易安全：沒有下單路徑', () => {
    const files = [...sources(here), ...UI_FILES.filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })];
    it('掃描到 TSP 的原始碼', () => {
        expect(files.length).toBeGreaterThan(12);
    });
    it.each(files.map((f) => [relative(srcDir, f), f]))('%s 不 import 任何下單模組', (_name, file) => {
        for (const { spec, resolved } of imports(file)) {
            if (!resolved) continue;
            expect(relative(srcDir, resolved), `${spec}`).not.toMatch(ORDER_MODULE);
        }
    });
    it('純計算層（src/lib/trend-signal）只用相對路徑，不依賴任何套件', () => {
        for (const file of sources(here)) {
            for (const { spec } of imports(file)) expect(spec.startsWith('.'), `${relative(srcDir, file)}: ${spec}`).toBe(true);
        }
    });
});

describe('模組依賴只能往下游', () => {
    const layer = (p: string) => {
        const r = relative(here, p);
        return r.startsWith('core') ? 'core' : r.startsWith('trend') ? 'trend' : r.startsWith('trigger') ? 'trigger'
            : r.startsWith('risk') ? 'risk' : r.replace(/\.tsx?$/, '');
    };
    const forbidden: Record<string, string[]> = {
        core: ['trend', 'trigger', 'risk', 'engine', 'project'],
        trend: ['trigger', 'risk', 'engine', 'project'],
        trigger: ['risk', 'engine', 'project'],
        risk: ['trigger', 'engine', 'project'],
    };
    for (const file of sources(here)) {
        const from = layer(file);
        if (!forbidden[from]) continue;
        it(`${relative(here, file)}（${from}）`, () => {
            for (const { resolved } of imports(file)) {
                if (!resolved || !resolved.startsWith(here)) continue;
                expect(forbidden[from]).not.toContain(layer(resolved));
            }
        });
    }
});
