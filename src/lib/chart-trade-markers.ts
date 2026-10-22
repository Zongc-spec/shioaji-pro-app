// Custom plot markers: draw above the candles so fills cannot be covered by lines.
// Series primitive API: https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';
import type { IndicatorMarker } from './indicators';

export interface ChartTradeMarker extends IndicatorMarker {
    time: number;
    price: number;
    color: string;
    high?: number;
    low?: number;
}

interface PositionedMarker extends ChartTradeMarker {
    x: number;
    y: number;
    labelX: number;
    labelWidth: number;
}

/** Keep simultaneous entries/exits in separate rows, including nearby labels. */
export function layoutTradeMarkers(markers: ChartTradeMarker[], xOf: (time: number) => number | null,
    yOf: (price: number) => number | null, width: number, measure: (text: string) => number): PositionedMarker[] {
    const placed: PositionedMarker[] = [];
    for (const marker of [...markers].sort((a, b) => a.time - b.time)) {
        const x = xOf(marker.time);
        const buy = marker.side === 'Buy';
        const anchor = yOf(buy ? Math.min(marker.low ?? marker.price, marker.price) : Math.max(marker.high ?? marker.price, marker.price));
        if (x === null || anchor === null || x < 0 || x > width) continue;
        const labelWidth = measure(marker.text) + 8;
        const labelX = Math.max(labelWidth / 2 + 2, Math.min(width - labelWidth / 2 - 2, x));
        let y = anchor + (buy ? 18 : -18);
        const direction = buy ? 1 : -1;
        // Labels and triangles occupy 32 px vertically. The entire event moves
        // as one unit; the timestamp and execution price stay unchanged.
        while (placed.some((p) => Math.abs(p.labelX - labelX) < (p.labelWidth + labelWidth) / 2 + 4
            && Math.abs(p.y - y) < 32)) y += direction * 34;
        placed.push({ ...marker, x, y, labelX, labelWidth });
    }
    return placed;
}

export class ChartTradeMarkers implements ISeriesPrimitive<Time> {
    private attachedTo: SeriesAttachedParameter<Time> | null = null;
    private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => ({ draw: this.draw }) }];

    constructor(private readonly markers: ChartTradeMarker[]) {}

    attached(param: SeriesAttachedParameter<Time>) {
        this.attachedTo = param;
        param.requestUpdate();
    }

    detached() { this.attachedTo = null; }
    paneViews(): IPrimitivePaneView[] { return this.views; }

    private draw: IPrimitivePaneRenderer['draw'] = (target) => {
        const attached = this.attachedTo;
        if (!attached) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            ctx.save();
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const layout = layoutTradeMarkers(this.markers,
                (time) => attached.chart.timeScale().timeToCoordinate(time as UTCTimestamp),
                (price) => attached.series.priceToCoordinate(price), mediaSize.width,
                (text) => ctx.measureText(text).width);
            for (const marker of layout) {
                const { x, y } = marker;
                const direction = marker.side === 'Buy' ? 1 : -1;
                // 14×11 px triangles point toward the candle; text sits outside.
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x - 7, y + direction * 11);
                ctx.lineTo(x + 7, y + direction * 11);
                ctx.closePath();
                ctx.strokeStyle = '#101723';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.fillStyle = marker.color;
                ctx.fill();
                const labelY = y + direction * 22;
                ctx.lineWidth = 4;
                ctx.lineJoin = 'round';
                ctx.strokeText(marker.text, marker.labelX, labelY);
                ctx.fillText(marker.text, marker.labelX, labelY);
            }
            ctx.restore();
        });
    };
}
