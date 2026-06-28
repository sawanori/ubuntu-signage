import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node環境で実行（Main プロセスのロジックをテスト）
    environment: 'node',
    globals: true,
    // テストが 0 件の場合は CI を fail にする（サイレント障害対策）
    passWithNoTests: false,
    // E2E テストは Playwright ランナーで別管理 — Vitest の対象から明示的に除外する
    exclude: ['test/e2e/**', 'node_modules/**'],
    // fake timers は各テストで vi.useFakeTimers() を呼ぶ
    // メモリ fs は memfs / tmp ライブラリを使用（Phase2 T10+ で追加）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/renderer/**', 'src/preload/**'],
    },
  },
})
