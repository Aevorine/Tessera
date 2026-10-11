import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * 行为测试（vitest + jsdom + Testing Library）配置。不复用 vite.config.ts：
 * 它挂的 vite-plugin-electron 会构建主进程并拉起 Electron，慢且在无显示器 CI 上失败。
 * `tests/*.test.mjs` 是静态守卫（npm run test:update，CI 跑这套），`tests/unit/*.test.tsx` 是行为测试（npm run test:unit），见 tests/README.md。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    // 不开 globals：describe/it/expect 显式从 'vitest' import，免得靠 eslint env 例外藏掉标识符来源。
    globals: false,
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // 刻意不开 passWithNoTests：否则用例文件被误删或被 include 漏掉时仍退出 0，成了空跑道。
    // CSS 当空模块处理：行为测试故意不看 class 名，不需要跑 Tailwind v4 流水线。
    css: false,
    // 每个用例之间自动还原 vi.fn / vi.spyOn，避免一个用例的 mock 泄漏到下一个。
    restoreMocks: true,
    clearMocks: true,
  },
})
