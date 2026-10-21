// 編譯成可貼入官方 App 的單一腳本。只使用 App 公開的 bars/p/plot 介面。
import type { BarsInput, PlotHint } from '../custom-runtime';
import { computeAppCustomTsp } from './app-custom';

declare const bars: BarsInput;
declare const p: Record<string, number>;
declare function plot(name: string, values: (number | null)[], hint: PlotHint): void;

const result = computeAppCustomTsp(bars, p);
for (const key of result.order) plot(key, result.outputs[key]!, result.hints[key]!);
