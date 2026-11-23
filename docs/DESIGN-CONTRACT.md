# UI 设计契约 —— 三个并行任务共同遵守

这份文件是**唯一事实来源**。三个 agent 各自只写自己那两个文件，不碰别人的，不改 `ui.html` / `ui.js` / `server.mjs`。最后由 Lead 合并。

---

## 0. 产品是什么

一个「提示词方法矩阵」管理器：行 = 大模型，列 = 任务域，格子 = 一套方法（改写规则 + 内核 + 后处理链）以及它的实测证据（成功率、字数、保留率、样本数）。

使用者是同一个工程师，他每天要：
1. 扫一眼矩阵，知道哪个模型在哪个域靠谱 —— **状态色要 0.3 秒内读懂**
2. 点一个格子，改它的方法配置，保存
3. 看网关实时状态（有没有在跑、什么档位）

**这不是营销页。是每天开十几次的工具面板。** 参考的观感基准：Linear 的列表、Vercel Dashboard 的克制、Raycast 的信息密度。不要霓虹、不要玻璃拟态堆叠、不要渐变文字。

---

## 1. 文件所有权（硬边界）

| Agent | 只能写 | 绝对不能碰 |
|---|---|---|
| **A · 设计系统** | `bench/mgr/ui.css`（全权重写） | 其它任何文件 |
| **B · 矩阵视图** | `bench/mgr/uimatrix.js`、`bench/mgr/matrix.css`（新建） | `ui.css`、`ui.html`、`ui.js` |
| **C · 动效与微交互** | `bench/mgr/uimotion.js`、`bench/mgr/motion.css`（新建） | `ui.css`、`ui.html`、`ui.js` |

Lead 负责把它们接进 `ui.html` / `ui.js`。**你们不要改入口文件**，否则三方冲突。

---

## 2. 设计 token（A 定义，B/C 只用不定义）

A 在 `ui.css` 的 `:root` 里定义这些变量，命名固定。B/C 引用时**必须**用 `var(--x)`，不许写死色值。

```
色板
  --bg            页面底
  --bg-elev       抬升面（卡片底）
  --panel         面板/抽屉底
  --panel-2       面板内次级块
  --line          分隔线（1px，低对比）
  --line-strong   强调分隔/描边
  --fg            主文字
  --fg-dim        次文字
  --fg-mute       三级文字/占位
  --accent        主色（蓝系）
  --accent-soft   主色 12% 叠加
  --ok / --ok-soft
  --warn / --warn-soft
  --bad / --bad-soft
  --purple / --purple-soft    改写规则标识色

形状与层次
  --r-sm 6px   --r-md 10px   --r-lg 14px   --r-pill 999px
  --sh-1  微弱（列表 hover）
  --sh-2  中等（浮起卡片）
  --sh-3  强（抽屉/弹层）
  --ring  focus 环（2px，带 offset）

节奏
  --dur-1 120ms   --dur-2 200ms   --dur-3 320ms
  --ease-out      cubic-bezier(.16,1,.3,1)
  --ease-inout    cubic-bezier(.4,0,.2,1)
  --ease-spring   cubic-bezier(.34,1.56,.64,1)

排版
  --font-sans   系统中文栈
  --font-mono   ui-monospace, Consolas
  正文 13px / 1.55；表格内 12px；标题 15-16px；数字一律 tabular-nums
```

**暗色为主，但要能看住层次**：`--bg` → `--bg-elev` → `--panel` 三档必须有可见但克制的递进（不要用纯黑 + 纯灰，带一点蓝的冷灰）。

---

## 3. DOM 契约（B 生成，C 在其上做动效）

矩阵由 B 渲染进 `#matrixWrap`。**结构固定**，C 依赖这些类名：

```html
<table class="mx" role="grid">
  <thead>
    <tr>
      <th class="mx-corner"></th>
      <th class="mx-h" scope="col">🔧 字节补丁</th>
    </tr>
  </thead>
  <tbody>
    <tr class="mx-r">
      <th class="mx-model" scope="row">
        <span class="mx-model-id">glm-5.3-flash</span>
        <span class="mx-model-meta">max · 131k</span>
      </th>
      <td class="mx-c">
        <button class="cell" data-m="glm-5.3-flash" data-d="patch" data-state="warn">
          <span class="cell-rw">patch-bytes</span>
          <span class="cell-ok">2/3</span>
          <span class="cell-metrics">923 字 · 留 67%</span>
          <span class="cell-note">字节序列最容易掉</span>
          <span class="cell-base">基线 17/20</span>
        </button>
      </td>
    </tr>
  </tbody>
</table>
```

规则：
- `data-state` ∈ `ok` | `warn` | `bad` | `empty` | `stale`，**颜色语义由 A 的 token 决定，B 只负责打属性**
- 空格子用 `data-state="empty"`，内容是一个 `＋`，视觉上明显退后但仍可点
- 格子是 `<button>`，天然可聚焦、可 Tab
- 所有类名以 `cell-` / `mx-` 开头，禁止泛化命名

---

## 4. 动效契约（C 负责实现，B/A 只需给钩子）

| 场景 | 规格 |
|---|---|
| 矩阵首次渲染 | 行内 stagger，每格延迟 18–25ms，总时长 ≤ 400ms，`--ease-out` |
| 格子 hover | 上浮 1px + `--sh-2`，`--dur-1` |
| 格子选中 | 左侧 3px 强调条（`--accent`）+ 底色微亮 |
| 状态色变化（数据刷新） | 颜色 `--dur-3` 过渡，不闪 |
| 数字变化 | 300ms 内从旧值滚到新值（`countUp`），`tabular-nums` 防抖 |
| 面板打开 | 右侧滑入 `translateX(100%)→0`，`--dur-3` + `--ease-out`，背后加 12px blur 遮罩 |
| toast | 底部居中升起 + 单次轻微回弹，2.2s 后淡出 |
| 保存中 | 按钮进入 pending：文字不变，右侧出现 14px 环形进度 |
| 加载骨架 | shimmer 扫光，1.2s 循环，`--panel-2` → `--line` |
| 数据 stale（配置未生效） | 顶部 2px 进度条持续呼吸，`--warn` |

**两条硬约束**：
1. 所有动效必须响应 `@media (prefers-reduced-motion: reduce)` → 全部退化为无位移的即时变化
2. 动效只允许动 `transform` / `opacity` / `filter` / 颜色，**不许动 width/height/margin**（会掉帧）

---

## 5. 交互契约（B 负责，你要做到"不用看说明就会用"）

- **键盘**：矩阵内方向键移动焦点，`Enter` 打开格子，`Esc` 关闭面板，`⌘/Ctrl+S` 保存
- **筛选**：域 chip、模型 chip 可多选，选中态明显；有筛选时顶部显示「已筛 N 项 · 清除」
- **空态**：没数据时给一句话 + 一个主行动按钮，不要空白
- **加载态**：骨架屏，不是 spinner
- **错误态**：就地显示错误 + 重试按钮，不要 alert
- **长内容**：模型名、备注超长时省略号 + `title` 悬浮全文
- **防止误操作**：删除格子要二次确认（就地 inline 确认，不用 window.confirm）

---

## 6. 怎么自测（你没有眼睛，但可以验证确定性）

```powershell
# 语法
node --check bench\mgr\uimatrix.js
node --check bench\mgr\uimotion.js

# 真渲染（Edge headless，能拿到渲染后的 DOM）
$edge="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$tmp="$env:TEMP\v-$(Get-Random)"; $out="$env:TEMP\v-$(Get-Random).html"
Start-Process -FilePath $edge -ArgumentList @("--headless=new","--disable-gpu","--no-first-run","--user-data-dir=$tmp","--virtual-time-budget=8000","--dump-dom","http://127.0.0.1:8899/") -RedirectStandardOutput $out -NoNewWindow -Wait
Select-String -Path $out -Pattern 'class="cell"' | Measure-Object   # 期望 42
```

服务在跑：mgr `http://127.0.0.1:8899`，网关 `8801`。**不要重启、不要杀进程、不要改 registry.json。**

验证不了的（视觉美感）就靠你自己的设计判断 —— 但要能说出每个决定的理由。

---

## 7. 交付格式

每个 agent 在完成时用 `send_message` 回报：
1. 改了/新增了哪些文件（含字节数）
2. 设计上的三个关键决定 + 理由
3. 自测命令的实际输出（`node --check` 和 DOM 检查）
4. 给 Lead 的接入说明：需要在 `ui.html` / `ui.js` 里加什么（贴出确切代码）
