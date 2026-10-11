# file_vault UI 视觉重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `modules/file_vault/ui/` 从"shadcn 默认主题 + 整屏返回式导航"改造成"纸感留白/墨感双色主题 + 常驻侧边栏分区导航"，体现"轻量级、直观、高贵"。

**Architecture:** 颜色靠 `src/index.css` 的 CSS 变量整体替换生效（组件层几乎不用碰）；导航结构靠新增 `AppShell.tsx`（侧边栏 + 面板切换）替代 `App.tsx` 原来的"整屏视图堆栈"模型，四个原有全屏组件瘦身成"内容面板"。

**Tech Stack:** React 18 + TypeScript + Vite + shadcn/ui（CSS 变量驱动主题）+ Tailwind v4 + `next-themes`（已是依赖，本次首次真正接线）+ `lucide-react`（已是依赖）+ Electron。

**没有前端测试框架**：这个项目此前明确决定不引入 Vitest/Playwright（纯手动走查 + `tsc --noEmit`），本计划延续这个约定——每个任务的"验证"步骤是类型检查通过，不是跑测试。

---

## Task 1: 颜色令牌与圆角（`index.css`）

**Files:**
- Modify: `modules/file_vault/ui/src/index.css`

这一步独立、风险最低——纯 CSS 变量替换，所有组件自动生效，不涉及任何 `.tsx` 改动。

- [ ] **Step 1**: 把 `:root` 块（第 51-84 行）里除 `--radius`/`--chart-*` 之外的所有颜色变量值替换成下表（浅色·纸感留白），`--radius` 从 `0.625rem` 改成 `0.5rem`，`--chart-*` 不动（当前没在用）：

```css
:root {
    --background: #f7f4ee;
    --foreground: #2b2a26;
    --card: #ffffff;
    --card-foreground: #2b2a26;
    --popover: #ffffff;
    --popover-foreground: #2b2a26;
    --primary: #2f4a3c;
    --primary-foreground: #f7f4ee;
    --secondary: #efeadf;
    --secondary-foreground: #2b2a26;
    --muted: #efeadf;
    --muted-foreground: #8a8575;
    --accent: #eef1ec;
    --accent-foreground: #2f4a3c;
    --destructive: oklch(0.577 0.245 27.325);
    --border: #e6e1d5;
    --input: #ddd7c8;
    --ring: #2f4a3c;
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --radius: 0.5rem;
    --sidebar: #efeadf;
    --sidebar-foreground: #5a5648;
    --sidebar-primary: #2f4a3c;
    --sidebar-primary-foreground: #f7f4ee;
    --sidebar-accent: #ffffff;
    --sidebar-accent-foreground: #2f4a3c;
    --sidebar-border: #e0dbcd;
    --sidebar-ring: #2f4a3c;
}
```

- [ ] **Step 2**: 把 `.dark` 块（第 86-118 行）替换成下表（深色·墨感），`--chart-*` 同样不动：

```css
.dark {
    --background: #1c1d1a;
    --foreground: #e8e5db;
    --card: #232420;
    --card-foreground: #e8e5db;
    --popover: #232420;
    --popover-foreground: #e8e5db;
    --primary: #4f7864;
    --primary-foreground: #eef7f1;
    --secondary: #2a2b26;
    --secondary-foreground: #e8e5db;
    --muted: #2a2b26;
    --muted-foreground: #8f8b7d;
    --accent: #2a2b26;
    --accent-foreground: #7fbf9e;
    --destructive: oklch(0.704 0.191 22.216);
    --border: #302f2a;
    --input: #302f2a;
    --ring: #7fbf9e;
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: #232420;
    --sidebar-foreground: #a7a396;
    --sidebar-primary: #4f7864;
    --sidebar-primary-foreground: #eef7f1;
    --sidebar-accent: #2a2b26;
    --sidebar-accent-foreground: #7fbf9e;
    --sidebar-border: #302f2a;
    --sidebar-ring: #7fbf9e;
}
```

- [ ] **Step 3**: 类型检查（这步不会因为纯 CSS 改动而报错，只是确认没有连带破坏别的东西）

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无输出（无错误）

- [ ] **Step 4**: Commit

```bash
git add modules/file_vault/ui/src/index.css
git commit -m "Replace shadcn default theme with paper-minimal light/ink dark palette"
```

---

## Task 2: 深色模式跟随系统（`next-themes` 接线）

**Files:**
- Modify: `modules/file_vault/ui/src/main.tsx`

`next-themes` 已经是依赖（`sonner.tsx` 已经在用它的 `useTheme()`），但从没有 `ThemeProvider` 包裹过应用，深色模式实际上从未生效。

- [ ] **Step 1**: 把 `main.tsx` 改成：

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)
```

- [ ] **Step 2**: 类型检查

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无输出（无错误）

- [ ] **Step 3**: Commit

```bash
git add modules/file_vault/ui/src/main.tsx
git commit -m "Wire up next-themes ThemeProvider to follow system light/dark mode"
```

---

## Task 3: 窗口尺寸

**Files:**
- Modify: `modules/file_vault/ui/electron/main.ts`

- [ ] **Step 1**: 找到 `createWindow()` 里的 `BrowserWindow` 构造参数：

```ts
width: 1000,
height: 720,
```

改成：

```ts
width: 1140,
height: 760,
```

- [ ] **Step 2**: 类型检查

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无输出（无错误）

- [ ] **Step 3**: Commit

```bash
git add modules/file_vault/ui/electron/main.ts
git commit -m "Widen window to fit the new sidebar shell"
```

---

## Task 4: 四个面板组件——去掉整屏卡片外壳、去掉各自的导航 props

**Files:**
- Modify: `modules/file_vault/ui/src/components/MainScreen.tsx`（改名为 `FilesPane.tsx`）
- Modify: `modules/file_vault/ui/src/components/SettingsScreen.tsx`
- Modify: `modules/file_vault/ui/src/components/PasswordScreen.tsx`
- Modify: `modules/file_vault/ui/src/components/TaskListScreen.tsx`
- Modify: `modules/file_vault/ui/src/components/TaskDetailScreen.tsx`

**这个任务做完之后 `tsc --noEmit` 会报错**——`App.tsx` 还在用这些组件的旧 props（`onOpenSettings`/`onOpenPasswords`/`onOpenTasks`/`onBack` 等），Task 5（新建 `AppShell.tsx`）和 Task 6（重写 `App.tsx`）做完才会恢复绿。**这三个任务（4/5/6）改完再一起跑一次 `tsc --noEmit`、一起 commit**，中途不要单独 commit Task 4——半改的状态提交了后面容易搞不清哪个 commit 是"能跑的"。

- [ ] **Step 1**: 把 `MainScreen.tsx` 重命名/新建为 `FilesPane.tsx`（用 `git mv` 保留历史）：

```bash
git mv modules/file_vault/ui/src/components/MainScreen.tsx modules/file_vault/ui/src/components/FilesPane.tsx
```

- [ ] **Step 2**: 编辑 `FilesPane.tsx`：
  - 组件签名从 `MainScreen({ onOpenSettings, onOpenPasswords, onOpenTasks }: {...})` 改成 `FilesPane()`（无 props）。
  - 删除 `unlockDialogOpen`/`unlockResolverRef`/`ensureFreshlyUnlocked`/`handleUnlockDialogOpenChange`/`handleUnlocked`（这一整套搬去 `AppShell.tsx`，Task 5 会重新实现）。
  - 删除 `handleSettings`/`handlePasswords`/`handleTasks` 三个函数，以及 JSX 里对应的"设置"/"密码管理"/"自动任务"三个 `<Button>`（导航现在是侧边栏的事）。
  - 删除 `import { UnlockDialog } from '@/components/UnlockDialog'`（不再需要）。
  - 外层容器从：
    ```tsx
    <div className="flex min-h-screen items-center justify-center bg-background p-10">
      <Card className="w-[440px]">
        <CardHeader>
          <CardTitle className="text-2xl">Ideal1 File Vault</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* ...加密/解密按钮和进度条... */}
        </CardContent>
      </Card>
      <UnlockDialog ... />
    </div>
    ```
    改成：
    ```tsx
    <div className="mx-auto max-w-3xl space-y-3 p-8">
      <h2 className="text-2xl font-medium">加密 / 解密</h2>
      {/* ...加密/解密按钮和进度条，内容不变... */}
    </div>
    ```
  - 删除 `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'`（不再用 Card 包一层，面板本身已经在有边界的内容区里，不需要再嵌一层卡片，参考视觉稿）。

  完整的新文件内容：

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import type { VaultMethods } from '@/shared/ipcTypes'

type FileMethod = 'encrypt_file' | 'decrypt_file'

function dirnameWithSeparator(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return idx === -1 ? '' : fullPath.slice(0, idx + 1)
}

function basename(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return idx === -1 ? fullPath : fullPath.slice(idx + 1)
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

interface BatchItem {
  input_path: string
  output_path: string
}

interface BatchProgressState {
  fileIndex: number
  totalFiles: number
  fileName: string
  chunkDone: number
  chunkTotal: number
}

export function FilesPane() {
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null)
  const [deleteSourceOnEncrypt, setDeleteSourceOnEncrypt] = useState(false)
  const [deleteSourceOnDecrypt, setDeleteSourceOnDecrypt] = useState(false)

  async function runBatch(
    method: FileMethod,
    items: BatchItem[],
    label: string,
    withDeleteSource: boolean,
    preFailures: { fileName: string; error: string }[] = [],
  ) {
    setBusyLabel(label)
    const results: { fileName: string; ok: boolean; error?: string }[] = preFailures.map((f) => ({
      fileName: f.fileName,
      ok: false,
      error: f.error,
    }))

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const fileName = basename(item.input_path)
      setBatchProgress({ fileIndex: i + 1, totalFiles: items.length, fileName, chunkDone: 0, chunkTotal: 0 })

      const unsubscribe = vaultApi.onProgress((payload) => {
        if (payload.method === method) {
          setBatchProgress((s) => (s ? { ...s, chunkDone: payload.done, chunkTotal: payload.total } : s))
        }
      })

      try {
        const params: VaultMethods[FileMethod]['params'] = withDeleteSource ? { ...item, delete_source: true } : item
        const res = await vaultApi.call(method, params as never)
        results.push({ fileName, ok: res.ok, error: res.ok ? undefined : res.error })
      } finally {
        unsubscribe()
      }
    }

    setBusyLabel(null)
    setBatchProgress(null)

    const failed = results.filter((r) => !r.ok)
    const openFolderTarget = items.length === 1 ? items[0].output_path : dirnameWithSeparator(items[0].output_path)
    if (failed.length === 0) {
      toast.success(`${label}完成：${results.length} 个文件`, {
        action: { label: '打开所在文件夹', onClick: () => electronApi.showItemInFolder(openFolderTarget) },
      })
    } else {
      toast.error(`${label}完成 ${results.length - failed.length}/${results.length}，${failed.length} 个失败`, {
        description: failed.map((f) => `${f.fileName}：${f.error}`).join('\n'),
      })
    }
  }

  async function handleEncrypt() {
    const inputPaths = await electronApi.openFiles({
      title: '选择要加密的文件（可多选）',
      properties: ['openFile', 'multiSelections'],
    })
    if (!inputPaths || inputPaths.length === 0) return

    if (inputPaths.length === 1) {
      const inputPath = inputPaths[0]
      const fileName = basename(inputPath)
      const outputPath = await electronApi.saveFile({
        title: '保存加密文件为',
        defaultPath: `${dirnameWithSeparator(inputPath)}${fileName}.ivault`,
      })
      if (!outputPath) return
      await runBatch(
        'encrypt_file',
        [{ input_path: inputPath, output_path: outputPath }],
        '加密',
        deleteSourceOnEncrypt,
      )
    } else {
      const outDir = await electronApi.openDirectory({ title: '选择加密文件的保存目录' })
      if (!outDir) return
      const items = inputPaths.map((p) => ({ input_path: p, output_path: joinPath(outDir, `${basename(p)}.ivault`) }))
      await runBatch('encrypt_file', items, '加密', deleteSourceOnEncrypt)
    }
  }

  async function handleDecrypt() {
    const inputPaths = await electronApi.openFiles({
      title: '选择要解密的文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Ideal1 Vault', extensions: ['ivault'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!inputPaths || inputPaths.length === 0) return

    const originalNames: Record<string, string> = {}
    const headerFailures: { fileName: string; error: string }[] = []
    for (const p of inputPaths) {
      const res = await vaultApi.call('read_header', { input_path: p })
      if (!res.ok) {
        headerFailures.push({ fileName: basename(p), error: res.error })
      } else {
        originalNames[p] = res.header.original_filename
      }
    }

    const validPaths = inputPaths.filter((p) => p in originalNames)
    if (validPaths.length === 0) {
      toast.error(`解密失败：选中的 ${headerFailures.length} 个文件都不是有效的加密文件`, {
        description: headerFailures.map((f) => `${f.fileName}：${f.error}`).join('\n'),
      })
      return
    }

    if (validPaths.length === 1) {
      const inputPath = validPaths[0]
      const outputPath = await electronApi.saveFile({
        title: '解密后保存为',
        defaultPath: `${dirnameWithSeparator(inputPath)}${originalNames[inputPath]}`,
      })
      if (!outputPath) return
      await runBatch(
        'decrypt_file',
        [{ input_path: inputPath, output_path: outputPath }],
        '解密',
        deleteSourceOnDecrypt,
        headerFailures,
      )
    } else {
      const outDir = await electronApi.openDirectory({ title: '选择解密后的保存目录' })
      if (!outDir) return
      const items = validPaths.map((p) => ({ input_path: p, output_path: joinPath(outDir, originalNames[p]) }))
      await runBatch('decrypt_file', items, '解密', deleteSourceOnDecrypt, headerFailures)
    }
  }

  const showProgress = busyLabel !== null

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-8">
      <h2 className="text-2xl font-medium">加密 / 解密</h2>
      <Button className="w-full" onClick={handleEncrypt} disabled={showProgress}>
        加密文件...（可多选）
      </Button>
      <div className="flex items-start gap-2 pt-1">
        <Checkbox
          id="delete-source-encrypt"
          checked={deleteSourceOnEncrypt}
          onCheckedChange={(v) => setDeleteSourceOnEncrypt(v === true)}
          disabled={showProgress}
          className="mt-0.5"
        />
        <Label htmlFor="delete-source-encrypt" className="text-sm font-normal leading-snug">
          加密后安全删除原始文件（覆写后删除，不进回收站，无法恢复）
        </Label>
      </div>
      <Button className="w-full" onClick={handleDecrypt} disabled={showProgress}>
        解密文件...（可多选）
      </Button>
      <div className="flex items-start gap-2 pt-1">
        <Checkbox
          id="delete-source-decrypt"
          checked={deleteSourceOnDecrypt}
          onCheckedChange={(v) => setDeleteSourceOnDecrypt(v === true)}
          disabled={showProgress}
          className="mt-0.5"
        />
        <Label htmlFor="delete-source-decrypt" className="text-sm font-normal leading-snug">
          解密后删除加密文件（覆写后删除，不进回收站，无法恢复）
        </Label>
      </div>
      {showProgress && batchProgress && (
        <div className="space-y-2 pt-2">
          <p className="text-sm text-muted-foreground">
            {busyLabel}中...（{batchProgress.fileIndex}/{batchProgress.totalFiles}）{batchProgress.fileName}
            {batchProgress.chunkTotal > 0 ? ` — ${batchProgress.chunkDone}/${batchProgress.chunkTotal} 分块` : ''}
          </p>
          <Progress
            value={batchProgress.chunkTotal > 0 ? (batchProgress.chunkDone / batchProgress.chunkTotal) * 100 : 0}
          />
          {batchProgress.totalFiles > 1 && (
            <Progress
              value={((batchProgress.fileIndex - 1) / batchProgress.totalFiles) * 100}
              className="opacity-50"
            />
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3**: 编辑 `SettingsScreen.tsx`：组件签名从 `SettingsScreen({ onBack }: { onBack: () => void })` 改成 `SettingsScreen()`；删除 `onBack` 对应的最后一个"返回"`<Button>`；外层容器同 `FilesPane` 的模式替换（`mx-auto max-w-3xl space-y-3 p-8` + `<h2 className="text-2xl font-medium">设置</h2>`，去掉 `Card`/`CardHeader`/`CardTitle`/`CardContent` 包裹，删掉对应 import）。文件顶部"Opened only after MainScreen has already unlocked..."那条注释提到的是搬走之前的旧结构，顺手改成提"AppShell"而不是"MainScreen"。内部四个 `xxxDialog` 子组件和 `handleRebindFingerprint` 逻辑不变。

- [ ] **Step 4**: 编辑 `PasswordScreen.tsx`：组件签名从 `PasswordScreen({ onBack }: { onBack: () => void })` 改成 `PasswordScreen()`；删除"返回"按钮；外层容器同样模式替换（标题"密码管理"），删除 `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'`（这个项目 `tsconfig.json` 开了 `noUnusedLocals`，留着没用到的 import 会直接编译报错）；`PasswordEditDialog` 子组件不变。

- [ ] **Step 5**: 编辑 `TaskListScreen.tsx`：
  - 组件签名从 `TaskListScreen({ onBack, onOpenTask }: { onBack: () => void; onOpenTask: (taskId: string) => void })` 改成 `TaskListScreen({ onOpenTask }: { onOpenTask: (taskId: string, description: string) => void })`——`onOpenTask` 多带一个 `description` 参数，`AppShell` 的面包屑要用它，不用再多发一次请求去查任务描述。
  - 任务卡片的 `onClick={() => onOpenTask(t.task_id)}` 改成 `onClick={() => onOpenTask(t.task_id, t.description)}`。
  - 删除"返回"按钮和 `onBack` 相关代码。
  - 外层容器模式替换（标题"自动任务"），删除 `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'`（同上，`noUnusedLocals` 会因为没用到的 import 报错）。
  - `CreateTaskDialog` 子组件不变。

- [ ] **Step 6**: 编辑 `TaskDetailScreen.tsx`：
  - `onBack` prop **保留**（`merge()`/`discard()` 成功后还会调用它跳回列表，见第 94/104 行），签名不变：`TaskDetailScreen({ taskId, onBack }: { taskId: string; onBack: () => void })`。
  - **只删除**组件内部显式渲染的"返回"`<Button>`（原第 167-169 行那个），`onBack` 函数本身和 `merge`/`discard` 里调用 `onBack()` 的地方都不动。
  - 外层容器模式替换（不需要标题了，因为 `AppShell` 会在外面渲染面包屑，`CardTitle` 里原来带的任务状态文字挪一下——保留在内容顶部用一个 `<p>` 展示，不用 `h2`，因为面包屑已经是页面标题级别的东西）：
    ```tsx
    <div className="mx-auto max-w-3xl space-y-3 p-8">
      <p className="text-sm text-muted-foreground">{status ? `状态：${status}` : ''}</p>
      {/* ...日志区、WAITING_INPUT/QUOTA_BLOCKED/FAILED/DONE_PENDING_REVIEW 各状态区块，内容不变... */}
    </div>
    ```
  - 删除 `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'`。

**这个任务先不要跑 tsc、先不要 commit**——继续做 Task 5、Task 6。

---

## Task 5: 新增 `AppShell.tsx`（侧边栏 + 面板切换 + 解锁弹窗迁移）

**Files:**
- Create: `modules/file_vault/ui/src/components/AppShell.tsx`

- [ ] **Step 1**: 新建文件：

```tsx
import { useRef, useState } from 'react'
import { Bot, KeyRound, Lock, Settings as SettingsIcon } from 'lucide-react'
import { FilesPane } from '@/components/FilesPane'
import { SettingsScreen } from '@/components/SettingsScreen'
import { PasswordScreen } from '@/components/PasswordScreen'
import { TaskListScreen } from '@/components/TaskListScreen'
import { TaskDetailScreen } from '@/components/TaskDetailScreen'
import { UnlockDialog } from '@/components/UnlockDialog'
import { cn } from '@/lib/utils'

type Pane = 'files' | 'passwords' | 'tasks' | 'settings'

interface NavItem {
  pane: Pane
  label: string
  icon: typeof Lock
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  { label: '文件', items: [{ pane: 'files', label: '加密 / 解密', icon: Lock }] },
  { label: '账户', items: [{ pane: 'passwords', label: '密码管理', icon: KeyRound }] },
  { label: '自动化', items: [{ pane: 'tasks', label: '自动任务', icon: Bot }] },
  { label: '其它', items: [{ pane: 'settings', label: '设置', icon: SettingsIcon }] },
]

export function AppShell() {
  const [pane, setPane] = useState<Pane>('files')
  const [activeTask, setActiveTask] = useState<{ id: string; description: string } | null>(null)

  // 从原 MainScreen 搬过来的一整套：ensureFreshlyUnlocked 不是孤立函数，
  // 依赖这份 state + UnlockDialog 一起工作。点"设置"要求重新验证一个解锁
  // 因子（不走静默指纹），这是刻意的安全行为，不能只搬函数不搬弹窗。
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false)
  const unlockResolverRef = useRef<((ok: boolean) => void) | null>(null)

  async function ensureFreshlyUnlocked(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      unlockResolverRef.current = resolve
      setUnlockDialogOpen(true)
    })
  }

  function handleUnlockDialogOpenChange(open: boolean) {
    setUnlockDialogOpen(open)
    if (!open && unlockResolverRef.current) {
      unlockResolverRef.current(false)
      unlockResolverRef.current = null
    }
  }

  function handleUnlocked() {
    unlockResolverRef.current?.(true)
    unlockResolverRef.current = null
  }

  async function handleNavClick(target: Pane) {
    if (target === 'settings' && !(await ensureFreshlyUnlocked())) return
    setActiveTask(null)
    setPane(target)
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="w-[160px] shrink-0 border-r border-sidebar-border bg-sidebar py-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-1">
            <p className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon
              const active = pane === item.pane
              return (
                <button
                  key={item.pane}
                  onClick={() => handleNavClick(item.pane)}
                  className={cn(
                    'flex w-full items-center gap-2 px-4 py-2 text-sm transition-colors',
                    active
                      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </aside>

      <main className="flex-1 overflow-y-auto">
        {pane === 'files' && <FilesPane />}
        {pane === 'passwords' && <PasswordScreen />}
        {pane === 'tasks' && !activeTask && (
          <TaskListScreen onOpenTask={(id, description) => setActiveTask({ id, description })} />
        )}
        {pane === 'tasks' && activeTask && (
          <div>
            <div className="mx-auto flex max-w-3xl items-center gap-1.5 px-8 pt-6 text-sm text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => setActiveTask(null)}>
                自动任务
              </button>
              <span>/</span>
              <span className="truncate text-foreground">{activeTask.description}</span>
            </div>
            <TaskDetailScreen taskId={activeTask.id} onBack={() => setActiveTask(null)} />
          </div>
        )}
        {pane === 'settings' && <SettingsScreen />}
      </main>

      <UnlockDialog open={unlockDialogOpen} onOpenChange={handleUnlockDialogOpenChange} onUnlocked={handleUnlocked} />
    </div>
  )
}
```

**先不要跑 tsc、先不要 commit**——继续做 Task 6，`App.tsx` 改完才是完整的绿色状态。

---

## Task 6: `App.tsx` 收敛视图状态，渲染 `AppShell`

**Files:**
- Modify: `modules/file_vault/ui/src/App.tsx`

- [ ] **Step 1**: 把整个文件替换成：

```tsx
import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { SetupWizard } from '@/components/SetupWizard'
import { LoginScreen } from '@/components/LoginScreen'
import { AppShell } from '@/components/AppShell'
import { vaultApi } from '@/lib/vaultApi'

type View = 'loading' | 'setup' | 'login' | 'app'

function App() {
  const [view, setView] = useState<View>('loading')

  useEffect(() => {
    vaultApi.call('identity_exists', {}).then((res) => setView(res.exists ? 'login' : 'setup'))
  }, [])

  return (
    <>
      {view === 'loading' && <div className="flex min-h-screen items-center justify-center bg-background" />}
      {view === 'setup' && <SetupWizard onComplete={() => setView('app')} />}
      {view === 'login' && <LoginScreen onUnlocked={() => setView('app')} />}
      {view === 'app' && <AppShell />}
      <Toaster />
    </>
  )
}

export default App
```

- [ ] **Step 2**: 现在跑一次完整类型检查（这是 Task 4/5/6 合起来第一次验证）：

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无输出（无错误）。如果报错，大概率是 Task 4 某个面板的 props 改动和 `AppShell.tsx` 里的调用对不上，逐个错误信息核对。

- [ ] **Step 3**: Commit（Task 4/5/6 一起提交，因为中间状态编译不过，见上面说明）

```bash
git add modules/file_vault/ui/src/components/FilesPane.tsx \
        modules/file_vault/ui/src/components/SettingsScreen.tsx \
        modules/file_vault/ui/src/components/PasswordScreen.tsx \
        modules/file_vault/ui/src/components/TaskListScreen.tsx \
        modules/file_vault/ui/src/components/TaskDetailScreen.tsx \
        modules/file_vault/ui/src/components/AppShell.tsx \
        modules/file_vault/ui/src/App.tsx
git status  # 确认 MainScreen.tsx 显示为 renamed，不是单独的 delete
git commit -m "Replace full-screen view stack with persistent sidebar shell (AppShell)"
```

---

## Task 7: 最终验证清单（手动，无法自动化）

**Files:** 无新文件，验证性任务。

- [ ] **Step 1**: 全量类型检查

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 2**: `npm run dev` 走一遍：
  - 登录后直接落在"加密/解密"面板（侧边栏"文件"分组高亮）。
  - 依次点侧边栏"密码管理"/"自动任务"/"设置"，确认内容区正确切换，侧边栏当前项高亮跟着变。
  - 点"设置"要弹出重新验证身份的对话框（这是刻意保留的安全行为），验证通过才能进设置面板。
  - 自动任务列表点进一个任务，顶部出现"自动任务 / <任务描述>"面包屑，点"自动任务"三个字能跳回列表。
  - 任务详情里合并或丢弃成功后，应该自动跳回任务列表（验证 `onBack` 保留生效）。
  - 系统深浅色模式切换（Windows 设置里切换应用深色模式），应用颜色应该跟着变，不需要重启应用。
  - 窗口应该是加宽后的尺寸，侧边栏和内容区不拥挤。

- [ ] **Step 3**: 如果想更新打包好的 exe：

```bash
cd modules/file_vault/ui && npm run build
```

## 范围之外（本次不做）

- 不改任何后端/RPC 逻辑，纯前端视觉与布局。
- 不做手动深浅色切换开关，完全跟随系统。
- `LoginScreen.tsx`/`SetupWizard.tsx` 不用改代码——颜色令牌换掉后自动生效，本计划没有它们的任务。
