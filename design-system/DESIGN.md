# sop-system 设计契约（DESIGN.md）

> 作者：颜好看 (UI/UX Designer) · v1.0.0 · 阶段：Phase 2 锁定产物
> 配套文件：`design-tokens.json`（DTCG，前端 import）· `design-tokens.css`（CSS 落地与兜底）
> 上游依据：`DIRECTION.md`（调研结论）+ `docs/SPEC-v1.0.md` §8（锁定值）

---

## 1. Visual Theme & Atmosphere

**设计语言：Blueprint Calm · 蓝图冷静**

三个品牌声音词（物理对象，非形容词）：
1. **蓝晒图纸**（cyanotype blueprint）—— 冷、蓝、线条即信息
2. **游标卡尺**（vernier caliper）—— 刻度精准、金属中性、数字可读
3. **调度室大屏**（dispatch board）—— 高密度、状态一眼可辨、无装饰

**设计寄存器**：Product 寄存器（设计服务产品，不是设计即产品）—— 标杆是"赢得熟悉感"，让 Linear / 飞书项目 / GitLab 老用户第一眼觉得可信。

**三轴刻度（已锁定）**：DESIGN_VARIANCE **3/10**（可预测，禁止非对称/Masonry，严格 12 列）· MOTION_INTENSITY **3/10**（功能性，0ms 往往最好，禁装饰动画）· VISUAL_DENSITY **7/10**（驾驶舱偏上，禁通用卡片盒子，用 divide-y / border-top / 负空间分组）。

**氛围一句话**：蓝晒图的冷静 + 游标卡尺的精准 + 调度室大屏的秩序。深冷蓝墨作单一强调色，中性灰承担 ≥90% 画面，AI 用「虚线材质」而非「彩色」标识。

**四条视觉法则**：
- L1 线条即结构：1px 线建立层级，不靠卡片盒子+阴影；列表/详情内部一律 `divide-y`。
- L2 颜色即信息：中性 ≥90%；accent 每屏 ≤2 处；语义色仅 3 个（成功/警告/危险），只用于状态不用于分类。
- L3 数字用等宽：单号/工时/等级/Token/耗时/日期全部 mono + tabular-nums。
- L4 AI 用材质区分不用颜色区分（见 §4 / 组件矩阵「AI 产物卡」）。

---

## 2. Color Palette & Roles

### 2.1 浅色（默认）

| Token | 值 | 角色 | 说明 |
|---|---|---|---|
| `--bg` | `#F5F7FA` | A1 | 冷调纸面（非奶油非米色，避开 warm-neutral 禁区） |
| `--surface` | `#FFFFFF` | A1 | 卡片/容器 |
| `--surface-2` | `#EEF2F6` | B | 表头/内嵌块/hover 底 |
| `--fg` | `#101724` | A1 | 近黑带蓝铸调，非纯黑 |
| `--fg-2` | `#3C4859` | B | 正文次级（≈9:1） |
| `--muted` | `#5D6B7E` | A1 | 5.05:1 on bg ✓ 12px 元数据安全线 |
| `--meta` | `#7A8798` | B | 3.40:1 仅图标/分隔/≥16px 弱化文本，禁 12px 正文 |
| `--border` | `#E2E7EE` | A1 | 默认边框 |
| `--border-soft` | `#EFF2F6` | B | 内部行分隔 |
| `--border-strong` | `#CBD3DE` | B | 强调分隔/图例 |
| `--accent` | `#0E62A8` | A1 | Cyanotype 工程蓝墨，6.30:1 ✓ 每屏 ≤2 处 |
| `--accent-on` | `#FFFFFF` | A2 | accent 底上的字 |
| `--accent-hover` | `#0D5897` | A2 | |
| `--accent-active` | `#0B508A` | A2 | |
| `--accent-wash` | `#0E62A814` | A2 | 选中底/弱高亮（8% 透明） |
| `--success` | `#12805C` | A2 | 4.92:1 深松绿 |
| `--warn` | `#B45309` | A2 | 5.02:1 深琥珀（文字/语义） |
| `--warn-bg` | `#F59E0B` | A2 | amber-500，**仅作背景填充**，配 `--warn-bg-ink` |
| `--warn-bg-ink` | `#7C3F00` | A2 | warn-bg 上的文字 |
| `--danger` | `#B3261E` | A2 | 6.53:1 砖红 |
| `--brand` | `#1E3A5F` | A1 | 品牌藏青：登录 Hero / 侧栏 logo 底 |
| `--brand-strong` | `#16293F` | B | |
| `--ai-surface` | `#F7F9FB` | C | AI「机器纸」冷灰底 |
| `--ai-ink` | `#3D4654` | C | AI mono 标签色（石墨） |
| `--ai-dash` | `#C3CCD8` | C | AI 虚线边框色 |

### 2.2 深色（对等，非反色 — 亮度阶梯法）

| Token | 值 |
|---|---|
| `--bg` | `#0E1116` |
| `--surface` | `#151A21` |
| `--surface-2` | `#1C222B` |
| `--surface-3` | `#262E39`（hover/抬升） |
| `--fg` | `#E9EEF5` |
| `--fg-2` | `#C3CCD9` |
| `--muted` | `#8B97A6` |
| `--meta` | `#626D7B` |
| `--border` | `rgba(255,255,255,0.07)` |
| `--border-strong` | `rgba(255,255,255,0.12)` |
| `--accent` | `#4FA6EE`（7.23:1 ✓） |
| `--accent-on` | `#06121D` |
| `--accent-hover` / `--accent-active` | `#4795D6` / `#4188C3` |
| `--success` / `--warn` / `--danger` | `#35B37E` / `#D9973E` / `#E5645C` |
| `--warn-bg` / `--warn-bg-ink` | `#B45309` / `#FFF1DC` |
| `--ai-surface` / `--ai-ink` / `--ai-dash` | `#12171E` / `#9AA6B4` / `rgba(255,255,255,0.14)` |

### 2.3 配比铁律与禁用

- **配比**：中性 70–90% / accent 5–10% / 语义 0–5% / 效果色 <1%。
- **每屏 ≤2 处可见 `--accent`**（多了 = 视觉噪音）。
- ❌ 任何 Indigo→Pink / 紫→粉渐变（P0-2）
- ❌ Tailwind 默认 `#6366F1` / `#2563EB` 作品牌强调
- ❌ 奶油/米色/沙色背景（OKLCH L 0.84–0.97, C<0.06, hue 40–100）
- ❌ 用颜色给需求「分类」（业务线/模块/产品线一律中性标签）

---

## 3. Typography Rules

**字体栈（配对数量 = 2，合规）**：
- **Display**：Geist Sans（工程精度 + 天然 tabular-nums + 大字号负字距）
- **Body**：Inter（开 `cv01 ss03 tnum`），中文 Noto Sans SC 回退
- **Mono**：JetBrains Mono（单号/分支/commit/diff/时间戳/Token/模型名）
- 中文回退：`Noto Sans SC` → `PingFang SC` → `Microsoft YaHei`

**字号阶梯（8 级，桌面基准）**：xs 12 / sm 13 / base 14 / md 16 / lg 18 / xl 20 / 2xl 24 / 3xl 32（px）。禁止半像素字号（13.5/12.5/11.5…）。

**字重三级**：400 正文 / 510 表头·按钮·小标题（可变字体轴；中文回退 500）/ 590 页面标题·强调（中文回退 600）。

**字距**：正文 14–16px `0` · 小字 12–13px `0.01em` · **ALL CAPS 标签 `0.06em`（必加）** · 标题 ≥24px `-0.015em` · 展示数字 ≥32px `-0.025em`。

**中文段落**：`text-wrap: pretty`；正文行长 ≤ 38 中文字符；行高：正文 1.6、标题 1.15–1.35。

**数字规则**：所有单号/工时/等级/Token/耗时/日期 = `--font-mono` + `tabular-nums`（工程可信度最低成本来源）。

---

## 4. Component Stylings（含 9 态矩阵）

> 状态覆盖约定：所有交互组件必须给出 **Loading / Empty / Error / Populated / Edge**（5 态）并在可达处补 **Default/Hover/Focus-visible/Active/Disabled/Success**（9 态）。Empty 态必须有引导文案 + 主操作（禁只写"暂无数据"）；Error 态必须有具体原因 + 重试 + 降级路径。

### 4.0 全局材质：shadow-as-border
卡片/输入框优先 `box-shadow: var(--elev-ring)`（`0 0 0 1px` 环）替代实体 `border`，避免 box model 抖动。**禁止**「1px 实线 border + blur≥16px 阴影」同元素（幽灵卡片，绝对禁令#9）。

### 4.1 Button（按钮）
- 尺寸：默认 `padding: 10px 16px`；`--radius-sm`；`font-size: var(--text-base)`，`font-weight: var(--w-emph)`。
- 图标：内嵌 Lucide 20px，`gap: var(--space-2)`。
- 变体：
  - **Primary**：`bg: var(--accent)` / `color: var(--accent-on)`；hover→`--accent-hover`；active→`--accent-active`；每屏主按钮仅 1 个。
  - **Secondary**：透明 + `1px var(--border)`；hover→`--accent-wash` + `color: var(--accent)`。
  - **Ghost**：透明无边框；hover→`--surface-2`。
  - **Danger**：`color: var(--danger)`；hover→`--danger` 8% 底。
  - **Pill**：`--radius-pill`（标签式操作）。
- 状态矩阵：

| 态 | 表现 |
|---|---|
| Default | 按变体基线 |
| Hover | 颜色过渡 `var(--motion-fast)`，Secondary/Ghost 显底色 |
| Focus-visible | `outline: 2px solid var(--accent); outline-offset:2px` |
| Active | `translateY(1px)` |
| Disabled | `opacity:.5; cursor:not-allowed`，无 hover |
| Loading | 左 icon 位换 20px Spinner（`LoaderCircle`），文字保留，禁点击 |
| Empty | 不适用 |
| Error | 不适用 |
| Success | 短时变 `--success` 底 + `Check` 图标（如提交成功） |

### 4.2 Input（输入框 / Textarea / Select）
- `padding: 9px 12px`；`--radius-sm`；`bg: var(--surface)`；`border: 1px var(--border)`。
- hover→`--border-strong`；**focus→`border-color: var(--accent)` + `box-shadow: 0 0 0 3px var(--accent-wash)`**。
- 必填：label 后 `*`（`--danger`）；错误：`border-color: var(--danger)` + 下方 `var(--danger)` 文字 + 重试/澄清。
- 数字类输入用 mono（commit sha、单号）。
- 状态矩阵：Default/Hover/Focus/Active/Disabled 同上语义；Loading=右侧 Spinner；Error=红框+原因；Empty=placeholder 非 label（label 常驻）；Success=绿勾角标（如校验通过）。

### 4.3 Table（需求列表 — 密度 7 主战场）
- **不用卡片**，表格 + `divide-y`；行高可切 `--row-compact` 36px / `--row-comfort` 44px（存 localStorage）。
- 表头：`--text-xs`，`--tracking-caps`（`0.06em`） + `text-transform: uppercase`，`color: var(--meta)`，`bg: var(--surface-2)`，`font-weight: var(--w-emph)`。
- 单元格：`--text-sm`，`--fg-2`；单号/时间 mono tabular-nums。
- 行 hover：`bg: var(--surface-2)`（0ms 或 `--motion-fast`）。
- 等级 L1–L4 用**字重 + 边框**区分，禁彩色块（P0 禁侧条纹）。
- 状态矩阵：Populated=正常行；Loading=骨架行（逐行微光）；Empty=全宽空态块（见 §7 空态）；Error=表格级错误条 + 重试；Edge=超长文本 `text-overflow: ellipsis` + tooltip，超长单号保留完整 mono 可复制。

### 4.4 Card（卡片 / 产物容器 — 密度 7 下克制使用）
- 仅用于**聚合型容器**（汇总卡/模块卡/登录盒），不用于逐行列表项。
- `bg: var(--surface)`；`--radius-md`；`box-shadow: var(--elev-ring)`（非 blur 阴影）。
- hover（可点击卡）：`border-color: var(--border-strong)`（禁 transform 抖动，MOTION 3）。
- 状态矩阵：Default/Hover/Focus(可聚焦时)/Active/Disabled；Loading=骨架；Empty=内嵌空态；Error=内嵌错误条；Success=顶部细绿条。

### 4.5 FlowBar（需求流转条 — PRD 流程图落地，F8 验收关键）
- 水平节点条（移动端折纵向时间线）。节点圆 24px，三种**类型信号（恒定）× 四态（状态轴）**正交（见 DIRECTION §12.1）：

| 类型信号（恒定） | 人工 H | AI 节点 | 判定网关 G |
|---|---|---|---|
| 形状/材质 | 实线圆 1px `--border-strong` | **虚线圆** 1px `--ai-dash` + `--ai-surface` 底 + 圆内 mono `AI` | **菱形**（形状区分） |
| 未到达 | 灰底 + `--meta` | 同左（虚线） | 灰底菱形 |
| 当前 | `--accent` 环 + 3px halo | `--accent` 环 + 3px halo（虚线保留） | `--accent` 描边菱形 |
| 已完成 | 实心 `--success` + `Check` | 实心 `--ai-ink`（石墨）+ `Check`，**不用 success 绿**（避免与"通过"撞色） | 实心 `--accent`（是）或 `--danger`（否/打回） |
| 曾被打回 | `--danger` 虚线圆 + 红点角标 | 同左 | 打回路径 `--danger` 虚线连线 + 起止角标 |

- 连线 2px：done 段染 `--success`，其余 `--border-strong`。打回路径 `--danger` 虚线，悬浮 popover 显 `{打回人}·{时间}·{原因}`。
- 节点下方两行：节点名 13px/510 + 负责人或状态 11px/`--muted`。
- **四态一眼可辨 + AI/人工视觉可区分** 全部满足，且不新增图例色（≤2 accent 预算）。
- 状态矩阵：Populated（含四态混排）/ Loading（节点骨架）/ Empty（需求刚建，仅首节点 current）/ Error（流程配置异常条）/ Edge（>8 节点横滚 + 移动端纵向折叠）。

### 4.6 AI 产物卡（差异化核心 — L4 材质法）
- 头部条（dashed 边框内第一行）固定三栏 = **AI 可信度三件套**（PRD §6.1）：
  - 左【来源】：真实模型灰底 mono chip；**Mock 时**=整宽琥珀警示条 `演示数据（内置 Mock）· 不可作为排期依据` + `TriangleAlert`，叠在 dashed 边框内顶部。
  - 中【代码依据】：`用户中心@main · a1b2c3d4 · 8 文件`，可点展开文件清单；未加载显式 `本次未加载代码上下文`（禁隐藏字段）。
  - 右【置信度】：`影响面 0.82 · 工作量 0.65` 两个 mono 小徽章（数值由模型给，**禁前端硬编码**）。
- 确认态：dashed→solid（虚→实 = "人在环"隐喻）；未确认 = dashed + `--ai-surface` 底 + 左上 mono `AI · 评估` 标签。
- 生成中：dashed + 骨架段逐段浮现（非打字机）。
- 失败/超时：dashed + `--danger` + 具体错误 + 重试 + 降级（换模型/手动填）。
- 元信息：mono 小字 模型名/耗时/Token/成本。
- **禁止**：AI 节点用紫/渐变/发光/毛玻璃/✨🤖 任何 emoji。
- 状态矩阵：Populated（确认/未确认）/ Loading（骨架段）/ Empty（无 AI 产物，显"本节点暂无 AI 产出"）/ Error（失败条+重试+降级）/ Edge（超长产物文内滚动 + 代码块 mono 渲染 + "复制"按钮供研发粘进 Cursor）。

### 4.7 Modal（模态 — 提单/确认）
- `width: 600px; max-width: 92vw; max-height: 88vh; overflow:auto`；`--radius-lg`；`box-shadow: var(--elev-overlay)`。
- mask：`rgba(16,23,36,.5)` + `backdrop-filter: blur(4px)`；`--motion-slow` 淡入。
- 头 `padding:16px 20px` + 底 1px 分隔；体 `20px`；脚 `14px 20px` + `--surface-2` 底 + 右对齐操作（主按钮 ≤1）。
- 关闭：右上 `X` 20px + `Esc` + 点遮罩；聚焦陷阱（a11y）。
- 状态矩阵：Populated/Loading（提交中禁用按钮+Spinner）/ Empty（罕见）/ Error（脚注红字 + 重试）/ Success（关闭+Toast）。

### 4.8 Toast（轻提示）
- `position: fixed; top:22px; left:50%; translateX(-50%)`；`bg: var(--fg); color: var(--bg)`（反色，强可读）；`--radius-sm`；`--motion-base` 下落。
- 类型：success=左点 `--success`；error=左点 `--danger`；info=左点 `--accent`。
- 自动消失 3s（可手动关）；同屏堆叠 ≤3，新替旧。
- 状态矩阵：Populated（显文案+类型点）/ Loading（转圈+文案）/ Empty（不渲染）/ Error（红点+原因）/ Success（绿点+确认）。

### 4.9 Badge（徽章 / 状态点 / 等级）
- **语义徽章**（仅 3 色）：success/warn/danger 用「底色 12% + 该色字」，不纯色块。
- **等级 L1–L4**：字重 510/590 区分 + 1px 边框，禁彩色（P0 禁侧条纹）；P0/阻塞/失败 三种允许 `--danger` 语义色。
- **状态点**：7px 圆；ok=`--success`，current=`--accent`+3px 环，pending=`--border-strong`。
- **Pill**：`--radius-pill`，中性底 `--surface-2` + `--fg-2` 字（模块 chip、单号标签）。
- 状态矩阵：Populated/Empty（不渲染）/ Error（红边）/ Disabled（`--meta` 灰）/ Edge（超长文本截断+tooltip）。

---

## 5. Layout Principles

- **栅格**：桌面 12 列 / 平板 8 列 / 手机 4 列（VARIANCE 3，严格对称，禁 Masonry）。
- **间距**：4px 网格，仅 `4 8 12 16 20 24 32 40 48 64`（禁 5/7/13/15/22/30）。
- **圆角**：仅 `6 / 12 / 16 / pill` 四档（禁七档混用）。
- **Sidebar**：`--sidebar-w` 240px（展开）/ 56px（图标折叠），`lg` 以下抽屉化。
- **内容区**：列表/看板全宽（上限 `--container-max` 1440）；详情三栏（中栏 flex + 右栏 320px 元信息 + 代码影响面）。
- **节区节奏**：桌面 32 / 平板 24 / 手机 20px。
- **密度切换**：表格行高 36/44px（localStorage），密度 7 的合法出口。
- **断点**：`sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`。
- **触摸目标 ≥44×44px**（表格行内按钮 32px 视觉 + 44px 热区）。

---

## 6. Depth & Elevation

- **三层级**：`--elev-flat`(none) / `--elev-ring`(1px 环) / `--elev-raised`(模糊阴影)。
- **优先 shadow-as-border**：卡片/输入框 `box-shadow: var(--elev-ring)` 替代实体边框。
- **深色模式**：靠亮度阶梯（`--surface`→`--surface-2`→`--surface-3`）+ 半透明白边框表达层级，**不靠阴影**；阴影值已在 `[data-mode="dark"]` 覆盖为更深的黑。
- **禁止**：「1px 边框 + blur≥16px 阴影」同元素（幽灵卡片）；装饰性模糊光晕（如 `.stat-card .spark` 那类 blur 圆）。

---

## 7. Do's and Don'ts

### ✅ Do
- accent 每屏 ≤2 处；其余靠中性色 + 字重 + 边框分层。
- 数字全 mono + tabular-nums（单号/工时/Token/耗时/日期）。
- 列表/详情内部 `divide-y`，不把每行包成 card。
- AI 用虚线材质 + graphite 区分，不染绿/不染紫。
- 空状态给"为什么空 → 怎么做 → 后果"三段式 + 主操作。
- Error 给具体原因 + 重试 + 降级路径。
- focus-visible 全局 2px accent 环；图标按钮带 `aria-label`。
- `prefers-reduced-motion` 全量降级。

### ❌ Don't（红线）
- ❌ emoji 作功能图标（P0-1）——全量换 Lucide。
- ❌ 紫→粉渐变、Indigo/Slate 纯色以外的紫系（P0-2）；禁 Tailwind `#2563EB`/`#6366F1` 作强调。
- ❌ 侧条纹边框 `border-left > 1px` 作强调（绝对禁令#1）→ 改整体 `border-color` + 材质。
- ❌ 渐变徽章/渐变 logo（现有 `.ai-badge`/`.brand .logo`/`.node-kind.ai`）→ 纯色 + mono 标签。
- ❌ 装饰性模糊光晕（`.stat-card .spark`、body 径向渐变）→ 删除。
- ❌ 幽灵卡片（1px 边框 + blur≥16px 同元素）。
- ❌ 半像素字号（13.5/12.5/11.5…）→ 收敛 8 级。
- ❌ 圆角七档混用 → 收敛 6/12/16/pill。
- ❌ 用颜色给需求分类；用绿色表达 AI（与 success 撞色）。
- ❌ 空洞占位文案（"Welcome to"/"暂无数据"裸写/"Sign up today"）。

---

## 8. Responsive & Accessibility

- **断点**：`sm 640 / md 768 / lg 1024 / xl 1280`。移动端（<768）非对称布局回退单列。
- **导航**：桌面左侧 Sidebar 240px；`lg` 以下抽屉化；移动端底部 TabBar（≤5 项）。
- **触摸**：目标 ≥44×44px；按钮间距 ≥8px；手势左滑/下拉刷新（二期）。
- **空状态（平台模块未配置，F7 验收）**——三段式：

  ```
  [PackageOpen 图标 24px, --meta]
  暂无可选模块                         ← 标题 14px/590
  管理员尚未配置平台模块。              ← 为什么空 13px/--muted
  可先提交，AI 评估将仅基于需求文本，    ← 可做 + 后果 13px/--muted
  影响面准确度会降低。
  [先提交]  [联系管理员]               ← 主操作 + ghost 次操作
  ```
  显示「0 个模块」徽章；不阻塞提交（F7）。

- **a11y（优先级 1）**：对比度正文 ≥4.5:1（已实测全部达标）；图标按钮 `aria-label`；装饰图标 `aria-hidden`；键盘可达；focus 可见；`prefers-reduced-motion` 降级；`lang` 属性；表单 label 关联。

---

## 9. Agent Prompt Guide（给前端 贾思敏 的实现提示）

### 9.1 主题切换机制
- 根元素挂 `data-mode="dark"` 即深色；默认浅色。与现有 `html[data-mode="dark"]` 选择器**完全一致**，无需改 JS 切换逻辑。
- 推荐：`import tokens from './design-tokens.json'`，运行时按 `data-mode` 选 `theme.light` / `theme.dark` 合并 `base` 注入 CSS 变量；或**直接 @import `design-tokens.css`**（已含 :root + [data-mode="dark"]，零额外工作）。

### 9.2 遗留 styles.css → 新 Token 迁移映射（Phase 3 整改清单）
现有代码用旧名，需全量 find-replace：

| 旧名（styles.css） | 新名（design-tokens.css） | 备注 |
|---|---|---|
| `--primary` `#2563eb` | `--accent` `#0E62A8` | **值也改**（去 Tailwind 默认蓝） |
| `--primary-weak` | `--accent-wash` | |
| `--primary-strong` | `--accent-hover` | |
| `--primary-weaker` | 用 `--accent-wash`（或 `--surface-2`） | |
| `--accent` `#16a34a` | `--success` | 旧"强调绿"实为语义绿，归 success |
| `--accent-weak` | `--success` 12% 底（临时用 `color-mix`） | 见下方 |
| `--panel` | `--surface` | |
| `--panel-2` | `--surface-2` | |
| `--bg-tint` | `--surface-2` / `--border-soft` | 按场景 |
| `--text` | `--fg` | |
| `--text-2` | `--fg-2` | |
| `--text-3` | `--meta` | 注意：`--meta` 禁 12px 正文，旧代码 11–12px 弱化文本需升到 `--muted` |
| `--good` | `--success` | |
| `--warn` `#d97706` | `--warn` `#B45309` | 值改 |
| `--bad` | `--danger` | |
| `--info` `#0891b2` | 删除（青色不在新板） | 旧 `.tag-cyan`/`.node-kind.ai` 渐变删除 |
| `--brand` `#1e3a5f` | `--brand` `#1E3A5F` | 值已一致，保留 |
| `--radius`(12) / `--radius-sm`(8) / `--radius-lg`(16) | `--radius-md`(12) / `--radius-sm`(6) / `--radius-lg`(16) | 小圆角 8→6 |
| `--shadow` / `--shadow-sm` / `--shadow-lg` | `--elev-raised` / `--elev-ring` / `--elev-overlay` | |
| `--dur`(200ms) / `--ease` | `--motion-base` / `--ease-standard` | |

**具体整改项（对应 DIRECTION.md §10 的 8 项红线）**：
1. emoji→Lucide（P0-1，30+ 处，前端已启动）
2. 字体 `Plus Jakarta Sans`→`Geist`(display)+`Inter`(body)+`Noto Sans SC`+`JetBrains Mono`
3. `.sop-node-item.ai/.human` / `.req-card.accent` 的 `border-left:3px` → 整体 `border-color` + 材质（虚/实线）
4. 渐变徽章 `.ai-badge`/`.node-kind.ai`/`.avatar`/`.brand .logo` → 纯色 + mono 标签
5. `.stat-card .spark` blur 圆 + body 径向渐变 → 删除
6. `.card` 幽灵卡片（1px+blur16）→ 优先 shadow-as-border
7. 半像素字号 → 8 级阶梯
8. 圆角七档 → 6/12/16/pill

> 单文件 ≤300 行（AC-15）；建议把 styles.css 按原子拆分或收敛到阈值内。

### 9.3 Lucide 图标语义映射全表（lucide-react ^0.454.0，16/20/24px，strokeWidth 1.75，继承 currentColor）

| 语义 | 图标 | 尺寸 | 场景 |
|---|---|---|---|
| 需求单 | `FileText` | 20 | 导航/列表/详情 |
| 看板视图 | `LayoutGrid` | 20 | 视图切换 |
| 列表视图 | `Table2` | 20 | 视图切换 |
| 流程/编排 | `Workflow` | 20 | SOP 编排页 |
| **AI 节点** | `Cpu` | 16/20 | **禁用 Sparkles/✨（AI 套路星星）** |
| 代码分支 | `GitBranch` | 16 | 代码影响面 |
| 提交 | `GitCommitHorizontal` | 16 | 关联提交 |
| 合并 | `GitMerge` | 16 | MR 合并 |
| 测试 | `FlaskConical` | 20 | 测试用例 |
| **上线** | `CircleCheckBig` | 20 | **禁用 Rocket/🚀** |
| 客户/CSM | `Building2` | 20 | 提单 |
| 搜索 | `Search` | 20 | 全局搜索 |
| 设置 | `Settings2` | 20 | 管理后台 |
| 打回 | `Undo2` | 16/20 | 流转/打回 |
| 确认/通过 | `Check` | 16 | 节点完成 |
| 当前节点 | `CircleDot` | 16 | 流转条当前态 |
| 未到达 | `Circle` | 16 | 流转条待办态 |
| 演示数据警示 | `TriangleAlert` | 16 | Mock 警示条 |
| 空态-模块 | `PackageOpen` | 24 | 平台模块未配置 |
| 空态-通用 | `Inbox` | 24 | 列表空态 |
| 复制 | `Copy` | 16 | Dev Prompt 复制 |
| 代码块 | `Code2` | 16 | 代码感知 |
| 刷新/重试 | `RefreshCw` | 16 | 错误重试 |
| 加载 | `LoaderCircle` | 16/20 | 按钮/行 Loading（旋转） |
| 关闭 | `X` | 20 | 弹窗/Toast |
| 编辑 | `Pencil` | 16 | 行内编辑 |
| 更多 | `MoreHorizontal` | 16 | 行操作菜单 |
| 用户 | `User` | 20 | 负责人头像回退 |
| 信息 | `Info` | 16 | tooltip/帮助 |
| 危险/删除 | `Trash2` | 16 | 删除（danger 色） |
| 链接 | `Link2` | 16 | 关联跳转 |
| 时钟/耗时 | `Clock` | 16 | 流转时长 |
| 告警 | `AlertCircle` | 16 | 错误/异常 |

### 9.4 页面级规范（MVP 页面）

| 页面 | 路由 | 布局 | 关键组件 | 响应式差异 |
|---|---|---|---|---|
| 看板 Board | `/` | `board-grid`：左 300px 编排/右主区；或三栏 | FlowBar + 需求卡 + 汇总卡 | <1100px 单列 |
| 需求列表 ReqList | `/list` | 全宽表格 + `divide-y` + 右下汇总卡 | Table(5态) + 密度切换 + 行内流转 | 列横向滚动 |
| 需求详情 ReqDetail | `/req/:id` | 三栏（左 SOP 导航 / 中 产物流 / 右 320 元信息+代码影响面） | AI 产物卡(6态) + FlowBar + 代码影响面(mono) | <1024 右栏下移；<768 纵向 |
| 提单 Modal | CreateModal | 居中模态 600px | Input(5态) + chip 模块多选 + 空态(模块未配) | <768 全宽 |
| 管理后台 Admin | `/admin` | 左分组导航 + 右内容 | 模块管理卡 + 分段 Tab | <768 抽屉 |

### 9.5 验收红线（来自 SPEC-v1.0 AC）
- **AC-14 (F8)**：完成/当前/未到达/曾被打回四态一眼可辨；AI 与人工视觉可区分（FlowBar §4.5 已满足）。
- **AC-15 (P0)**：零 emoji 图标、零紫粉渐变、单文件 ≤300 行。
- **每屏 ≤2 处 accent**；数字全 mono tabular-nums；focus-visible 全量；`prefers-reduced-motion` 降级。

---
*本文件为设计契约源，锁定值不可在 Phase 3 整改中改色/改字；整改仅做"旧名→新 Token / emoji→Lucide / 去渐变去光晕 / 字号圆角收敛"，不改设计意图。*
