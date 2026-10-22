import { describe, expect, it } from 'vitest';
import { runCustom, type BarsInput } from './custom-runtime';
import { DEF_BY_TYPE } from './indicator-defs';
import { customType, deleteCustom, saveCustom } from './custom-indicators';

const bars: BarsInput = {
    time: [60, 120, 180], open: [10, 11, 12], high: [11, 12, 13],
    low: [9, 10, 11], close: [10, 11, 12], volume: [1, 1, 1],
};

describe('custom runtime marker hints', () => {
    it('keeps sanitized Buy/Sell markers aligned to finite output values and preserves step plots', () => {
        const res = runCustom(`plot('signal', [close[0], NaN, null], {
            kind: 'dashed', plot: 'step', width: 2,
            markers: [{ side: 'Buy', text: 'Buy 趨勢', extra: true }, { side: 'Sell', text: 'ignored' }, null],
        })`, bars, {});

        expect(res.error).toBeUndefined();
        expect(res.outputs.signal).toEqual([10, null, null]);
        expect(res.hints.signal).toEqual({
            kind: 'dashed', width: 2, plot: 'step',
            markers: [{ side: 'Buy', text: 'Buy 趨勢' }, null, null],
        });
    });

    it('rejects markers with the wrong length, side, or an overlong text', () => {
        expect(runCustom("plot('x', close, { markers: [null] })", bars, {}).error).toContain('markers 長度');
        expect(runCustom("plot('x', close, { markers: [{ side: 'Long', text: 'x' }, null, null] })", bars, {}).error).toContain('side');
        expect(runCustom(`plot('x', close, { markers: [{ side: 'Buy', text: '${'x'.repeat(81)}' }, null, null] })`, bars, {}).error).toContain('80 字');
    });

    it('leaves legacy plots unchanged and drops markers on null or non-finite values', () => {
        const legacy = runCustom("plot('legacy', close, { kind: 'points', color: '#123456' })", bars, {});
        expect(legacy).toMatchObject({ outputs: { legacy: [10, 11, 12] }, hints: { legacy: { kind: 'points', color: '#123456' } } });

        const empty = runCustom("plot('empty', [NaN, null, Infinity], { markers: [{ side: 'Buy', text: 'x' }, { side: 'Sell', text: 'y' }, null] })", bars, {});
        expect(empty.outputs.empty).toEqual([null, null, null]);
        expect(empty.hints.empty?.markers).toEqual([null, null, null]);
    });

    it('treats falsy marker entries as no marker, keeps legacy width/signed, and drops stale markers on a bare re-plot', () => {
        const falsy = runCustom("plot('x', close, { markers: [false, 0, { side: 'Buy', text: 'b' }] })", bars, {});
        expect(falsy.error).toBeUndefined();
        expect(falsy.hints.x?.markers).toEqual([null, null, { side: 'Buy', text: 'b' }]);

        const legacy = runCustom("plot('h', close, { kind: 'histogram', width: 3, signed: 1 })", bars, {});
        expect(legacy.hints.h).toEqual({ kind: 'histogram', width: 3, signed: true });

        const replot = runCustom("plot('x', close, { markers: [{ side: 'Buy', text: 'a' }, null, null] }); plot('x', [null, 11, 12]);", bars, {});
        expect(replot.outputs.x).toEqual([null, 11, 12]);
        expect(replot.hints.x?.markers).toBeUndefined();
    });

    it('moves runtime marker metadata onto computed IndicatorPoints without storing sample arrays', () => {
        const id = 'marker-runtime-test';
        const outputs = [{ key: 'signal', label: 'signal', kind: 'points' as const, color: '#123456' }];
        saveCustom({ id, name: 'markers', short: 'M', desc: '', category: 'overlay', params: [], outputs,
            source: "plot('signal', [close[0], null, close[2]], { markers: [{ side: 'Buy', text: 'entry' }, { side: 'Sell', text: 'dropped' }, null] })",
            updatedAt: 1 });
        try {
            const def = DEF_BY_TYPE.get(customType(id))!;
            const actual = def.compute([
                { time: 60, open: 10, high: 11, low: 9, close: 10, volume: 1 },
                { time: 120, open: 11, high: 12, low: 10, close: 11, volume: 1 },
                { time: 180, open: 12, high: 13, low: 11, close: 12, volume: 1 },
            ], {}, { tfMinutes: 1 });
            expect(actual.signal).toEqual([
                { time: 60, value: 10, marker: { side: 'Buy', text: 'entry' } },
                { time: 120 },
                { time: 180, value: 12 },
            ]);
            expect(def.outputs).toEqual(outputs);
            expect(def.outputs[0]).not.toHaveProperty('markers');
        } finally {
            deleteCustom(id);
        }
    });
});
