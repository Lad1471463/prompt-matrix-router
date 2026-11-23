# 嵌入契约 —— 给 workbuddy 网关页 / 反代项目

目标：把「模型 × 域 → 方法」的矩阵管理能力挂到 workbuddy 的网关页里，**且不随任一侧上游更新而失效**。

不变式（先记住这三条）：

1. **契约冻结在 HTTP 层**。workbuddy 只依赖下面列出的端点与字段；`mgr/` 内部的 registry 结构、UI 实现、甚至进程语言都可以换，只要端点还在。
2. **mgr 是旁路，不是链路节点**。请求路径永远是 `客户端 → gwx(8801) → 上游网关(8788)`；mgr(8899) 挂了不影响破限，只影响「改配置的界面」。
3. **写操作必须带 `__baseHash`**。registry 是可被 UI / 脚本 / 手工同时修改的单文件，冲突用 hash 乐观锁挡。

---

## 0. 进程与端口

| 进程 | 端口 | 作用 | 挂了会怎样 |
|---|---|---|---|
| `bench/gwx.mjs` | 8801 | 请求侧改写 + 内核注入 + 降级链 + 域路由 | 客户端拿到连接失败 |
| `bench/mgr/server.mjs` | 8899 | 矩阵管理 API + UI + 读网关 stats | **无影响**，只是改不了配置 |

启动：

```powershell
# 网关（必须）
cd 
node gwx.mjs --listen 8801 --upstream http://127.0.0.1:8788 --mode merge `
  --rewrite on --detail on --first raw --guard on --guardMin 0.6 --retry 1 --maxCont 3 `
  --budgetMs 150000 --domains adult,crack,patch,meta

# 管理器（可选，workbuddy 要嵌就必须起）
cd \mgr
node server.mjs --port 8899 --gw http://127.0.0.1:8801
```

两个进程都只监听 `127.0.0.1`。要跨机访问自己改 `--listen` 和 `server.listen` 的绑定位。

---

## 1. 三种嵌入方式，按侵入度排序

### 方式 A：iframe（一行，零耦合）

```html
<iframe src="http://127.0.0.1:8899/?embed=1"
        style="width:100%;height:620px;border:0;border-radius:8px"></iframe>
```

`?embed=1` 会隐藏管理器自己的 header 和 tab 栏，只留矩阵，配色跟随深色主题。

- 优点：workbuddy 一行代码，mgr 随便升级都不影响
- 缺点：样式细节不完全可控；跨源时 iframe 内部交互正常，但外层拿不到内部状态
- 同源部署（把 mgr 反代到 `workbuddy/same-origin/`）时可用 `postMessage` 扩展，见 §4

### 方式 B：自己渲染，只读接口（推荐）

workbuddy 只要画一张表，数据全从 `/api/summary` 来：

```js
const s = await (await fetch('http://127.0.0.1:8899/api/summary')).json();
// s.domains: [{id,name,icon,priority}]
// s.models : [{id,effort,maxTokens}]
// s.cells  : [{model,domain,rewrite,profile,post,first,ok,chars,density,n,baseline,note}]
// s.gateway: {online,requests,events}
```

渲染成「行=model、列=domain」的表格即可，格子显示 `rewrite` + `ok`。要改配置就走 `/api/registry` PUT（§3）。

- 优点：样式完全归 workbuddy，mgr 只当数据源
- 缺点：要自己写表格和编辑表单

### 方式 C：把静态资源拷进 workbuddy

`ui.html` / `ui.js` / `ui.css` 是零依赖原生 JS，拷进 workbuddy 的静态目录即可，只需要保证 `/api/*` 能打到 mgr。

- 适合：workbuddy 想把界面做成自己的样子，又不想重写
- 风险：**资源会分化**。这条违背不变式 1，除非你接受两边各自维护

---

## 2. 读接口

### `GET /api/summary` — 嵌入主接口（稳定）

紧凑、扁平、不含内部字段。字段一旦发布不再删改。

```json
{
  "generatedAt": "2026-11-19T04:40:00.000Z",
  "registry": {
    "seq": 4, "hash": "9f2c…", "version": 1, "missing": false,
    "loadedSeq": 4, "lagMs": 120, "stale": false
  },
  "domains": [{ "id": "patch", "name": "字节补丁 / 改指令", "icon": "🔧", "priority": 110 }],
  "models":  [{ "id": "glm-5.3-flash", "effort": "max", "maxTokens": 131072 }],
  "cells": [{
    "model": "glm-5.3-flash", "domain": "patch",
    "rewrite": "patch-bytes", "profile": "slim-3k",
    "post": ["guard"], "first": "raw",
    "ok": "2/3", "chars": 923, "density": null, "retention": 0.67, "n": 2,
    "basis": "curated", "baseline": "2/3", "note": "字节序列最容易掉，靠 guard 兜"
  }],
  "gateway": { "online": true, "requests": 23, "events": {}, "registry": { "seq": 4, "hash": "5e5b…" } }
}
```

### 数据面的版本自证（重要）

`registry.seq` 是**磁盘上**的版本，`registry.loadedSeq` 是**网关进程里正在用**的版本。

| 字段 | 含义 | 页面该怎么用 |
|---|---|---|
| `loadedSeq` | 网关当前加载的第几版 | 显示在状态栏 |
| `lagMs` | 距该版加载过去了多久（不是延迟） | 可显示「刚刚生效」 |
| `stale` | `loadedSeq !== seq`，即还有写入没生效 | **为 true 时提示「配置尚未生效」** |

正常情况下写入后网关会收到 `POST /gwx/reload` 主动推送，`stale` 立刻转 false（实测 PUT 往返 16 ms）。轮询兜底周期 5 秒。

### `ok` / `basis` / `baseline` —— 三个不同的东西

| 字段 | 含义 |
|---|---|
| `ok` | 该格当前这套方法配置的证据 |
| `basis` | `curated` = 从当前配置的选定实验精选而来；`historical` = 全量扫描自动聚合（含已淘汰方法） |
| `baseline` | 全量扫描的另一份快照，仅作对照 |

**渲染时不要只显示 `ok` 而不看 `basis`。** `basis: "historical"` 意味着这个数字里混着已淘汰方法（pojia、抗退让片段等）的历史实验行，不代表当前配置的能力。`baseline` 同理。

### `GET /api/stats` — 网关实时状态

```json
{ "online": true, "gw": "http://127.0.0.1:8801",
  "stats": { "requests": 23, "events": { "raw-first": 4, "continue": 2 }, "agg": {…} } }
```

`online:false` 时 `stats` 不存在——按「网关离线」渲染，别抛异常。

### `GET /api/registry` — 完整配置（编辑时用）

返回 registry 全文，**额外带三个只读字段**：

| 字段 | 用途 |
|---|---|
| `__hash` | 当前文件内容的 sha256，写回时作为 `__baseHash` |
| `__mtime` | 文件 mtime（毫秒） |
| `__seq` | 同 `sequenceId` |

### 其他

| 端点 | 说明 |
|---|---|
| `GET /api/results` | 列出 `bench/` 下的实验文件（name/size/mtime） |
| `GET /api/result?name=` | 读单个实验结果（json 转行数组，md 转文本） |
| `GET /api/kernels` | 列出 `bench/kernels/` 和 `bench/fragments/` |
| `GET /api/kernel?file=` | 读单个内核正文（上限 60KB） |

---

## 3. 写接口

### `PUT /api/registry`

请求体 = `/api/registry` 拿到的完整 JSON，**必须带**：

```json
{ ...registry, "__baseHash": "<上次 GET 的 __hash>" }
```

响应：

| 码 | 情况 | 客户端该做什么 |
|---|---|---|
| 200 | `{ ok:true, seq, hash, bytes, backup, reloaded }` | `reloaded.ok` 为 true 表示数据面已立即重载 |
| **428** | 没带 `__baseHash` | 先 GET 拿 `__hash`，再写。**服务端不会接受盲写** |
| 409 | 别人先改过：`{ error, baseHash, nowHash }` | 重新 GET、合并、再写 |
| **503** | 写入锁被占用（另一实例正在写） | 隔一两秒重试；锁超 5 秒会被自动清理 |
| 400 | JSON 解析失败 / `matrix` 不是数组 | 修 payload |
| 500 | 写盘失败（句柄占用，已内部退避 6 次） | 检查有没有别的程序在读 registry.json |

`reloaded` 字段（200 时）：

```json
{ "ok": true, "changed": true, "seq": 3, "hash": "5e5b4a74fb9f", "matrix": 17, "loadedAt": 1795063477967, "err": null }
```

写盘是 **tmp → fsync → rename**，跨进程用 `open('wx')` 独占锁（`'w'` 实测不互斥），`sequenceId` 由单调水位 `.mgr-seq` 发号——手工还原旧文件导致 seq 倒退时，陈旧客户端一定会被 409 挡住。

实测：PUT 往返 **16 ms**，返回时数据面已是新版本；并发 8 写 = **1×200 + 7×409**。

### `POST /api/evidence/rebuild[?apply=1]`

扫描全部 `results-*.json` 聚合成证据。

- 不带 `apply`：只返回聚合结果，不写盘（预览）
- `apply=1`：写回 registry。规则是**空 evidence 才填，非空的写进 `evidenceAuto`**——防止历史全量数字覆盖精选结论

---

## 4. 跨源 / postMessage（可选）

mgr 目前不主动发消息。若 workbuddy 用 iframe 且需要双向：

- **外层 → iframe**：直接 `iframe.contentWindow.postMessage({type:'gwx:reload'}, '*')`
- **iframe → 外层**：需要给 `ui.js` 增加 `parent.postMessage` 钩子

这块我还没实现，等你确定接口形状再补——你说「反代项目写一个不影响上游更迭的」交给我，我按那个接口调整。

---

## 5. 反向依赖：workbuddy 会改什么

为了两边不打架，建议分工：

| 事项 | 归属 |
|---|---|
| registry.json 的 schema 与语义 | **本仓库**（mgr 是唯一写入方） |
| 网关启动参数、域白名单 | **本仓库**（`--domains` 等） |
| 页面位置、入口按钮、路由 | **workbuddy** |
| 视觉样式、表格列顺序 | **workbuddy** |
| 权限/鉴权 | **workbuddy**（mgr 只监听 127.0.0.1，默认无鉴权） |

---

## 6. 失败模式

| 症状 | 原因 | 处理 |
|---|---|---|
| 页面白屏，响应里看到 `{"type":"Buffer","data":[…]}` | 旧版 `send()` 把 Buffer 丢进 JSON.stringify | 已修（2026-11-19），确认 mgr 是最新代码 |
| `/api/summary` 返回 `gateway.online:false` | 8801 没起，或上游 hang 超过 800ms | 按离线渲染，不要报错；`gateway.reason` 会说明是 `timeout` 还是 `unreachable` |
| `/api/summary` 返回 `cells: []` 且 `registry.missing: true` | registry.json 丢了或被删 | 页面显示空矩阵 + 提示，**不会 500** |
| 保存返回 **428** | 没带 `__baseHash` | 先 GET `/api/registry` 拿 `__hash` |
| 保存返回 409 | 两处同时编辑，或手工还原过文件（seq 倒退） | 重新 GET 拿新 `__hash` 再合并 |
| 保存返回 **503** | 另一实例正在写，锁被占 | 一两秒后重试；锁超 5 秒自动清理 |
| 跨源 `PUT` 被拒 / OPTIONS 403 | **CORS 默认关闭**（发了 `ACAO:*` 等于把写接口开放给任意网页） | 走同源反代；确实要跨源才启动加 `--cors 1` |
| 改完配置网关没反应 | `reloaded.ok:false` 或 `stale:true` | 看网关 stdout 有没有 `registry reloaded`；手动 `POST /gwx/reload` |
| 页面显示「配置尚未生效」 | `registry.stale === true` | 正常只持续毫秒级；超过 5 秒说明网关轮询或 reload 端点不通 |
| 矩阵数字和 `results-*.json` 对不上 | 你看到的是 `ok`，且 `basis` 可能是 `historical`（混着淘汰方法） | 见 §2 的三字段对照表 |
