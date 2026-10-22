import { describe, expect, it, vi } from 'vitest';
import { ChartTradeMarkers, layoutTradeMarkers, type ChartTradeMarker } from './chart-trade-markers';

const marker = (side: 'Buy' | 'Sell', text: string = side): ChartTradeMarker => ({ time: 60, price: 100, high: 110, low: 90, color: '#00e5ff', side, text });

describe('三角形交易標記', () => {
    it('Buy 在整根 K 棒下方、Sell 在上方；不改成交時刻與價位', () => {
        const points = layoutTradeMarkers([marker('Buy'), marker('Sell')], (t) => t, (p) => 500 - p, 800, () => 24);
        expect(points[0]).toMatchObject({ x: 60, y: 428, time: 60, price: 100 });
        expect(points[1]).toMatchObject({ x: 60, y: 372, time: 60, price: 100 });
    });

    it('同棒分批出場、附近長文字分列，標籤不蓋住彼此', () => {
        const a = marker('Sell', 'Sell 2R 出場');
        const b = marker('Sell', 'Sell 3R 出場');
        const c = { ...marker('Sell', 'Sell 反轉出場'), time: 66 };
        const points = layoutTradeMarkers([a, b, c], (t) => t, (p) => 500 - p, 800, () => 90);
        expect(points.map((p) => p.y)).toEqual([372, 338, 304]);
        expect(points.every((p) => p.labelX >= p.labelWidth / 2)).toBe(true);
    });

    it('不繪製沒有座標或遠離視窗的事件', () => {
        expect(layoutTradeMarkers([marker('Buy')], () => null, () => 100, 800, () => 20)).toEqual([]);
        expect(layoutTradeMarkers([marker('Buy')], () => 2000, () => 100, 800, () => 20)).toEqual([]);
        expect(layoutTradeMarkers([marker('Buy')], () => -1, () => 100, 800, () => 20)).toEqual([]);
    });

    it('頂層實際畫出三個頂點與 Buy/Sell；縮放後重新取座標，卸載即停止', () => {
        const layer = new ChartTradeMarkers([marker('Buy'), marker('Sell')]);
        const xOf = vi.fn(() => 100);
        const requestUpdate = vi.fn();
        layer.attached({ chart: { timeScale: () => ({ timeToCoordinate: xOf }) }, series: { priceToCoordinate: (p: number) => 500 - p }, requestUpdate } as any);
        const ctx = Object.fromEntries(['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'fill', 'strokeText', 'fillText'].map((key) => [key, vi.fn()]));
        ctx.measureText = vi.fn(() => ({ width: 24 })) as any;
        const target = { useMediaCoordinateSpace: (draw: any) => draw({ context: ctx, mediaSize: { width: 800, height: 500 } }) };
        const view = layer.paneViews()[0]!;
        expect(view.zOrder!()).toBe('top');
        view.renderer()!.draw(target as any);
        expect(requestUpdate).toHaveBeenCalledOnce();
        expect(ctx.moveTo).toHaveBeenNthCalledWith(1, 100, 428);
        expect(ctx.lineTo).toHaveBeenNthCalledWith(1, 93, 439);
        expect(ctx.lineTo).toHaveBeenNthCalledWith(2, 107, 439);
        expect(ctx.fillText).toHaveBeenCalledWith('Buy', 100, 450);
        expect(ctx.fillText).toHaveBeenCalledWith('Sell', 100, 350);
        xOf.mockReturnValue(140);
        view.renderer()!.draw(target as any);
        expect(ctx.moveTo).toHaveBeenCalledWith(140, 428);
        layer.detached();
        const calls = ctx.fillText!.mock.calls.length;
        view.renderer()!.draw(target as any);
        expect(ctx.fillText!.mock.calls.length).toBe(calls);
    });
});
