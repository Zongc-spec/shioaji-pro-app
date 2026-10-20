// 一次性研究量測的 vitest 設定（不在 CI 執行）。用法見 ../trend-signal-algorithms-2026-10.md
export default {
    test: {
        globals: true,
        include: ['*.char.ts'],
        testTimeout: 900000,
    },
    server: { fs: { allow: ['../../..'] } },
};
