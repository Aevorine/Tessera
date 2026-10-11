import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'
import { injectCsp } from './scripts/csp-policy.mjs'

/** 把 CSP 注入 index.html；策略和理由在 scripts/csp-policy.mjs，以便 tests/csp.test.mjs 免构建直接断言。 */
function cspPlugin(): Plugin {
  return {
    name: 'ideal1-csp',
    transformIndexHtml(html, ctx) {
      return injectCsp(html, { dev: Boolean(ctx.server) })
    },
  }
}

export default defineConfig({
  plugins: [
    cspPlugin(),
    react(),
    tailwindcss(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              // updateRunner 必须编成独立的 dist-electron/updateRunner.js：它是主进程退出后才启动的单独 Node 进程（替换运行中的 EXE），
              // 打进 main.js 就没有可单独 `node <file>` 的入口。
              input: {
                main: path.join(__dirname, 'electron/main.ts'),
                updateRunner: path.join(__dirname, 'electron/updateRunner.ts'),
              },
              output: {
                entryFileNames: '[name].js',
                // runner 以 CommonJS 经 `electron <path> --transaction ...`（ELECTRON_RUN_AS_NODE=1）直接执行，
                // 并用 `require.main === module` 判断直接运行。
                format: 'cjs',
              },
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              output: {
                // 必须是 cjs 且文件名 .js：开 `sandbox: true` 的硬前提（沙箱 preload 无 ESM 上下文，只能 require('electron')）。
                // sandbox 是渲染进程安全最后一道墙，限制 XSS 直接调系统；用 .mjs 时 preload 会静默加载失败、IPC 桥断掉。
                format: 'cjs',
                entryFileNames: 'preload.js',
              },
            },
          },
        },
      },
      // Polyfill the Electron and Node.js API for the Renderer process.
      renderer: process.env.NODE_ENV === 'test'
        ? undefined
        : {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // 显式绑 IPv4：Vite 默认的 localhost 在本机只绑 IPv6 回环，而 Chromium 先解析到 127.0.0.1 导致 ERR_CONNECTION_REFUSED。
    host: '127.0.0.1',
  },
})
