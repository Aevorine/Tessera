import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 只量真实布局的开发服务器：别名和 Tailwind 同 vite.config.ts，但不挂 vite-plugin-electron（会拉起窗口抢焦点）；入口是 measure.html。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: '127.0.0.1', port: 5199, strictPort: true, open: false },
  build: { rollupOptions: { input: path.resolve(__dirname, 'measure.html') } },
})
