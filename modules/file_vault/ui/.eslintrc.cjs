module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  // src/components/ui 起初是 shadcn 引入的源码，被排除出 ESLint 只因一个原因：
  // 文件级 `const xVariants = cva(...)` 加组件导出会让每个文件都触发 react-refresh/only-export-components，
  // 且该规则无法在这里按目录关闭。不是因为"没人改"：这些文件确实被手改过
  // （16px 正文下限要求不同于上游的控件高度，button.tsx 的 `text-[0.8rem]` 曾破坏该下限）。
  // 排版守卫 tests/typographyScale.test.mjs 递归扫描 src/components/，由它负责盯这个目录。
  // src/measure.tsx 是布局探针入口（配 measure.html + vite.measure.config.ts），只在开发时由真浏览器加载，
  // 不进产物；它按定义既有组件又有副作用，react-refresh 规则对它无意义。
  ignorePatterns: ['dist', 'dist-electron', 'release', '.eslintrc.cjs', 'src/components/ui', 'src/measure.tsx'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}
