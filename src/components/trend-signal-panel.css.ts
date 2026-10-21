// src/components/trend-signal-panel.css.ts — Trend Signal Pro 圖上面板（右上 MTF
// Dashboard、右下虛擬風控）與審計視窗

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const card = style({
    position: 'absolute',
    zIndex: 6,
    pointerEvents: 'auto',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.28)',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.foreground,
    opacity: 0.96,
});

export const dashboard = style([card, { top: '8px', width: '340px', maxWidth: 'calc(100% - 96px)' }]);
export const riskCard = style([card, { bottom: '34px', width: '300px', maxWidth: 'calc(100% - 96px)' }]);

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 6px',
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontWeight: 600,
    fontSize: '0.66rem',
});

export const headerTitle = style({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

export const btn = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    padding: '1px 6px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    ':hover': { color: vars.color.foreground },
    selectors: { '&:disabled': { opacity: 0.45, cursor: 'not-allowed' } },
});

export const btnOn = style([btn, { color: vars.color.foreground, background: vars.color.muted }]);

export const select = style({
    maxWidth: '76px',
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    background: vars.color.inset,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '0 2px',
});

export const body = style({ padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '3px' });

export const row = style({ display: 'grid', gridTemplateColumns: '54px 1fr auto', gap: '4px', alignItems: 'baseline' });
export const rowLabel = style({ color: vars.color.mutedForeground, fontFamily: vars.font.body, whiteSpace: 'nowrap' });
export const rowMain = style({ minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: '2px 6px' });
export const rowTime = style({ color: vars.color.mutedForeground });
export const primary = style({ fontSize: '0.72rem', fontWeight: 700 });
export const sub = style({ color: vars.color.mutedForeground, gridColumn: '2 / 4' });

export const dir = styleVariants({
    LONG: { color: '#1fd286', fontWeight: 700 },
    SHORT: { color: '#ff4d6a', fontWeight: 700 },
    NEUTRAL: { color: vars.color.amber, fontWeight: 700 },
    UNKNOWN: { color: vars.color.mutedForeground },
});

export const stale = style({ color: vars.color.amber, fontFamily: vars.font.body });

export const tag = styleVariants({
    ALIGN: { color: '#1fd286' },
    DIVERGE: { color: vars.color.amber },
    NEUTRAL: { color: vars.color.mutedForeground },
});

export const badge = styleVariants({
    live: { color: '#1fd286' },
    warn: { color: vars.color.amber },
    down: { color: vars.color.danger },
    idle: { color: vars.color.mutedForeground },
});

export const riskChip = style([
    card,
    {
        bottom: '34px',
        padding: '3px 8px',
        cursor: 'pointer',
        fontFamily: vars.font.body,
    },
]);

export const warn = style({ color: vars.color.amber, fontFamily: vars.font.body });
export const note = style({ color: vars.color.mutedForeground, fontFamily: vars.font.body, fontSize: '0.58rem' });

/** 1m 提示：段落仍可提示／已停止 */
export const hint = styleVariants({
    active: { color: '#19b6c9' },
    closed: { color: vars.color.mutedForeground },
});

export const entryList = style({ gridColumn: '2 / 4', display: 'flex', flexDirection: 'column', gap: '1px' });

export const chip = style([
    card,
    {
        top: '8px',
        padding: '3px 8px',
        cursor: 'pointer',
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        fontFamily: vars.font.body,
    },
]);

// ---- 審計視窗 ----

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
});

export const dialog = style({
    width: 'min(960px, 94vw)',
    height: 'min(640px, 88vh)',
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
});

export const tabs = style({ display: 'flex', gap: '4px', padding: '6px 10px', borderBottom: `1px solid ${vars.color.border}` });

export const tableWrap = style({ flex: 1, overflow: 'auto', padding: '0 10px 10px' });

export const summary = style({ padding: '6px 10px', color: vars.color.mutedForeground, borderBottom: `1px solid ${vars.color.border}` });

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
});

globalStyle(`${table} th`, {
    position: 'sticky',
    top: 0,
    background: vars.color.panel,
    textAlign: 'left',
    padding: '4px',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
});

globalStyle(`${table} td`, {
    padding: '3px 4px',
    borderBottom: `1px solid ${vars.color.border}`,
    verticalAlign: 'top',
});

export const footer = style({
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    padding: '6px 10px',
    borderTop: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
});

export const spacer = style({ flex: 1 });

// ---- 1m 小圖（主圖右側欄） ----

export const miniColumn = style({
    width: '300px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    borderLeft: `1px solid ${vars.color.border}`,
    minHeight: 0,
});

export const miniHeader = style([header, { borderBottom: `1px solid ${vars.color.border}` }]);
export const miniHost = style({ flex: 1, minHeight: 0, position: 'relative' });
