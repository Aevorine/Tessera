# file_vault UI 视觉重设计 — 设计文档

日期：2026-07-09

## 背景与目标

`modules/file_vault/ui/` 目前用的是 shadcn 默认主题（黑白灰、无定制），登录后的每个功能（加解密/密码管理/自动任务/设置）都是各自独立的整屏居中卡片，靠"返回"按钮来回跳转。用户希望整体视觉体验做到"轻量级、直观、高贵"，并且把不同模块做分区处理，而不是一串按钮堆在一个屏幕里。

通过可视化原型对比确定了两个关键方向：
- **视觉风格**：纸感留白（米白纸感背景 + 墨绿点缀，大量留白，克制圆角），同时做深色变体（墨感：暖灰近黑背景 + 提亮的墨绿），跟随系统深浅色。
- **信息架构**：常驻左侧边栏，按"文件 / 账户 / 自动化 / 其它"分组导航，右侧内容区随点击切换面板，不再用整屏返回式导航。

## 架构决策：颜色令牌驱动，组件层几乎不用改

`src/index.css` 里 `:root`/`.dark` 两组 CSS 变量是所有 shadcn 组件（Button/Card/Dialog/Tabs/Input/Checkbox/Progress/Alert/Sonner...）颜色的唯一来源（`@theme inline` 块把 `--color-*` 全部映射到这些变量）。这次重设计的颜色部分只改这一个文件的两组变量值，不需要逐个组件改样式——这是整个方案里覆盖面最广、风险最低的一步。

`next-themes` 已经是项目依赖（`package.json` 里已装），但目前只有 `sonner.tsx`（toast 组件）在用它的 `useTheme()`，全局从没接过 `ThemeProvider`，深色模式实际上从来没真正生效过。这次要在 `src/main.tsx` 补上 `ThemeProvider`（`attribute="class"`、`defaultTheme="system"`、`enableSystem`），`next-themes` 会根据系统深浅色自动给 `<html>` 加/去 `.dark` class，配合上面的两组变量自动切换。

## 颜色令牌（浅色 / 深色）

以下颜色值直接写入 `src/index.css` 的 `:root`（浅色）和 `.dark`（深色）块，替换现有的黑白灰默认值。命名严格对应现有变量名，不新增、不删除任何变量（保证所有现成组件不用改代码就能吃到新颜色）：

**浅色（纸感留白）**

| 变量 | 值 | 用途 |
|---|---|---|
| `--background` | `#f7f4ee` | 页面底色，暖米白纸感 |
| `--foreground` | `#2b2a26` | 主文字，暖近黑灰 |
| `--card` / `--popover` | `#ffffff` | 卡片/弹层底色，比页面底色更"白"一点，制造层次 |
| `--card-foreground` / `--popover-foreground` | `#2b2a26` | 同主文字 |
| `--primary` | `#2f4a3c` | 强调色：墨绿，主按钮/激活态 |
| `--primary-foreground` | `#f7f4ee` | 主按钮上的文字 |
| `--secondary` / `--muted` | `#efeadf` | 次级背景（浅米色），侧边栏底色也用这个 |
| `--secondary-foreground` | `#2b2a26` | |
| `--muted-foreground` | `#8a8575` | 次要文字/说明文字 |
| `--accent` | `#eef1ec` | 悬停态背景（极浅绿） |
| `--accent-foreground` | `#2f4a3c` | |
| `--destructive` | 保持现有默认红（`oklch(0.577 0.245 27.325)`） | 危险操作色不需要跟着"高贵"改，保留通用红色语义 |
| `--border` / `--input` | `#e6e1d5` / `#ddd7c8` | 描边 |
| `--ring` | `#2f4a3c` | 聚焦环，跟主色一致 |
| `--sidebar` | `#efeadf` | 侧边栏底色 |
| `--sidebar-foreground` | `#5a5648` | 侧边栏默认文字 |
| `--sidebar-primary` | `#2f4a3c` | |
| `--sidebar-primary-foreground` | `#f7f4ee` | |
| `--sidebar-accent` | `#ffffff` | 侧边栏激活项底色（比侧边栏底色亮，制造"选中卡片"感） |
| `--sidebar-accent-foreground` | `#2f4a3c` | 激活项文字/图标色 |
| `--sidebar-border` | `#e0dbcd` | |
| `--sidebar-ring` | `#2f4a3c` | |

**深色（墨感）**

| 变量 | 值 |
|---|---|
| `--background` | `#1c1d1a` |
| `--foreground` | `#e8e5db` |
| `--card` / `--popover` | `#232420` |
| `--card-foreground` / `--popover-foreground` | `#e8e5db` |
| `--primary` | `#4f7864`（比浅色版更亮，保证深底可读） |
| `--primary-foreground` | `#eef7f1` |
| `--secondary` / `--muted` | `#2a2b26` |
| `--secondary-foreground` | `#e8e5db` |
| `--muted-foreground` | `#8f8b7d` |
| `--accent` | `#2a2b26` |
| `--accent-foreground` | `#7fbf9e` |
| `--destructive` | 保持现有深色默认红（`oklch(0.704 0.191 22.216)`） |
| `--border` / `--input` | `#302f2a` |
| `--ring` | `#7fbf9e` |
| `--sidebar` | `#232420` |
| `--sidebar-foreground` | `#a7a396` |
| `--sidebar-primary` | `#4f7864` |
| `--sidebar-primary-foreground` | `#eef7f1` |
| `--sidebar-accent` | `#2a2b26` |
| `--sidebar-accent-foreground` | `#7fbf9e` |
| `--sidebar-border` | `#302f2a` |
| `--sidebar-ring` | `#7fbf9e` |

**圆角**：现有 `--radius: 0.625rem` 略微收紧到 `0.5rem`——过大的圆角偏"可爱/休闲"，收紧一点更贴"高贵/克制"的气质，同时也更符合"轻量级"（视觉上不那么"胖"）。

**字体**：不引入新字体，继续用现有 `Geist Variable`（已经是简洁的无衬线字体，符合"轻量级"），不做"墨色书房"方向设想过的衬线标题——那个方向没被选中。

## 侧边栏外壳与导航结构

新增 `src/components/AppShell.tsx`：登录成功后，`App.tsx` 只渲染一个 `<AppShell />`（原来 `main`/`settings`/`passwords`/`tasks`/`taskDetail` 五个 `View` 状态收敛成一个 `'app'`）。`AppShell` 内部自己管理"当前面板"状态，不再需要整屏切换：

```
type Pane = 'files' | 'passwords' | 'tasks' | 'settings'
```

侧边栏分四组，每组一个 `lucide-react` 图标 + 文字：

- **文件** — 加密 / 解密（面板 `files`）
- **账户** — 密码管理（面板 `passwords`）
- **自动化** — 自动任务（面板 `tasks`）
- **其它** — 设置（面板 `settings`）

`任务详情`不是独立面板，是 `tasks` 面板内部的子状态（`AppShell` 里已有的 `TaskListScreen`/`TaskDetailScreen` 切换逻辑原样保留，只是外层从"整屏视图"变成"tasks 面板内部视图"），详情页顶部用面包屑"自动任务 / <任务描述>"代替原来的"返回"按钮。

**设置面板的安全行为必须原样保留**：现在点击"设置"要先过一次 `ensureFreshlyUnlocked()`（强制重新验证一个解锁因子，不走静默指纹）。这不是一个孤立函数——它依赖 `MainScreen.tsx` 里配套的一整套状态和 JSX：`unlockDialogOpen` state、`unlockResolverRef`、`handleUnlockDialogOpenChange`/`handleUnlocked` 两个处理函数，以及渲染出来的 `<UnlockDialog open={unlockDialogOpen} onOpenChange={handleUnlockDialogOpenChange} onUnlocked={handleUnlocked} />` 本身。这一整套（函数 + state + `UnlockDialog` 渲染）要整体从 `MainScreen`/`FilesPane` 搬到 `AppShell`，不是只搬 `ensureFreshlyUnlocked` 这一个函数——搬漏了 `UnlockDialog` 的话"设置要求重新验证"这个安全行为会直接失效或者报错。触发点从按钮点击变成侧边栏"设置"导航项的点击。

**文件重命名**：`MainScreen.tsx` 改名为 `FilesPane.tsx`（不再是"主屏幕"，只是四个面板之一，改名避免误导），内容不变（加密/解密按钮、批量进度条、删除源文件选项），只是去掉原来它自己承担的导航职责（`onOpenSettings`/`onOpenPasswords`/`onOpenTasks` 三个 prop 删除，这些导航现在是 `AppShell` 侧边栏的事；`ensureFreshlyUnlocked`/`UnlockDialog` 那一整套按上一节说的搬去 `AppShell`）。

`SettingsScreen.tsx`/`PasswordScreen.tsx`/`TaskListScreen.tsx` 的 `onBack` prop 直接删除——它们的"返回"按钮只是单纯跳回上一屏，现在导航都在侧边栏，这个按钮和 prop 一起删掉。

`TaskDetailScreen.tsx` 的 `onBack` **不能整个删掉**：它不只是那个"返回"按钮的点击回调，`merge()` 和 `discard()` 成功之后也会程序化调用它跳回任务列表——这条自动返回的行为要保留。做法：`onBack` prop 保留（改不改名都行，含义不变——合并/丢弃成功后自动调用），只是组件内部原来那个显式的"返回"`<Button>`删掉（面包屑导航在 `AppShell` 里、`TaskDetailScreen` 外层渲染，点击面包屑调用的也是这同一个 `onBack`）。

## 面板内部布局调整

现有四个面板组件（`SettingsScreen`/`PasswordScreen`/`TaskListScreen`/`TaskDetailScreen`）的外层都是：

```tsx
<div className="flex min-h-screen items-center justify-center bg-background p-10">
  <Card className="w-[440px]"> {/* 或 w-[680px] */}
```

这是"整屏独立卡片"的布局，塞进侧边栏内容区后卡片两侧会留大片空白、比例失衡。改成贴合内容区的布局：

```tsx
<div className="mx-auto max-w-3xl p-8">
```

去掉 `Card` 外壳的居中定位和固定宽度限制，内容直接用内容区宽度（上限 `max-w-3xl` 防止极宽窗口下内容被拉得太长影响可读性）。`FilesPane.tsx` 同样处理。各面板内部现有的表单/列表/按钮结构不变，只改这层外壳。

## 登录 / 设置向导

`LoginScreen.tsx` 和 `SetupWizard.tsx` 保持现在"整屏居中固定宽度卡片"的结构不变——这两个场景本来就没有导航需求（还没登录，谈不上"分区"），改成贴边布局反而不自然。它们不需要额外代码改动：颜色令牌一换，自动吃到新配色。

## 窗口尺寸

`modules/file_vault/ui/electron/main.ts` 里 `BrowserWindow` 构造参数：

```ts
width: 1000, height: 720
```

改为：

```ts
width: 1140, height: 760
```

给侧边栏（约 150-160px）留出空间，避免内容区被压缩。

## 范围之外（本次不做）

- 不改后端/RPC 协议、不改任何业务逻辑，纯前端视觉与布局改动。
- 不做主题切换开关（UI 里没有手动切换深浅色的按钮）——完全跟随系统，这是本次讨论确认的范围。
- 不引入新的字体/图标库依赖（`lucide-react`、`Geist Variable`、`next-themes` 都已经是现有依赖）。
- 不对"分级自动"等自动任务模块的业务功能做任何改动，只改它所在面板的外壳布局。
- 不做响应式/窗口自由缩放的精细适配，仍然是固定初始窗口尺寸（沿用现有做法，只是数值改了）。

## 验证方式

- `tsc --noEmit` 确认所有改动后的组件类型正确。
- 手动验证（无法自动化）：`npm run dev` 走一遍登录 → 四个面板切换 → 设置面板仍然要求重新验证 → 任务详情面包屑返回 → 系统深浅色切换后应用跟着变。
