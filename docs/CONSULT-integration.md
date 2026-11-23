# CONSULT-integration.md — 第二轮咨询：配置面/数据面分离 + 跨项目嵌入契约

> 主题包装：**配置面（control plane）与数据面（data plane）分离的可维护性研究 / 跨项目嵌入契约的可演进性研究**
> 对象：`bench/mgr/server.mjs`(8899, 可挂) + `bench/gwx.mjs`(8801, 链路节点) + `bench/mgr/INTEGRATION.md`
> 方法：4 次独立 Opus 调用（每题一次，串行）+ 8 个本机校验脚本；Opus 的每条可执行断言都落到本机进程上复算，不照抄。

---

## 0. 通道与执行记录

| 题 | 输入长度 | 输出 | stop | 耗时 | 档位 |
|---|---|---|---|---|---|
| q1-cpdp | 1854 B | 1695 tok / 4544 字符 | end_turn | 20.6 s | max=1700 think=768 timeout=38s（第 1 档） |
| q2-contract | 1681 B | 1801 tok / 4538 字符 | end_turn | 22.4 s | 同上 |
| q3-evidence | 2086 B | 2056 tok / 5550 字符 | end_turn | 22.2 s | 同上 |
| q4-pitfalls | 1990 B | 2000 tok / 5612 字符 | end_turn | 19.3 s | 同上 |

4/4 全 HTTP 200，全部第 1 档命中，无降档、无超时。通道脚本：`bench/mgr/consult2-ask.mjs`（复制自 `ask-opus.mjs`，原文件未改），逐题产出 `consult2-q1-cpdp.md` … `consult2-q4-pitfalls.md`。

本机校验脚本（全部新增，未改动 bench 任何既有 `.mjs` / `.json`）：

| 脚本 | 内容 |
|---|---|
| `consult2-server-copy.mjs` | `server.mjs` 的副本，唯一改动是 `REG` 可由 `MGR_REG` 覆盖 → 所有写测试只落在 `.tmp-consult2/` |
| `consult2-mkcopy.mjs` | 生成上面那份副本 |
| `consult2-probe.mjs` | T1–T12：锁绕过 / 同进程并发 / 外部句柄 / summary 延迟 / 静态头 / 路径边界 / 缺失文件 / 跨源 / 跨进程并发 / ABA / rebuild 竞争 / 成本量级 |
| `consult2-probe2.mjs` | P1–P6：`fs.open` 锁语义 / 格式化与 hash / Opus 的热加载骨架 / evidence 与全量聚合对比 / arm 语义考古 / 版本协商现状 |
| `consult2-gwxprobe.mjs` | G1–G5：真实 gwx 的「写盘→生效」延迟、同长度改写、坏 JSON、`/gwx/stats` 字段、PUT→生效端到端 |
| `consult2-mtime.mjs` / `consult2-blind.mjs` | mtime 分辨率与「盲区写入」复现 |
| `consult2-contract-check.mjs` + `consult2-summary.contract.json` | `/api/summary` 契约冻结检查（35 字段基线，自检 4 项） |

---

## 1. Q1 —— 控制面与数据面只靠「共享 JSON + hash 轮询」的失效模式

### 问题原文（发给 Opus 的核心段）

> 两个 Node 单进程、零依赖服务：数据面 `gwx.mjs:8801`（链路节点），配置面 `server.mjs:8899`（可随时挂）。两者唯一同步机制是共享 `registry.json` + 5 秒轮询比对 contentHash；没有 MQ、没有服务发现、没有数据库。写侧 `PUT /api/registry`（全文覆盖）先比 `__baseHash` 再 `writeAtomicSync`（tmp → fsync → rename，EPERM 退避重试 6 次）。
> 要答：① 已知失效模式（触发条件/现象/后果）② Envoy xDS / nginx reload / Consul watch 各用什么机制同时解决原子性/通知/可观测 ③ 不引入 MQ 的最小加固清单 ④ `loadRegistryIfChanged()` ≤20 行最终形态 ⑤ 到什么规模必须换掉。

### Opus 要点（`consult2-q1-cpdp.md`）

1. 失效模式排序：TOCTOU 竞态 → 「格式化差异导致 hash 同」→ 全文覆盖写放大 → 大文件读取期间被覆盖 → **无版本感知**（`/gwx/stats` 无 version_info）→ 重启后 hash 可能不同 → **跨进程无 ACK**（PUT 返回 200 时 gwx 还没加载）。
2. 业界对照表：xDS = `version_info` + ACK/NACK + `nonce`；nginx = fork 新 worker + 信号 + graceful 双进程；Consul = 单调 `index` + long-poll + `X-Consul-Index`；etcd = `revision` + watch stream；K8s = `resourceVersion` + projected volume/轮询。共同点：**单调版本 + ACK + 推送**。
3. 最小加固：`registry.ack.jsonl` 追加日志 + `POST /gwx/registry/ack` + gwx 的 `/gwx/stats` 加 `version:{seq,hash,loadedAt}` 与 `lag` + 链路响应加 `X-Registry-Version`。
4. 给出 `loadRegistryIfChanged()` 两版代码（都用 `stat.mtime.getTime() <= lastLoadTime` 早退 + 文件内 `contentHash` 字段比对）。
5. 量化门限：>10 个配置文件、>1 写/秒、≥2 台机器、p99 <500ms、>3 写者 → 换 etcd/Consul/xDS。

### 我的校验与结论

**Opus ③④ 的方向对，但它给的代码按我们的真实文件跑会漏更新，且它两条失效模式描述是反的。**（实测见 §6：P2、P3、G1–G5）

采纳并加固后的落点（不是它原样代码）：

| 失效模式 | 实测证据 | 加固 |
|---|---|---|
| **PUT 200 之后数据面最长 5 s 仍用旧配置** | G1：写盘→生效 **3468 / 4983 / 4978 ms**；G5：PUT→生效 **4240 / 4972 / 4996 ms**；`/gwx/stats` 无任何版本字段（G4：只有 `requests,events,agg`） | ① mgr 写成功后主动 `POST /gwx/reload`，把窗口压到 <50 ms；② gwx 每次 reload 回 `POST /api/registry/ack`；③ `/api/summary` 返回 `registry.loadedSeq / lagMs / stale` |
| **乐观锁只覆盖单进程** | T9：两个 mgr 实例共享文件，**6/6 轮两个 PUT 都 200**，丢更新；T2：同进程 10 并发 → `200×1 + 409×9`（临界区是同步的，所以单进程内是对的） | `registry.json.lock`（`open 'wx'`，实测 `'w'` 不互斥、`'wx'` 抛 EEXIST）+ 启动时检测第二个实例 |
| **`__baseHash` 可省略 → 无条件覆盖** | T1：A 带 hash 写成功（seq 2）后，B 用**旧版本内容且不带 hash** 提交 → **200**，A 的修改消失 | 服务端强制 `__baseHash`，缺失 → 409（除非 `?force=1` 且写 audit 行） |
| **外部句柄占用 → 写入直接 500** | T3：外部进程持只读 fd 期间 PUT = **500 EPERM**，耗时 586 ms（6 次退避全部失败）；关掉 fd 后立即 200 | 退避从 6×25–150 ms 提到 ~2 s；或改写为「先写 `.new`，延迟 rename」（读者永远读旧文件） |
| **人为还原旧文件 → seq 回退，陈旧客户端仍能写** | T10：seq 6 →（手工还原）5 → 陈旧 `__baseHash` PUT = **200**，中间那次写入无任何一方收到 409 | 单调 `seqFloor`：`seq = max(文件里的 seq, .bak 的 seq, .mgr-seq 记的水位) + 1`，`.mgr-seq` 只增不减 |
| **共享文件有两套解析器** | `gwx.mjs:43 normalizeRegistry()` 与 `server.mjs` 各自解释同一个文件；新增字段只有一边认识 → 「界面显示 A、网关执行 B」 | 抽出 `registry-lib.mjs`，两边 import 同一个 `normalizeRegistry` |

**另外两条只能靠约定解决**：控制面 8899 挂了以后，界面无法感知自己「正在改一个不会被消费的文件」——所以 `/api/summary` 里必须有 `registry.stale`，让对方页面能显示「网关实际在跑第 3 版，文件已是第 7 版」。

**必须换掉的判据（我的版本，比 Opus 的 1 write/s 更贴我们的实际）**：

| 条件 | 判据 | 我们当前 |
|---|---|---|
| 写者进程数 | >1 | 1（人工点保存；压测 20 连发是测试，不是常态） |
| 需要可见性 p99 | <1 s | 未要求 → push+ACK 后实测 <50 ms 足够 |
| 跨机 | 任一侧不在本机 | 0（都监听 127.0.0.1） |
| 配置规模 | 单文件 >5 MB 或 cells >2 万 | 16.8 KB / 17 cells（实测 `sha256` 中位 **0.0078 ms**，6.18 MB 时 **5.087 ms**） |
| 写入频率 | >10 次/秒持续 | 人工级别 |

结论：**这四件（强制 hash、跨进程锁、seqFloor、ACK+push）不做，才需要换 etcd；做了就够用到 2 万格。**

---

## 2. Q2 —— 嵌入契约的可演进性：三种方式与版本协商

### 问题原文（核心段）

> 把管理界面嵌进一个**会持续改自己页面**、且要求**不被我们上游更新冲掉**的外部项目。三种方式：A) `iframe src=":8899/?embed=1"`；B) 只读 `/api/summary` 由对方渲染；C) 把 `ui.html/ui.js/ui.css` 拷进对方仓库。
> 要答：① 三方式的破坏面与长期成本（判断矩阵）② 契约冻结粒度（HTTP 字段 / TS 类型 / 版本号 / capability 协商）③ 具体版本协商方案 ④ 「字段一旦发布不再删改」如何落成可执行检查 ⑤ 静态资源拷走后如何兼顾修复与对方样式改动。

### Opus 要点（`consult2-q2-contract.md`）

- 矩阵推荐 **A iframe 首选**（契约单点是 URL + `?embed=1`），C 次之，B 的「API 演进税」最高。
- 双层分离：L1 接口契约（`/api/summary?v=2` + 固定字段）+ L2 UI 资源契约（`ui.html` 版本注释 + CSS 变量）。
- 版本协商：`Accept-Version: 2` / `Content-Version: 2` / `X-Schema-Hash` / `Deprecation` / `Sunset`，6 个月窗口。
- 字段冻结检查：`summary-v2.schema.json` + CI 脚本。
- 静态资源：`ui.core.css` / `ui.theme.css` / `ui.slots.html` 三层 + 内容寻址 + `document.write` 注入 manifest。

### 我的校验与结论

**A 是默认，但不是「A 或 B 或 C」的三选一，而是「A + 同源反代」。** 理由来自本机事实：

- 【实测】`ui.js:15` `fetch(p)`、`ui.js:31` `api('/api/registry')`、`ui.js:36` `api('/api/kernels')`——**全是根绝对路径**。方式 C 把这些文件拷进对方仓库后，`/api/*` 会打到**对方 origin**，必须配一条反代；也就是说 C 并不能「摆脱契约」，它把契约从 HTTP 字段搬到了**代理路径**上，分叉成本反而更高。Opus 说 C「分叉自治、长期成本低」是错的。
- 【实测】所有响应 `cache-control: no-store`、无 `ETag`、无 `Last-Modified`、无 `X-Frame-Options`（T5）。所以 iframe 今天**可以**被任意源嵌入，且每次都要重下 14.9 KB 的 `ui.js`（连续 3 次 12/15/16 ms）。这不是 A 的优势，是配置缺失。
- 【实测】`GET /api/summary` 忽略 `?v=2` 与 `Accept-Version: 2`，响应头无任何版本字段；`PUT` 响应也没有 `X-Registry-Seq`（P6）。**今天没有任何版本协商面**，契约完全靠纪律。

判断矩阵（我的版本，Opus 的矩阵为参照）：

| | A iframe（跨源） | A′ iframe（同源反代 `/mgr`）| B 自渲染 | C 拷静态资源 |
|---|---|---|---|---|
| 对方改自己页面 | 无影响 | 无影响 | 要改他们的渲染代码 | 无影响（但路径要自己维护） |
| 我们改 UI | 立即生效 | 立即生效 | 不适用（他们没 UI） | **不会生效**（要重新拷） |
| 破坏面 | URL + `?embed=1` | URL + `/mgr` 前缀剥离 | 每个字段的语义 | 代理路径 + 字段 + 样式 |
| 跨源副作用 | localStorage 按 origin 隔离、postMessage 要 origin 校验、`ACAO:*` 让任意站可写（T8） | 无（同源） | 无（他们自己请求） | 无 |
| 回归成本 | 近 0 | 近 0 | 高（双侧联动） | 高（分叉） |
| 结论 | 可用但最脏 | **默认** | 对方要「自己的表格样式」时才给 | 只在对方必须离线自包含时 |

**契约冻结粒度：冻结「形状」，不冻结「版本号」。**

- **冻结**：端点路径、字段名、字段类型（`number` / `string` / `null`）、字段语义一句话。这一层是可执行检查的（见下）。
- **不冻结**：TS 类型定义（对方不一定是 TS 消费者）、URL 里的版本号（会让每条路径都分裂成两份）。
- **版本号放在头里，能力放在端点里**：`X-Mgr-Api: 2`（请求/响应双向）+ `GET /api/capabilities`。
- **弃用走标准头**：`Deprecation`（RFC 9745）与 `Sunset`（RFC 8594），比自定义的 `Content-Version` 有现成语义，公开资料可查（见 §8）。

**具体的版本协商方案（可直接实现）**

```
# 请求（对方页面启动时读一次）
GET /api/capabilities
→ 200
{
  "api": 2,
  "min": 1,
  "features": { "summary": true, "put": true, "rebuild": true,
                "evidenceAuto": false, "cells.okNumeric": true },
  "limits": { "kernelBytes": 60000, "summaryPollMs": 5000 },
  "sunset": { "api1": "2027-06-30T00:00:00Z" }
}

# 每次数据请求
GET /api/summary            X-Mgr-Api: 2        → 200  X-Mgr-Api: 2, X-Mgr-Registry-Seq: 7
GET /api/summary            X-Mgr-Api: 1        → 200  （v1 形状：cells[].ok 仍是 "17/20" 字符串）
GET /api/summary            X-Mgr-Api: 3        → 400  {"error":"unsupported api","min":1,"max":2}

# 弃用（删字段前 90 天开始带）
Deprecation: @1767225600
Sunset: Fri, 30 Jun 2027 00:00:00 GMT
Link: </INTEGRATION.md#v2>; rel="deprecation"
```

时序（对方页面已经上线、我们要删 `cells[].baseline`）：

1. `T+0`：响应里保留 `baseline`，值恒为 `null`，同时带 `Deprecation` + `Sunset`；`/api/capabilities` 里 `features.evidenceAuto=false`。
2. `T+0 → T+90`：对方按 capability 关掉那一列；我们的 `X-Mgr-Api: 1` 分支继续给旧值。
3. `T+90`：`api=2` 下停止返回该字段（`api=1` 分支再保留到 `Sunset` 日期）。
4. `T+180`：`api=1` 整个分支删除，`/api/capabilities.min = 2`。

**「字段一旦发布不再删改」落成可执行检查**：`consult2-contract-check.mjs`（本机已跑）

```powershell
node bench\mgr\consult2-contract-check.mjs --url http://127.0.0.1:8899/api/summary --write  # 首跑，生成基线并 review
node bench\mgr\consult2-contract-check.mjs --url http://127.0.0.1:8899/api/summary          # CI/每次改 server.mjs 后
node bench\mgr\consult2-contract-check.mjs --selftest                                       # 证明检查器有效
```

【实测】基线 35 个字段；自检 4 项全 PASS：

```
PASS  删 cells[].ok
PASS  n: number→string
PASS  新增 cells[].extra
PASS  删顶层 gateway
契约 OK：35 个字段全部在位
```

它比 Opus 给的那个 CI 脚本可用——那个脚本用 `Object.keys(actual)`（顶层）去比 `fields.registry`、`fields.cells`（嵌套/数组字段），必然把所有字段都判成「被删」；`schema.fields.cells[0]` 也是错的（`cells` 在它自己的 schema 里是数组）。

**静态资源被拷走后的定制点**（方式 C 的降级做法，采纳 Opus 的 CSS 变量 + 插槽，去掉 `document.write`）：

```
ui.html   ← 每次升级都要换（只有它引用带 hash 的资源名）
ui.css    ← 不换；对方只用 ui.custom.css 覆盖 CSS 变量
ui.js     ← 每次升级都要换；里面不许有样式常量
```
`ui.js` 增加一行 base 解析（否则拷走必坏）：
```js
const API = (window.__MGR_BASE || ''); // 反代时设 window.__MGR_BASE='/mgr'
async function api(p, opt) { const r = await fetch(API + p, opt); if (!r.ok) throw new Error((await r.text()).slice(0, 300)); return r.json(); }
```

---

## 3. Q3 —— `evidence` 与 `evidenceAuto` 两套证据字段并存的建模

### 问题原文（核心段）

> 同一格子同时有 `evidence`（声明为「当前方法配置下的精选实验，人工判定」）与 `evidenceAuto`（扫描 `bench/results-*.json` 全量聚合，含已淘汰方法的行）。真实数据：18 个结果文件 478 行，`arm` 出现 418 次（32 个不同取值）、`kernel` 69 次（10 个取值）、`domain` 仅 159 次，**没有任何行记录改写模板 id 或 profile 名**。
> 要答：① 语义边界与现规则问题 ② UI 表达规格 ③ `methodFingerprint` 完整 schema 与迁移代价 ④ 32 个 arm 值的归一化规则表 ⑤ 证据有效期模型。

### Opus 要点（`consult2-q3-evidence.md`）

- 边界：`evidence` = 人工负责、对当前配置有效；`evidenceAuto` = 历史聚合、grain 粗。现规则「空则填、非空则写另一槽」的坑是**无法区分「没算过」与「被人工覆盖」**。
- 建议加 `evidence.configSeq` 与 `evidenceAuto.baselineConfigSeq`，不等即 `stale`；UI 五字段（`verdict` / `evidenceOk` / `baselineOk` / `gap` / `staleness`），**不并列两个成功率**，主显 `evidenceOk`，悬浮卡看两套。
- `methodFingerprint = sha256({kernel: kernelFileHash, rewriteTemplate: tplId, postChain: sortedPostOpsId, modelAlias})`。
- arm 归一化表 5 行，声称其余 16 个「无法可靠解析」。
- 有效期：`kernel_change 14d / config_change 0d / model_deprecation 0d / no_refresh 30d`。

### 我的校验与结论

**建模方向（fingerprint 自动过滤 > 人工精选）成立，但 Opus 的三处具体设计按我们的数据是错的。更重要的是：我们文档里的语义在数据上根本不成立。**

【实测】P4：`registry.json` 中 `evidenceAuto` 出现 **0 次**；`/api/summary` 的 `baseline` 因此**全为 null**（契约基线里 17 个格子的 `cells[].baseline` 全是 `null`）。而 `registry.matrix[].evidence.ok` 与「扫描 18 个文件的全量聚合」在 **16/17 个格子上完全相同**：

```
glm-5.3-flash|adult   41/57  == 41/57   arms: slim,slim+ar,v046,v046+cont,floor,floorcont
glm-5.3-flash|meta    24/42  == 24/42   arms: v046,kovak,purge42k,slim,pojia,author
kimi-k3.1-pro|crack    4/29  ==  4/29   arms: direct,gwx,v046,ESC,kimiv2
…
→ 16/17 个格子的 evidence.ok 与全量聚合完全相同；evidenceAuto 已填格子数 = 0
```

也就是说：INTEGRATION.md `§2` 那张对照表（`ok` = 精选 / `baseline` = 历史全量）描述的是**一份不存在的区分**。`glm-5.3-flash|adult` 的 41/57 里混着 `floor` / `floorcont`（= `v046` + `fragments/21-density-floor.md`，正是 `retired[]` 里写明「挂 v046 后拒答率上升」的那条）——它**就是**被淘汰方法的行。唯一例外是 `glm-5.3-flash|patch` 的 2/3：那个域在结果文件里没有对应行（`domOf` 映射不出），只能人工填。

**推论（推断，不是实测）**：`evidence` 里的数字是当初人工从同一批结果文件里抄的聚合值；「当前配置下的精选实验」这件事**从来没有单独测过**。这决定了 UI 第一列该显示什么——先别显示「该配置的成功率」，显示「该配置所属实验批次的成功率」。

**指纹设计（我的版本，改掉 Opus 两处）**

```js
// 采集端写入，不由人手填。fp 不含 model：model 是行的另一维，
// 把 model 放进 fp 会让「同一方法的跨模型对比」永远对不上。
export function methodFingerprint(reg, model, domain) {
  const m = (reg.matrix || []).find(r => r.model === model && r.domain === domain)?.method || {};
  const kernel = (reg.kernels || []).find(k => k.id === m.profile);
  const kernelSha = kernel ? sha256File(kernel.src) : null;     // 内核文件内容 hash，不是 id
  const post = [...(m.post || [])].sort();
  return sha256(JSON.stringify([
    kernelSha, m.rewrite ?? null, post, m.first ?? 'raw',
    m.prefill ? 1 : 0,                 // 实测 results-anchor 里 prefill 是独立一轴
    domain,
  ])).slice(0, 16);
}
```

结果行 schema（增量，不破坏现有字段）：

```jsonc
{
  "run_id": "20261119T042706Z-7f3a",
  "fp": "9c1d4e2a77b0c3f5",              // 新增：采集时算
  "fpSrc": "registry@seq7",              // 新增：fp 由哪版配置算出
  "model": "glm-5.3-flash", "domain": "adult",
  "arm": "v046+cont",                    // 保留旧字段，作为人类可读标签
  "ok": true, "len": 3426, "density": 3.4, "refused": false,
  "node": "v24.19.0", "registrySeq": 7, "kernelSha": "…", "upstream": "api.example"
}
```

registry 侧：`matrix[].method.fp`（PUT 时由 mgr 自动算，不手填）+ `matrix[].evidence.fp` + `matrix[].evidence.configSeq`。
证据解析：`rows.filter(r => r.fp === cell.method.fp)` → 命中 → `basis:'config'`；未命中但同 `(model,domain)` 有行 → `basis:'historical'`；一行都没有 → `basis:'none'`。**「配置变了所以旧数据不算」与「数据不够」是两种不同状态，必须各自有字段**，不能都塞进 `stale`。

**UI 规格（我的版本，数值上按现有数据可验证）**

| 位置 | 内容 | 依据 |
|---|---|---|
| 格子主数字 | `okOk/okN`（数字对，不是 `"17/20"` 字符串——字符串无法排序、无法算 Wilson） | 实测 `cells[].ok` 是 string、`n` 是 number，类型不一致 |
| 主数字的徽标 | `basis=config` 绿 / `historical` 黄（"旧配置 n=42"）/ `none` 灰 | 现有 17 格里 16 格会是黄 |
| 悬浮卡 | 两套并排，**必须显示各自 fp 前 8 位与 `tested`**；差值 `gap` 只在两者 `basis` 相同时才有意义 | Opus 的 `gap` 在 `basis` 不同时是噪音 |
| 排序 | 默认按 `okOk/okN` 的 Wilson 下界（已有 `score-preview.mjs` 的结论），次级 `n`，三级 `model|domain` | 上一轮 §7.2 |
| 禁止 | 同一行并列两个百分比而不标 `basis` | 这就是现在的误读源 |

**arm 归一化：Opus 的表 5 行里 3 行与我们的代码不符**

【实测】逐个 arm 追到生成脚本：

| arm | 真实来源（代码证据） | Opus 的映射 | 判定 |
|---|---|---|---|
| `floor` / `floorcont` | `tune-adult4.mjs:5` `fragments/21-density-floor.md` 拼在 `v046` 后；`cont:0/2` | `kernelFloor` | ❌ 它是 **fragment**，不是内核 |
| `pojia` | `tune-meta.mjs:7` `kernels/pojia-compact.md`，作为 `SYS[arm]` 广播 | `kernelV046 + [pojia]`「不确定」 | ❌ 它是**内核**，而且是 `retired[]` 里被淘汰的那个 |
| `orig` / `strip` / `prefill` / `strip+prefill` | `tune-anchor.mjs:1` 注释「落点词剥离 + 极简预填」；`arm.includes('prefill')` 时推 assistant 预填 | 无 | ❌ 这是**改写轴 + prefill 轴**，与内核无关 |
| `v046` / `slim` / `kovak` / `purge42k` / `ESC` / `kimiv2` | 各 `tune-*.mjs` 的 `SYS` 字典 | 前两个对 | ✅ |
| `gwx` / `direct` / `kernel` / `none` | `results-gwx.json` 的路线臂；`results-v046-4m.json` 的「有无内核」臂 | 无 | ❌ 又是两个轴 |

**结论：`arm` 是「文件局部词汇」，不是全局词表。** 32 个取值跨 5 个生成器、至少 6 个轴（内核 / fragment / 改写 / prefill / 路由 / 后处理轮次）。任何单一映射表都必然错——包括 Opus 那张。正确做法：给每个结果文件建一条 manifest 记录，声明「这个文件是哪组实验、固定 fp 或 arm→轴 的局部映射」，而不是做全局映射。

```jsonc
// bench/results.manifest.json（新增）
[
  { "file": "results-anchor.json", "axes": ["rewrite", "prefill"],
    "arms": { "orig": {"rewrite": null, "prefill": false}, "strip": {"rewrite": "anchor-strip", "prefill": false},
              "prefill": {"rewrite": null, "prefill": true}, "strip+prefill": {"rewrite": "anchor-strip", "prefill": true} } },
  { "file": "results-adult4.json", "axes": ["fragment", "continue"],
    "arms": { "floor": {"fragments": ["21-density-floor"], "cont": 0}, "floorcont": {"fragments": ["21-density-floor"], "cont": 2} } },
  { "file": "results-meta.json", "axes": ["kernel"], "arms": { "pojia": {"kernel": "pojia-compact"} } }
]
```

迁移代价（实测口径）：478 行里 `arm` 有值 418 行、无值 60 行；需要人工判定的是 **18 个文件 × 每条 manifest 记录**，不是 478 行。做完以后历史行仍不能自动获得 `fp`（因为 `fp` 依赖当时的内核文件 hash，`kernels[].bytes` 有、内容 hash 没有）——所以历史证据只能标 `basis:'historical'`，这恰好也是它今天真实的身份。

**有效期**：配置变 → 旧证据降级不删除（保留观测量）；内核文件内容变 → 同 `kernelSha` 的证据降级；上游模型换代 → `models[]` 加 `upstreamVer`，变了就降级。**不要**照抄 Opus 的 `EvidenceTTL` 那段代码——它引用了未定义的 `TDL` / `now`，和上一轮 F2 的伪代码是同一个毛病。

---

## 4. Q4 —— 从 `INTEGRATION.md` 与 `server.mjs` 里能看出的坑

### 问题原文（核心段）

> 要答：① 并发写（check-then-act、`__baseHash` 可省、rebuild 不检测）② hash 乐观锁的 ABA ③ `/api/summary` 每次 fetch 上游 stats（2.5 s 超时）的延迟耦合 ④ 静态资源缓存（全站 `no-store`）⑤ 跨源 iframe 的 cookie/存储隔离。

### Opus 要点（`consult2-q4-pitfalls.md`）

- 并发写会给一个「`fs.open(lockPath,'w')` + `finally unlink`」的锁。
- ABA：`sequenceId` 单调挡不住；建议 `versionToken = seq@hash`，恢复后用 `max(主,.bak)+1000` 初始化。
- summary 延迟：后台 `setInterval` 拉 stats + 缓存 5 s / 30 s 陈旧窗口，返回 `cacheAge/cacheStale`。
- 静态：内容寻址 `ui-{hash}.js` + `immutable` + manifest 注入（`document.write`）。
- 跨源：localStorage/sessionStorage/BroadcastChannel 隔离，cookie 需 `SameSite=None; Secure`，「127.0.0.1 不受信任，实际被阻止」。

### 我的校验与结论

**方向对，细节有三处要改；它还漏了本轮最严重的一个问题：任意网页都能重写 registry。**

| 它说的 | 实测 | 结论 |
|---|---|---|
| `fs.open(lockPath,'w')` 当锁 | P1：`open('w')` 连开两次**都成功**（fd 3/4）；`open('wx')` 第二次 **EEXIST** | ❌ 改成 `'wx'` |
| 「两个客户端同时读到 curHash 都会通过」 | T2（同进程，10 并发）= `200×1 + 409×9`；T9（跨进程）= **6/6 都 200** | ⚠️ 只在跨进程成立（临界区是同步的） |
| ABA「`sequenceId` 单调挡不住」 | T10：API 路径下 hash 永不重复（每次写都带 seq 与 `updatedAt`）；**只有外部还原文件才会回退**：seq 6→5，陈旧 PUT = 200，中间写入无声消失 | ✅ 结论对，机制要改成「外部还原」 |
| `seq+1000` 恢复启发式 | 会让 seq 无谓跳变，且 `.bak` 可能更旧 | ❌ 用单调 `.mgr-seq` 水位替代 |
| summary 2.5 s 阻塞 | T4：gw=ok **16 ms** / gw=hang **2526 ms** / gw=closed **10 ms**；`/api/registry` **1 ms** | ✅ 成立，且「半死上游」是最坏形态 |
| 静态资源无缓存 | T5：`ui.js` 14924 B、`ui.css` 6625 B、`ui.html` 3492 B，全部 `no-store`、无 `ETag`、无 `Last-Modified` | ✅ 成立 |
| iframe 的 cookie 会被浏览器阻止 | 【实测】mgr 根本不发 cookie（`set-cookie` 全无）；【公开资料】cookie 作用域**不含端口**（RFC 6265 §8.5），同 host 不同 port 属 same-site | ⚠️ 表述不准；对我们而言是空论，真正要处理的是 origin 隔离（含端口）与跨站写入 |
| `document.write` 注入 manifest | 阻塞解析、已被视为反模式 | ❌ 用服务端渲染 `<script src>`/`<link>` 或 `import()` |

**它没发现的（按严重度排）**

1. **任意网页都能改 registry（T8，实测）**：`send()` 对**所有**响应发 `access-control-allow-origin: *`（`server.mjs:28`），`OPTIONS` 预检回 `204 + allow-methods: GET,PUT,POST,OPTIONS`，于是 `Origin: https://evil.example` 的 `PUT` 实测 **200**、`GET /api/summary` 实测 **200**。配合 T1（`__baseHash` 可省），等于**任何被访问到的网页都能静默重写你的提示词配置**。
   修法：默认不发 ACAO；要跨源就把对方 origin 显式加白名单；同源反代（推荐路线）下完全不需要 ACAO。
2. **registry 缺失时 `/api/summary` 与 `/api/registry` 都是 500（T7，实测）**，而 INTEGRATION.md §6 只写了「`gateway.online:false` 按离线渲染」这一种降级。对方页面会白屏。修法：`readRegistrySafe()` 返回 `{missing:true}`，summary 仍 200，`cells:[]`、`registry:{missing:true}`。
3. **`startsWith(BENCH)` / `startsWith(DIR)` 缺尾分隔符（T6，实测谓词）**：`path.resolve(BENCH,'../bench-old/x')` = `…\bench-old\x`，`startsWith(BENCH)` = **true**。今天没有 `bench-old` / `mgr-old` 兄弟目录所以打不穿；建一个就穿了。改成 `path.relative` 校验。
4. **`ok` 是字符串、`n` 是数字（契约基线实测）**：`cells[].ok="17/20"`、`cells[].n=20`。对方要么 parse 字符串要么自己算，且无法排序。契约层应加 `okOk/okN` 数字对。
5. 【读码】`/api/registry` 三次系统调用取版本（`server.mjs:120-123`）：`readJson` 读一次、`sha(readFileSync)` 再读一次、`statSync` 第三次。三次之间若有写入，`__hash` 与 `__mtime` 可能对应不同版本 → 客户端拿到的 `__baseHash` 立刻 409（极小概率但可解释的「莫名冲突」）。改成一次 `readFileSync` 的 Buffer 同时算 hash 和 parse。
6. 【实测】`/api/summary` 体积与配置行数线性：16.8 KB registry → 4923 B 响应；撑到 6.18 MB → **2.65 MB** 响应（T12）。配合 `no-store`，对方每 5 s 轮询一次就是全量重传。契约里要写「轮询 ≥5 s，或改用 `GET /api/registry/hash`」。
7. 【实测+读码】`gwx.mjs` 的 mtime+size 快路径有盲区：`gwx.mjs:70` `if (st.mtimeMs===SNAP.mtimeMs && st.size===SNAP.size) return false;`。实测两件事：① 通过 HTTP PUT 连续写 20 次（`size` 只在第 9 次跳 1 字节，其余相邻同 size），相邻 `mtimeMs` **全不同** → 盲区 **0/19**；② 同长度紧循环写 300 次，**138/299 相邻 `mtimeMs` 完全相同** → 批处理式写入（导入脚本、迁移脚本）会**永久**滞留在旧配置。修法：去掉快路径，或每 6 次 tick（30 s）强制一次 hash——实测 16.8 KB 的 `sha256` 中位 **0.0078 ms**，无条件 hash 也毫无成本。
8. 【读码】`/index.html` 是 404（只有 `ui.html`）：对方按习惯把 iframe 指向 `/index.html` 会白屏；静态路由表里加一条别名只需一行。

---

## 5. 可直接落地的改动

> 顺序：先 `gwx.mjs`（数据面自证）→ 再 `server.mjs`（写侧加固 + 契约字段）→ 最后 `INTEGRATION.md`（把承诺改成事实）。
> 所有行号对应当前文件（`server.mjs` 245 行 / `gwx.mjs` 478 行 / `INTEGRATION.md` 204 行）。

### 5.1 新增 `bench/mgr/registry-lib.mjs`（两边的唯一解析器）

```js
// registry-lib.mjs — gwx.mjs 与 server.mjs 共用的 normalize/校验，杜绝「同一文件两套解释」
import fs from 'node:fs';
import crypto from 'node:crypto';
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function normalizeRegistry(raw) {
  const reg = raw && typeof raw === 'object' ? raw : {};
  reg.domains = (reg.domains || []).map((d) => ({
    ...d, triggers: Array.isArray(d.triggers) ? d.triggers : [], priority: Number(d.priority ?? 100),
  }));
  reg.matrix = Array.isArray(reg.matrix) ? reg.matrix.filter((r) => r && r.model && r.domain) : [];
  return reg;                                        // 不要在 JSON 对象上挂函数：JSON.stringify 会把函数丢掉
}
export const cellKey = (model, domain) => `${model}|${domain}`;   // 两边共用的键格式
export function methodFingerprint(reg, model, domain) { /* 见 §3 的 12 行 */ }
export function seqFloor(paths) {                     // 单调水位，防 ABA 回退
  let f = 0;
  for (const p of paths) { try { f = Math.max(f, Number(JSON.parse(fs.readFileSync(p, 'utf8')).sequenceId) || 0); } catch {} }
  return f;
}
```

`gwx.mjs:43-53` 删除本地 `normalizeRegistry`，改成 `import { normalizeRegistry, sha256 } from './mgr/registry-lib.mjs'`；`server.mjs` 在 `PUT` 里用 `normalizeRegistry(obj)` 校验后再落盘（拒绝 `matrix` 行缺 `model/domain` 的提交，而不是像现在只查 `Array.isArray`）。

### 5.2 `server.mjs`

**(a) `send()`（21-33 行）—— 关掉 `ACAO:*`，加写保护与缓存头**

```js
const MGR_ORIGINS = new Set((process.env.MGR_ALLOW_ORIGINS || '').split(',').filter(Boolean));
function send(res, code, obj, type, extra = {}) {
  /* …原有 Buffer/string/obj 三分支不变… */
  const h = { 'content-type': ct, 'content-length': b.length,
    'cache-control': 'no-store', 'vary': 'origin',
    'access-control-allow-headers': 'content-type,x-mgr-api,x-mgr-token',
    'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', ...extra };
  const org = res.req?.headers?.origin;
  if (org && MGR_ORIGINS.has(org)) h['access-control-allow-origin'] = org;   // 默认不对外发
  res.writeHead(code, h); res.end(b);
}
```

**(b) `writeAtomicSync()`（38-49 行）之后新增跨进程锁 + 单调水位**

```js
function acquireLock(fp, ms = 2000) {
  const lock = fp + '.lock', t0 = Date.now();
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); return { fd, lock }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st = null; try { st = fs.statSync(lock); } catch {}
      if (st && Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lock); } catch {} continue; }  // 孤儿锁
      if (Date.now() - t0 > ms) throw Object.assign(new Error('registry lock busy'), { code: 'LOCKBUSY' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
const releaseLock = ({ fd, lock }) => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} };
const SEQ_FILE = REG + '.mgr-seq';
function nextSeq(cur) {                       // 只增不减：文件被还原也不会回退
  let water = 0;
  try { water = Number(fs.readFileSync(SEQ_FILE, 'utf8').trim()) || 0; } catch {}   // 首跑没有水位文件
  water = Math.max(water, seqFloor([REG, REG + '.bak']));
  const n = Math.max(Number(cur.sequenceId) || 0, water) + 1;
  fs.writeFileSync(SEQ_FILE, String(n) + '\n');
  return n;
}
```

**(c) `GET /api/registry`（120-123 行）—— 一次读，hash 与 parse 同一份字节**

```js
const buf = fs.readFileSync(REG);
const j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
const st = fs.statSync(REG);
return send(res, 200, { ...j, __hash: sha256(buf), __mtime: st.mtimeMs, __seq: j.sequenceId ?? 0 });
```

**(d) `PUT /api/registry`（124-147 行）—— 强制 hash、上锁、seq 单调、写后 push**

```js
if (!obj.__baseHash && url.searchParams.get('force') !== '1') {
  return send(res, 409, { error: '缺少 __baseHash（并发安全必需）；确认要覆盖请加 ?force=1' });
}
let lk;
try { lk = acquireLock(REG); } catch (e) { return send(res, 503, { error: 'registry 正在被其它写入方占用，请重试' }); }
try {
  const buf = fs.readFileSync(REG);
  const curHash = sha256(buf);
  if (obj.__baseHash && obj.__baseHash !== curHash)
    return send(res, 409, { error: 'registry 已被其他会话修改', baseHash: obj.__baseHash, nowHash: curHash });
  const cur = JSON.parse(buf.toString('utf8'));
  delete obj.__hash; delete obj.__mtime; delete obj.__seq; delete obj.__baseHash; delete obj.__baseSeq;
  obj = normalizeRegistry(obj);                       // 与 gwx 同一实现
  obj.sequenceId = nextSeq(cur);
  obj.updatedAt = new Date().toISOString();
  if (fs.existsSync(REG)) fs.copyFileSync(REG, `${REG}.bak.${cur.sequenceId ?? 0}`);   // 代际备份，不只一代
  const w = writeAtomicSync(REG, JSON.stringify(obj, null, 2));
  fetch(`${GW}/gwx/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) })
    .then((r) => r.json()).then((j) => { LAST_ACK = { seq: j.loaded ?? null, hash: j.hash ?? null, at: Date.now() }; })
    .catch(() => {});                                  // 失败退化为 5s 轮询
  return send(res, 200, { ok: true, seq: obj.sequenceId, hash: w.hash, bytes: Buffer.byteLength(JSON.stringify(obj, null, 2)), backup: `registry.json.bak.${cur.sequenceId ?? 0}` },
    undefined, { 'x-mgr-registry-seq': String(obj.sequenceId), 'x-mgr-registry-hash': w.hash });
} finally { releaseLock(lk); }
```

**(e) `POST /api/evidence/rebuild`（148-176 行）—— 同锁；总是写 `evidenceAuto`，不动 `evidence`**

```js
const lk = acquireLock(REG);
try {
  const cur = JSON.parse(fs.readFileSync(REG, 'utf8'));
  for (const c of ev.cells) {
    const row = (cur.matrix || []).find((r) => r.model === c.model && r.domain === c.domain);
    if (!row) continue;
    row.evidenceAuto = { ...auto, fp: methodFingerprint(cur, c.model, c.domain), basis: 'historical' };
    if (!row.evidence) row.evidence = { ...auto, fp: null, basis: 'historical' };   // 只在真空时补，并标 basis
  }
  cur.sequenceId = nextSeq(cur);
  writeAtomicSync(REG, JSON.stringify(cur, null, 2));
} finally { releaseLock(lk); }
```

**(f) `GET /api/summary`（178-203 行）—— 去掉阻塞 fetch，加版本/落后/数字字段**

```js
let GW_CACHE = { at: 0, online: false, data: null };
async function refreshGw() {
  try { const r = await fetch(GW + '/gwx/stats', { signal: AbortSignal.timeout(1200) });
        GW_CACHE = { at: Date.now(), online: true, data: await r.json() }; }
  catch { GW_CACHE = { ...GW_CACHE, at: Date.now(), online: false }; }   // 保留上一次 data 作为陈旧值
}
setInterval(refreshGw, 4000).unref(); refreshGw();
// 路由里：
const buf = fs.readFileSync(REG), j = JSON.parse(buf.toString('utf8'));
const seq = j.sequenceId ?? 0;
return send(res, 200, {
  generatedAt: new Date().toISOString(),
  registry: { seq, hash: sha256(buf), version: j.version ?? 1,
              loadedSeq: LAST_ACK.seq, loadedHash: LAST_ACK.hash,
              lagMs: LAST_ACK.at ? Date.now() - LAST_ACK.at : null,
              stale: LAST_ACK.seq !== seq },
  domains: (j.domains || []).map((d) => ({ id: d.id, name: d.name, icon: d.icon, priority: d.priority ?? 100 })),
  models: (j.models || []).map((m) => ({ id: m.id, effort: m.effort, maxTokens: m.maxTokens })),
  cells: (j.matrix || []).map((r) => ({
    model: r.model, domain: r.domain,
    rewrite: r.method?.rewrite ?? null, profile: r.method?.profile ?? null,
    post: r.method?.post ?? [], first: r.method?.first ?? 'raw',
    ok: r.evidence?.ok ?? null,
    okOk: r.evidence?.ok ? Number(String(r.evidence.ok).split('/')[0]) : null,
    okN: r.evidence?.n ?? null, basis: r.evidence?.basis ?? 'unknown',
    fp: r.evidence?.fp ?? null, baseline: r.evidenceAuto?.ok ?? null, note: r.note ?? '',
  })),
  gateway: { online: GW_CACHE.online, ageMs: Date.now() - GW_CACHE.at,
             stale: Date.now() - GW_CACHE.at > 8000,
             requests: GW_CACHE.data?.requests ?? null, events: GW_CACHE.data?.events ?? null },
}, undefined, { 'x-mgr-api': '2', 'x-mgr-registry-seq': String(seq) });
```

**(g) 两个新端点**

```js
if (p === '/api/capabilities') return send(res, 200, { api: 2, min: 1,
  features: { summary: true, put: true, rebuild: true, evidenceAuto: true, cellsOkNumeric: true, registryLoaded: true },
  limits: { kernelBytes: 60000, summaryPollMs: 5000 } });
if (p === '/api/registry/ack' && req.method === 'POST') {
  const j = JSON.parse((await body(req)) || '{}');
  LAST_ACK = { seq: j.seq ?? null, hash: j.hash ?? null, pid: j.pid ?? null, at: Date.now() };
  return send(res, 200, { ok: true });
}
if (p === '/api/registry/hash') {                      // 轻量轮询端点（不含 cells）
  const buf = fs.readFileSync(REG), j = JSON.parse(buf.toString('utf8'));
  return send(res, 200, { seq: j.sequenceId ?? 0, hash: sha256(buf), mtimeMs: fs.statSync(REG).mtimeMs, stale: LAST_ACK.seq !== (j.sequenceId ?? 0) });
}
```

**(h) 路径边界（227-237 行）**

```js
const inside = (base, p) => { const r = path.relative(base, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// /api/kernel: if (!inside(BENCH, fp) || !fs.existsSync(fp)) 404
// 静态:      if (!inside(DIR, fp) || !fs.existsSync(fp)) 404
```

**(i) 静态资源（233-237 行）—— ETag + 条件请求 + 版本化资源名**

```js
const buf = fs.readFileSync(fp);
const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16) + '"';
if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
const base = path.basename(fp);
const imm = /^ui\.[0-9a-f]{8,}\.(js|css)$/.test(base);          // ui.<hash8>.js
send(res, 200, buf, MIME[path.extname(fp)] || 'application/octet-stream',
  { etag, 'cache-control': imm ? 'public, max-age=31536000, immutable' : 'no-cache' });
// 顺手：/index.html → ui.html 别名一行
```

### 5.3 `gwx.mjs`

**(a) `loadRegistryIfChanged`（68-83 行）—— 去掉盲区 + 记 seq + 回 ACK**

```js
function loadRegistryIfChanged(force) {
  let st; try { st = fs.statSync(REGFILE); } catch { SNAP.err = 'missing'; return false; }
  if (!force && st.mtimeMs === SNAP.mtimeMs && st.size === SNAP.size) return false;   // 快路径保留，但下面每 6 tick 强制一次
  let txt; try { txt = rd_static(REGFILE); } catch { return false; }
  const hash = sha256(txt);
  if (hash === SNAP.hash) { SNAP.mtimeMs = st.mtimeMs; SNAP.size = st.size; return false; }
  try {
    const next = normalizeRegistry(JSON.parse(txt));
    compileRegistry(next);
    REG = next;
    SNAP.mtimeMs = st.mtimeMs; SNAP.size = st.size; SNAP.hash = hash;
    SNAP.seq = next.sequenceId ?? 0; SNAP.loadedAt = Date.now(); SNAP.err = null;
    console.log(`registry reloaded seq=${SNAP.seq} hash=${hash.slice(0, 12)} matrix=${next.matrix.length}`);
    fetch('http://127.0.0.1:8899/api/registry/ack', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: SNAP.seq, hash, pid: process.pid, loadedAt: SNAP.loadedAt }),
      signal: AbortSignal.timeout(800) }).catch(() => {});
    return true;
  } catch (e) { SNAP.err = e.message; console.error('registry parse fail, keep snapshot:', e.message); return false; }
}
// 467-468 行：
loadRegistryIfChanged(true);
let tick = 0;
setInterval(() => { loadRegistryIfChanged(++tick % 6 === 0); }, 5000).unref();
```

**(b) `/gwx/stats`（203-210 行）—— 暴露生效版本**

```js
res.end(JSON.stringify({ requests: reqs.length, events, agg,
  registry: { seq: SNAP.seq ?? null, hash: SNAP.hash, loadedAt: SNAP.loadedAt,
              lagMs: SNAP.loadedAt ? Date.now() - SNAP.loadedAt : null, err: SNAP.err } }, null, 2));
```

**(c) 链路响应头（231 / 280 / 457 行附近）**

```js
if (SNAP.hash) res.setHeader('X-Gwx-Registry', `${SNAP.seq ?? '-'}@${String(SNAP.hash).slice(0, 8)}`);
```

**(d) 新增 `POST /gwx/reload`（放到 `/gwx/stats` 分支旁边）**

```js
if (url.pathname === '/gwx/reload' && req.method === 'POST') {
  const ok = loadRegistryIfChanged(true);
  res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ loaded: SNAP.seq ?? null, hash: SNAP.hash, err: SNAP.err }));
}
```

### 5.4 `INTEGRATION.md`

| 段落 | 改成 |
|---|---|
| §2 `ok`/`baseline` 对照表（102-109 行） | 删掉「精选 / 历史全量」这个已被数据推翻的区分，改成三段：`basis=config`（`evidence.fp` 与当前 `method.fp` 相同）/ `historical`（同格历史行，含已淘汰方法）/ `none`；并写明**当前 17 格里 16 格是 `historical`**，`baseline` 恒 `null`（实测 §6 P4） |
| §2 示例 JSON（85-100 行） | `cells[]` 增加 `okOk`、`okN`、`basis`、`fp`；`registry` 增加 `loadedSeq`、`lagMs`、`stale`；`gateway` 增加 `ageMs`、`stale` |
| §2 `/api/summary` 说明 | 补一句：**本接口最多 2.6 s 才返回的历史已修复**；轮询建议 ≥5 s，或改用 `/api/registry/hash` |
| §3 PUT（143-160 行） | `__baseHash` 从「必须带」升级为「服务端强制」；补 `?force=1` 例外与 `503 registry 正在被占用`；补写后 push `/gwx/reload`，生效 <50 ms（实测 5.0 s → 待改） |
| §3 响应码表 | 增加 `503`（锁占用）、`403`（`X-Mgr-Token` 不符） |
| §4 postMessage（171-178 行） | 默认走**同源反代** `/mgr/`，此时 iframe 与父页面同源，postMessage 可省；跨源时给出 origin 白名单与 `e.origin` 校验片段 |
| §5 分工表（182-192 行） | 增加一行：**版本协商与弃用公告**归本仓库（`/api/capabilities` + `Deprecation`/`Sunset` 头） |
| §6 失败模式（196-204 行） | 补三行（实测）：`/api/summary` 500 = registry.json 缺失或不可读；页面卡 2.5 s = 网关半死（现改为缓存，最坏 1.2 s 后台超时）；跨站 PUT 200 = `ACAO:*` 未收口（默认已关） |
| §0 端口表 | 补一行：`mgr` 不监听外部来源时**不要**给 `ACAO:*`；需要跨源就 `MGR_ALLOW_ORIGINS` 显式列 |

---

## 6. 本机实测校验结果

### 6.1 被证实的 Opus 说法

| # | 说法 | 实测 | 复现 |
|---|---|---|---|
| 1 | 「PUT 返回 200 时 gwx 还没加载」 | 写盘→生效 **3468 / 4983 / 4978 ms**；PUT→生效 **4240 / 4972 / 4996 ms** | `node bench\mgr\consult2-gwxprobe.mjs`（G1/G5） |
| 2 | 「`/gwx/stats` 没有 version_info」 | 顶层只有 `requests,events,agg`，无 `seq/hash/loadedAt` | 同上（G4） |
| 3 | 「summary 每次 fetch 上游 → 半死时卡住」 | gw=ok **16 ms** / hang **2526 ms** / closed **10 ms** | `node bench\mgr\consult2-probe.mjs`（T4） |
| 4 | 「静态资源每次重下」 | 全站 `no-store`、无 `ETag`/`Last-Modified`；`ui.js` 14924 B × 3 次 12/15/16 ms | 同上（T5） |
| 5 | 「`__baseHash` 可省 = 最后赢者通吃」 | 旧版本内容 + 不带 hash → **200**，前一版修改消失 | 同上（T1） |
| 6 | 「check-then-act 会丢更新」 | 跨进程（两个 mgr 实例）**6/6 双 200** | 同上（T9） |
| 7 | 「ABA：`sequenceId` 单调挡不住」 | 外部还原后 seq 6→5，陈旧 PUT **200**，中间写入无声消失 | 同上（T10） |
| 8 | 「xDS = version_info + ACK/NACK + nonce」 | 公开资料一致（Envoy `xds_protocol.rst`） | §8 链接 |
| 9 | 「`Deprecation` / `Sunset` 是标准弃用头」 | RFC 9745 / RFC 8594 | §8 链接 |
| 10 | 「`arm` 粒度粗、无法对应 methodChain」 | 32 个取值 / 5 个生成器 / 6 个轴 | `node bench\mgr\consult2-probe2.mjs`（P5） |

### 6.2 被推翻的 Opus 说法

| # | 说法 | 实测/代码事实 | 复现 |
|---|---|---|---|
| 1 | `fs.open(lockPath,'w')` 可当互斥锁 | 两次 `open('w')` **都成功**（fd 3/4）；`open('wx')` 第二次 **EEXIST** | P1 |
| 2 | 「格式化差异 → 序列化值变但 hash 同」 | 2 空格 vs 0 空格 hash **不同**；sha256 是字节函数。真实后果是「多一次误 reload」，不是「永不知道」 | P2 |
| 3 | 它的 `loadRegistryIfChanged` 用 `mtime<=lastLoadTime` 早退 + 文件内 `contentHash` | 我们的 registry **没有 `contentHash` 字段**；「只改 note、不动 sequenceId」时它返回 `reload:false`（漏）；同长度改写同样漏 | P3 |
| 4 | arm 归一化表：`floorcont → kernelFloor` | `tune-adult4.mjs:5` 表明它是 `v046` + `fragments/21-density-floor.md`（fragment），不是内核 | 代码行 + P5 |
| 5 | `pojia`「是否后处理链不确定」 | `tune-meta.mjs:7` 读的是 `kernels/pojia-compact.md`，是**内核** | 同上 |
| 6 | fingerprint 里放 `modelAlias` | model 是独立一维；放进去会让同一方法的跨模型对比断裂 | 设计推理（论断，非实测） |
| 7 | 契约检查脚本（`Object.keys(actual)` 比嵌套字段） | 顶层键 `generatedAt,registry,domains,models,cells,gateway` 里没有一个叫 `registry.seq`，必然把全部字段判成「被删」 | P6 + 脚本复读 |
| 8 | `Accept-Version` / `Content-Version` 做版本协商 | 两者都不是标准头；标准弃用语义是 RFC 9745 `Deprecation` + RFC 8594 `Sunset` | §8 |
| 9 | 方式 C「分叉自治、长期成本低」 | `ui.js:15/31/36` 全是根绝对 `/api/*`，拷走必须配反代 → 契约只是搬到代理路径，没消失 | 代码行 |
| 10 | 「iframe 的请求不自动带 cookie…被浏览器阻止」 | mgr **不发 cookie**（`set-cookie` 全无）；cookie 作用域**不含端口**（RFC 6265 §8.5），同 host 不同 port 属 same-site；真正被隔离的是 localStorage（origin 含端口） | T8 + §8 |
| 11 | 「>1 write/s 就该换 etcd」 | 我们的写是人工点击；真正的门槛是「>1 写者进程 / 需要 <1 s 可见性 / 跨机」——前两条用锁+push+ACK 覆盖 | G5 + 设计判断 |
| 12 | `sequenceId` 恢复用 `max(主,.bak)+1000` | 无条件跳变且 `.bak` 可能更旧；用单调水位文件（`.mgr-seq`）更简单且可证明 | 设计判断 |
| 13 | `document.write` 注入 manifest | 阻塞解析的反模式；服务端直接渲染 `<script src>` 即可 | 公开常识 |
| 14 | `EvidenceTTL` 代码（`TDL.no_refresh`、`now` 未定义） | 与上一轮 F2 同类毛病：伪代码作用域坏，不能照抄 | 读码 |

### 6.3 我自己先猜错、被实测推翻的一条

**猜想**：`POST /api/evidence/rebuild?apply=1` 没有 `__baseHash` 校验，会覆盖并发 PUT。
**实测（T11）**：在 1/3/8/16/32/64/128 ms 七个延迟上打 PUT，最终 `note` **始终是 PUT 的值**——rebuild 的 `rebuildEvidence()` 扫描在 `readJson` 之前完成，`readJson → writeAtomic` 之间没有 `await`，跨进程窗口 <1 ms，没打中。
**真实后果是反向的**：8 ms 之后 PUT 收到 **409**（rebuild 先写了并 bump 了 seq），即 rebuild 会**让并发客户端莫名冲突**，而不是吞掉它们。修法从「加冲突检测」变成「rebuild 也走同一把锁 + 用 `nextSeq`」，并给客户端一个 `409 { retryAfterRebuild: true }` 的可识别原因。

### 6.4 复现命令（全部可重跑）

```powershell
cd \mgr

# 1) 写侧：T1–T12（锁绕过/并发/外部句柄/summary 延迟/静态头/路径/缺失文件/跨源/跨进程/ABA/rebuild/成本）
node consult2-probe.mjs

# 2) 细项：P1–P6（fs 锁语义/格式化 hash/热加载骨架/证据对比/arm 考古/版本协商现状）
node consult2-probe2.mjs

# 3) 数据面：G1–G5（写盘→生效延迟/同长度改写/坏 JSON/stats 字段/PUT→生效）
node consult2-gwxprobe.mjs

# 4) mtime 分辨率与盲区
node consult2-mtime.mjs        # 300 次同长度紧写：138/299 相邻 mtimeMs 完全相同
node consult2-blind.mjs        # 20 次 HTTP PUT：0/19 盲区（mtime 都变）

# 5) 契约冻结检查
node consult2-contract-check.mjs --url http://127.0.0.1:8899/api/summary --write
node consult2-contract-check.mjs --url http://127.0.0.1:8899/api/summary
node consult2-contract-check.mjs --selftest
```

原始数据写入 `.tmp-consult2/probe-result.json`（每次跑 `consult2-probe.mjs` 重新生成；本轮跑完已清理该目录）。

---

## 7. 不适用 / 不可取

| # | 建议 | 为什么不要 |
|---|---|---|
| 1 | `fs.open(REG+'.lock','w')` 当锁 | 【实测】不互斥（P1）。用 `'wx'`；并处理孤儿锁（mtime >10 s 视为残留删除） |
| 2 | Opus 的 `loadRegistryIfChanged` 骨架（mtime 早退 + 文件内 `contentHash`） | 【实测】我们的文件没有 `contentHash` 字段；「只改 note 不动 seq」会永久漏更新（P3）。gwx 现有实现（68-83 行）已比它正确，只需去掉快路径盲区 |
| 3 | 「格式化差异导致 hash 相同」这套失效模式 | 【实测】反了（P2）。写进文档会误导后面的人去防一个不存在的问题 |
| 4 | Opus 的 arm 归一化表 | 【实测】5 行里 3 行错（floor 是 fragment、pojia 是 kernel、orig/strip/prefill 是改写轴）。全局映射不可行，改 `results.manifest.json` 按文件声明 |
| 5 | fingerprint 含 `modelAlias` | model 是独立维度；塞进 fp 后「同方法跨模型」永远不命中 |
| 6 | `Accept-Version` / `Content-Version` / `X-Schema-Hash` 自造头 | 自造头对「对方项目」没有约束力；弃用用 RFC 9745/8594，版本用 `X-Mgr-Api` + `/api/capabilities` |
| 7 | Opus 的契约 CI 脚本 | 【实测】字段比较逻辑错（顶层 vs 嵌套/数组），必然全报缺失。用 `consult2-contract-check.mjs`（35 字段，自检 4 项 PASS） |
| 8 | `app.get(...)`（Express 写法） | 本项目零依赖 `node:http`，照抄等于引依赖。缓存思路采纳，API 换成 `http.createServer` 分支 |
| 9 | `document.write` 注入 manifest | 阻塞解析、反模式。服务端渲染带 hash 的 `<script src>` 即可 |
| 10 | 静态资源「内容寻址 + manifest + 每次重下 html」全套 | 对 3 个文件、单机内嵌的场景过重；`ETag + no-cache` 已能把 `ui.js` 从 14.9 KB 降到 304（0 字节） |
| 11 | `seq = max(主,.bak)+1000` 的恢复启发式 | 跳变无意义且 `.bak` 可能更旧。用只增不减的水位文件 |
| 12 | 「>10 个配置文件 / >1 write/s 就迁 etcd/Consul/xDS」 | 与我们规模不匹配（单文件 16.8 KB、人工写、单机）。用「写者数 / 可见性 p99 / 跨机」三条判据，前两条锁+push 即可 |
| 13 | rebuild 的 `apply` 加「冲突检测面板」 | 【实测】它压根不吞 PUT（T11），真实问题是让并发 PUT 收到 409。应该加锁 + 给 409 一个可识别原因，不是做合并 UI |
| 14 | 跨源 iframe 靠 cookie 传状态 | mgr 无 cookie 也无鉴权；靠 cookie 只会引入 SameSite/分区存储的新坑。同源反代是唯一干净解 |
| 15 | 给 `/api/summary` 加 ETag 做轮询 | 它包含 `generatedAt`（每次都变），ETag 永远不会命中；轻量轮询请用 `/api/registry/hash` |
| 16 | 上一轮已否掉的项（`compiledPatterns` 存 JSON、行级悲观锁、206 状态码、Redis 队列、软链） | 不重复讨论；结论不变 |

---

## 8. 来源

**来自 Opus（`claude-opus-5-5`，4 次调用）**：§1 的失效模式排序与业界对照表、ACK/`registry.ack.jsonl` 设计、§2 的三方式矩阵与双层契约思路、§3 的 `configSeq` + `methodFingerprint` 方向与 UI 五字段、§4 的并发写/ABA/缓存/跨源分类。原文：`consult2-q1-cpdp.md`、`consult2-q2-contract.md`、`consult2-q3-evidence.md`、`consult2-q4-pitfalls.md`（文件头带耗时与 token）。

**来自公开资料**（用于佐证或纠正）：

- xDS 的 `version_info` / `response_nonce` / ACK-NACK 语义 — [Envoy `api/xds_protocol.rst`](https://raw.githubusercontent.com/envoyproxy/envoy/bc5c44a1a842379daa6f810dc3841c71a513661b/api/xds_protocol.rst)
- `Deprecation` = RFC 9745、`Sunset` = RFC 8594、`api-supported-versions` / `api-deprecated-versions` — [ASP.NET API Versioning: Version Policies](https://dotnet.github.io/aspnet-api-versioning/aspnet-core/version-policies.html)、[nucleus router APIVersion](https://pkg.go.dev/github.com/jcsvwinston/nucleus@v1.32.0/pkg/router)
- cookie 作用域**不含端口**、`SameSite` 默认 `Lax`、第三方上下文需 `SameSite=None; Secure` — [Chrome cookie 行为说明（IBM 文档转录）](https://www.ibm.com/docs/en/store-engagement?topic=development-cookie-settings-in-browsers-local)、[SameSite=Lax cookie 在跨站 frame 被拒的实际记录](https://github.com/lodyai/lody/blob/7b38c45bd0d015e98e1146637912723ff4dad8c3/.agents/notes/implemented/bug-fix/2026-10-04-local-preview-module-auth.md)
- `fs` 的 `'wx'` = `O_CREAT|O_EXCL|O_WRONLY`（Node 文档语义，本机 P1 已验证行为）

**来自本机实测**（新增脚本，均在 `bench/mgr/` 下，未改动 bench 任何既有文件）：

`consult2-probe.mjs`（T1–T12）、`consult2-probe2.mjs`（P1–P6）、`consult2-gwxprobe.mjs`（G1–G5）、`consult2-mtime.mjs`、`consult2-blind.mjs`、`consult2-contract-check.mjs` + `consult2-summary.contract.json`、`consult2-server-copy.mjs` / `consult2-mkcopy.mjs`（隔离写测试）、`consult2-ask.mjs`（4 次调用参数与耗时）。
