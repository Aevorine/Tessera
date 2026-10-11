# Tessera 双视觉系统设计

日期：2026-07-28
状态：待用户复核

## 1. 目标

Tessera 同时提供两套可长期维护的视觉风格：

1. **Tessera 原生风格增强版**：保留当前暖白纸感、墨绿主色、细边框和大留白，只改善层级、状态表达和专业诊断布局。
2. **东方科技轻奢**：沿用相同的信息架构，在边缘加入低透明度祥云、电路纹、回纹、竹叶和山水水印。

两套风格均支持浅色、深色和跟随系统，并同时覆盖默认界面与专业诊断模式。桌面端、Android 手机和平板共享相同的语义和设置名称，布局按设备尺寸调整。

本设计不改变加密、解密、密钥、跨设备同步等业务协议。

## 2. 四个独立设置维度

为了避免「默认模式」同时指代界面密度和系统主题，设置界面使用四组不同名称。

| 设置组 | 选项 | 默认值 | 作用 |
|---|---|---|---|
| 界面模式 | 默认界面、专业诊断 | 默认界面 | 控制信息密度和诊断内容是否加载 |
| 视觉风格 | 原生增强、东方科技 | 原生增强 | 控制配色映射、字体和装饰层 |
| 颜色模式 | 跟随系统、浅色、深色 | 跟随系统 | 控制明暗主题 |
| 强调色 | 森林绿、天青、金色、橄榄绿 | 随视觉风格给出默认值 | 控制主按钮、选中态和图表主序列 |

四组设置互相独立。例如，用户可以选择：

- 专业诊断 + 原生增强 + 跟随系统 + 森林绿；
- 默认界面 + 东方科技 + 深色 + 金色；
- 专业诊断 + 东方科技 + 浅色 + 天青。

理论上存在 48 种组合，但实现不维护 48 套独立样式。所有组合都由语义令牌计算，避免复制 CSS 和 Android 资源。

## 3. 视觉风格

### 3.1 Tessera 原生风格增强版

保留当前界面的主要特征：

- 暖白或墨色背景；
- 墨绿为默认强调色；
- 细边框、弱阴影和大留白；
- 页面标题使用衬线字体，操作文字使用清晰的无衬线字体；
- 导航栏保持窄栏结构；
- 不增加明显纹样。

增强内容：

- 统一按钮高度、圆角、焦点环和禁用状态；
- 破坏性操作增加二次确认和结果摘要；
- 专业诊断模式在宽屏右侧显示指标栏；
- 窄窗口、手机端将诊断内容改为独立页面或可折叠区域；
- 四种强调色只作用于主操作、选中态和数据主序列，不改变成功、警告、危险等状态色语义。

### 3.2 东方科技轻奢

东方科技轻奢不是独立的信息架构，只替换视觉令牌并增加装饰层。正文、按钮位置、快捷键和操作流程与原生增强版一致。

素材使用规则：

| 素材 | 位置 | 透明度或面积限制 |
|---|---|---|
| 祥云纹 | 标题分隔、重点卡片角落 | 5%～7% |
| 电路纹 | 页面顶部、专业面板边缘 | 6%～9% |
| 金色回纹 | 重点卡片顶部或左侧的 1 px 细线 | 金色面积不超过整体 6% |
| 竹叶 | 桌面和平板导航栏底部 | 4%～5% |
| 山水纹 | 专业诊断栏底部 | 4%～6% |
| 数据网格 | 图表区域 | 4%～7% |
| 发光节点 | 在线状态、当前设备、关键指标 | 静态微光，不使用持续脉冲 |
| 楼阁 | 启动页、关于页或空状态 | 日常操作页面不使用 |

装饰层不得穿过正文、表格、图表标签和按钮。Android 手机端只保留祥云分隔、电路纹和少量金色细线；平板端可以显示竹叶和山水水印。

## 4. 颜色系统

### 4.1 语义令牌

组件只读取语义令牌，不直接读取视觉风格名称：

```css
--background;
--foreground;
--card;
--card-foreground;
--primary;
--primary-foreground;
--secondary;
--muted;
--muted-foreground;
--accent;
--accent-foreground;
--border;
--input;
--ring;
--success;
--warning;
--destructive;
--info;
--chart-1;
--chart-2;
--chart-3;
--chart-4;
--chart-5;
```

现有 shadcn 组件继续使用这些令牌。视觉风格和强调色只改变令牌映射。

### 4.2 原生增强默认值

原生增强版继续以当前暖白和墨绿为基准。浅色背景保持 `#f7f4ee` 附近，深色背景保持 `#1c1d1a` 附近。

强调色映射：

| 强调色 | 浅色主色 | 深色主色 |
|---|---:|---:|
| 森林绿 | `#2f4a3c` | `#7fbf9e` |
| 天青 | `#347fa8` | `#70bfe5` |
| 金色 | `#8d6728` | `#d4b064` |
| 橄榄绿 | `#6f7847` | `#a7b27a` |

### 4.3 东方科技默认值

东方科技浅色：

| 令牌 | 值 |
|---|---:|
| `--background` | `#f4faf9` |
| `--card` | `#fffefd` |
| `--secondary` | `#edf7f5` |
| `--foreground` | `#17343d` |
| `--muted-foreground` | `#74888d` |
| `--border` | `#d9e7e5` |
| `--ring` | 当前强调色 |

东方科技深色：

| 令牌 | 值 |
|---|---:|
| `--background` | `#111a1b` |
| `--card` | `#182426` |
| `--secondary` | `#1d2d2f` |
| `--foreground` | `#edf6f5` |
| `--muted-foreground` | `#829a9c` |
| `--border` | `#2b4345` |
| `--ring` | 当前强调色 |

状态色不随强调色变化：

```css
--success: #238b63;
--warning: #c77b1c;
--destructive: #c94f4a;
--info: #347fa8;
```

深色模式使用亮度更高的对应值，但成功、警告、危险、信息的含义保持不变。

## 5. 字体

桌面端：

```css
--font-ui:
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "PingFang SC",
  "Noto Sans SC",
  sans-serif;

--font-title:
  "Source Han Serif SC",
  "Noto Serif SC",
  "Songti SC",
  "SimSun",
  serif;

--font-code:
  "Cascadia Code",
  "JetBrains Mono",
  "Consolas",
  monospace;
```

页面标题和东方纹样说明使用 `--font-title`；按钮、设置项、表格和正文使用 `--font-ui`；路径、哈希、日志和性能数据使用 `--font-code`。

正式版本不从网络加载字体。若项目未随安装包提供思源字体，则使用系统字体回退，避免字体下载影响启动速度和离线使用。

Android 使用系统无衬线字体显示正文。标题可使用随 APK 打包的单一衬线字体子集；如果字体子集增加的包体或首屏耗时不合格，则回退到系统字体。

## 6. 桌面端实现结构

当前桌面端已经使用 `next-themes`：

```tsx
<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
```

因此颜色模式继续使用现有机制：

- `system`：跟随操作系统；
- `light`：强制浅色；
- `dark`：强制深色。

新增外观状态：

```ts
type InterfaceMode = 'default' | 'professional'
type VisualStyle = 'native' | 'oriental-tech'
type AccentFamily = 'forest' | 'sky' | 'gold' | 'olive'
```

在 `<html>` 上应用：

```html
<html
  data-interface-mode="default"
  data-visual-style="native"
  data-accent="forest"
>
```

明暗模式仍由 `.dark` 类控制。CSS 按以下顺序覆盖：

1. 基础语义令牌；
2. 视觉风格；
3. 浅色或深色；
4. 强调色；
5. 组件状态。

新增建议模块：

| 模块 | 职责 |
|---|---|
| `lib/appearance.ts` | 类型、默认值、本地存储键和首屏应用函数 |
| `lib/appearanceContext.tsx` | React 上下文和设置更新 |
| `components/AppearanceSettings.tsx` | 四组外观设置 |
| `components/DecorativeLayer.tsx` | 东方科技本地 SVG 装饰层 |
| `components/ProfessionalDiagnostics.tsx` | 按需加载的专业指标区域 |

`main.tsx` 在 React 首次渲染前同步读取外观偏好并设置 `data-*` 属性，做法与现有字号首帧处理一致，防止启动时先显示默认风格再闪变。

## 7. Android 手机和平板

Android 当前使用 `AppCompatActivity`、XML 布局和 Material Components，不需要迁移到 Compose。

颜色模式使用：

```kotlin
AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
AppCompatDelegate.MODE_NIGHT_NO
AppCompatDelegate.MODE_NIGHT_YES
```

资源结构：

```text
res/values/colors.xml
res/values-night/colors.xml
res/values/styles.xml
res/values-night/styles.xml
res/drawable/
res/drawable-night/
```

两套视觉风格使用两个基础主题：

```text
Theme.Tessera.Native
Theme.Tessera.OrientalTech
```

四种强调色使用 Theme Overlay，不复制整套页面布局：

```text
ThemeOverlay.Tessera.Forest
ThemeOverlay.Tessera.Sky
ThemeOverlay.Tessera.Gold
ThemeOverlay.Tessera.Olive
```

用户切换视觉风格、颜色模式或强调色后，保存到 `SharedPreferences`，再安全重建当前 Activity。重建前不停止跨设备前台服务，也不清空任务状态。

手机布局：

- 默认界面只显示连接、配对、剪贴板、文件发送和最近记录；
- 专业诊断使用独立页面或折叠卡片；
- 不显示竹叶、山水和楼阁等大面积装饰；
- 触控区域不小于 48 dp。

平板布局：

- 左侧导航、中间主要操作、右侧专业诊断；
- 东方科技风格可以显示低透明度竹叶和山水；
- 横屏和竖屏使用不同的内容列数。

## 8. 默认界面与专业诊断

### 8.1 默认界面

默认界面不启动高频性能采样，首屏只加载当前页面需要的功能。

桌面端首页优先显示：

- 加密或解密主操作；
- 最近任务；
- 跨设备连接状态；
- 安全提醒；
- 常用快捷入口。

Android 首页优先显示：

- 本机名称和服务状态；
- 附近设备；
- 扫码配对；
- 发送剪贴板；
- 发送文件；
- 接收目录；
- 最近传输。

### 8.2 专业诊断

专业诊断模式按需加载：

- 界面响应时间；
- 进程内存；
- CPU 占用；
- 磁盘读写；
- 加密吞吐；
- 任务队列；
- 设备连接和传输状态；
- 安全检查结果；
- 最近错误和诊断日志。

专业模式的指标采样在页面不可见或应用进入后台时降频或暂停。关闭专业模式后释放图表定时器和观察器。

## 9. 性能要求

- 不使用外部 CDN、远程字体或运行时下载素材。
- 装饰 SVG 随应用打包；单个 SVG 建议不超过 20 KB，整套装饰素材目标不超过 100 KB。
- 简单回纹、电路纹和数据网格优先使用 CSS 或 Android VectorDrawable。
- 一个页面只挂载一个装饰层，不为每张卡片重复创建大型 SVG DOM。
- 装饰层使用 `pointer-events: none`，并限制在自己的绘制区域。
- 不使用 Canvas 粒子、持续模糊、视差滚动和自动播放动画。
- 状态过渡控制在 150～250 ms，并支持 `prefers-reduced-motion`。
- 专业诊断组件使用懒加载；默认界面不导入图表和高级诊断依赖。
- 目标是切换主题不触发页面级业务数据重新请求。

## 10. 安全要求

- SVG 仅使用仓库内静态资源或构建时生成的可信资源。
- 不使用 `dangerouslySetInnerHTML` 注入装饰 SVG。
- 不把文件名、路径、密钥、设备身份或诊断内容写入 SVG、CSS 和主题设置。
- 外观偏好只保存枚举值，不保存敏感数据。
- 内容安全策略继续禁止任意远程脚本和远程样式。
- 装饰层不接收输入事件，不参与拖放和文件选择。
- 主题切换不得绕过解锁、重新验证和破坏性操作确认。

## 11. 无障碍和易用性

- 正文对比度不低于 4.5:1；大文字和大图标不低于 3:1。
- 颜色不是唯一状态提示，必须配合文字或图标。
- 键盘焦点环保持可见。
- 图标按钮提供 `aria-label` 或 Android `contentDescription`。
- 桌面端点击目标不小于 40 px；Android 不小于 48 dp。
- 支持系统减少动态效果设置。
- 主题和风格切换后向辅助技术公布结果。
- RTL 语言下装饰层镜像或保持中性，不影响正文方向。

## 12. 设置界面

设置页新增「外观」分组，顺序固定：

1. 界面模式；
2. 视觉风格；
3. 颜色模式；
4. 强调色；
5. 装饰强度。

装饰强度只对东方科技风格生效：

```ts
type DecorationLevel = 'off' | 'subtle' | 'standard'
```

- `off`：关闭所有文化和科技装饰，只保留颜色与字体；
- `subtle`：透明度使用下限；
- `standard`：使用本设计规定的正常透明度；
- 不提供「浓重」档，防止破坏可读性。

「恢复默认外观」只重置外观偏好，不清空账户、密钥、任务或跨设备配置。

## 13. 迁移与兼容

- 现有用户没有新的偏好记录时，默认使用「默认界面 + 原生增强 + 跟随系统 + 森林绿」。
- 当前 `next-themes` 的 `theme` 本地记录继续有效。
- 外观配置增加版本号；遇到未知枚举值时回退到默认值。
- 切换版本不迁移业务数据库。
- 桌面端与 Android 各自保存外观偏好，不通过跨设备同步传播，避免一台设备的布局选择改变另一台设备。

## 14. 验收标准

### 自动验收

- A1：桌面端类型检查、Lint 和构建通过。
- A2：两套视觉风格都能在 `system`、`light`、`dark` 三种颜色模式下渲染。
- A3：四种强调色不会改变成功、警告、危险和信息色语义。
- A4：默认界面不加载专业诊断组件。
- A5：主题切换不会重新请求当前页面业务数据。
- A6：外观枚举异常时回退到默认值。
- A7：外观设置不会写入敏感数据。
- A8：Android 调试构建通过，三种颜色模式和两套视觉风格可以切换。
- A9：桌面端关键文字对比度达到 WCAG AA。
- A10：`prefers-reduced-motion` 下关闭非必要过渡。

### 人工验收

- H1：桌面端两套风格的浅色、深色和跟随系统模式观感符合原型。
- H2：Android 手机和平板的主要按钮容易点击，文字不被装饰遮挡。
- H3：默认界面操作简洁；专业诊断增加信息后仍能快速找到主操作。
- H4：切换风格和主题无明显闪烁、卡顿或布局跳动。

## 15. 原型

本地交互原型：

- Tessera 原生风格增强版：`.superpowers/brainstorm/ideal1-refresh-20260728-v3/tessera-evolution-v4.html`
- 东方科技轻奢：`.superpowers/brainstorm/ideal1-refresh-20260728-v3/oriental-tech-v5.html`

原型用于视觉确认，不直接复制进生产代码。生产实现使用现有 React、Tailwind、shadcn、next-themes、Android XML 和 Material Components。

## 16. 本阶段不做

- 不更换桌面端或 Android 技术栈。
- 不把所有视觉组合写成独立页面。
- 不从网络下载字体和装饰素材。
- 不增加复杂粒子、视频背景或持续发光动画。
- 不让外观设置参与跨设备同步。
- 不在本设计阶段修改加密协议、数据库或跨设备协议。
