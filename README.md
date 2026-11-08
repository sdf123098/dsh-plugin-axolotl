# dsh-plugin-axolotl

把 [美西螈启动器（Axolotl Launcher）](https://github.com/Axolotl-Launcher) 接进 DSH。

启动器自带一个 MCP 服务器（`127.0.0.1:5219/mcp`，1.11.0-beta.2 起有 269 个工具）。这个插件不是把 269 个工具原样摊平，而是收成 **9 个领域工具 + status + raw**，并且替你处理三件直连会很麻烦的事。

---

## 为什么需要这层

### 1. 会话 30 秒就死

启动器（Rust/rmcp 实现）每 15 秒通过一条独立 SSE 流 ping 一次客户端，10 秒内没应答就杀掉整个 MCP 会话。之后所有调用返回 404，表现为 `Streamable HTTP error: Error POSTing to endpoint`。

插件里代持一个常驻 SDK 客户端，SDK 自动应答 ping；断了自动重连并重试一次。你不需要知道这件事存在。

### 2. `tools/list` 有 195 KB

269 个工具的完整 schema 约 195 KB。全量灌进系统提示，每轮对话都要为它付 token。

插件按工具名前缀分成 9 个领域，每个领域工具的描述里只列 op 名字（总量约 9 KB）。要精确参数就传 `op: "help"` 现查 —— 一次工具调用的代价，远小于 195 KB 常驻上下文。

### 3. 截图只能拿到文件路径

启动器的 `ui_screenshot`、`skin_get_texture`、`screenshot_get` 返回 base64 图片。插件会把它们转成 DSH 的附件引用，**截图直接出现在对话里**，不用落盘再 `read_image` 读一次。

---

## 安装

```bash
dsh plugin install dsh-plugin-axolotl
```

或手动：把包放进 profile 的 `node_modules`，然后在 `cordis.patch.yml` 的 `insert` 列表里加一行：

```yaml
    - id: axolotl
      name: 'dsh-plugin-axolotl'
      config:
        upstreamUrl: 'http://127.0.0.1:5219/mcp'
```

**前提**：

- 启动器必须是 **1.11.0-beta 或更新**。1.10.5 稳定版只有 3 个空壳工具（`get_launcher_info` / `start_session` / `end_session`），什么也做不了。
- 启动器里要打开 MCP：`设置 → MCP 服务器 → 启用`，并允许完全访问（写操作需要）。

---

## 工具

| 工具 | 覆盖上游工具数 | 用途 |
| --- | ---: | --- |
| `axolotl_status` | — | 诊断：版本、连接、控制会话、各领域工具数 |
| `axolotl_instances` | 48 | 实例、安装任务、下载队列、游戏进程 |
| `axolotl_launch` | 18 | 启动、Java、窗口、内存、游戏版本元数据 |
| `axolotl_content` | 26 | 模组 / 资源包 / 光影 / 整合包 |
| `axolotl_files` | 15 | 实例内文件、压缩包、NBT |
| `axolotl_worlds` | 17 | 存档与种子 |
| `axolotl_schematics` | 9 | 投影文件（`.schem`、`.litematic`） |
| `axolotl_servers` | 34 | 专用服务器与联机 |
| `axolotl_ui` | 7 | 启动器界面截图、导航、点击、输入 |
| `axolotl_system` | 91 | 设置、代理、存储、数据库、日志、账号、皮肤、更新 |
| `axolotl_raw` | 269 | 逃生口：按上游原名调任意工具 |

每个领域工具的参数都一样：

```
op          必填。上游工具名，或 "help"
args        该 op 的参数对象。instance_id / session_id 会自动补
instance_id 便捷写法，等价于 args.instance_id
```

**先 `op: "help"` 再调用**。这样只用一次调用就能拿到该领域每个 op 的必填参数和说明，比猜参数便宜得多。

---

## 典型用法

```
axolotl_instances  op: instance_list          → 有哪些实例
axolotl_instances  op: instance_launch  args: { instance_id }  → 启动，返回 operation_id
axolotl_system     op: operations_get   args: { operation_id } → 轮询结果
axolotl_content    op: content_list     args: { instance_id }  → 模组清单
axolotl_ui         op: ui_screenshot                           → 截图直接进对话
```

下载、安装这类操作不阻塞：返回 `operation_id`，用 `axolotl_system` 的 `operations_get` 轮询。

---

## 设置

在 DSH 的插件设置页里改，或直接写 `cordis.patch.yml`。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `upstreamUrl` | `http://127.0.0.1:5219/mcp` | 启动器 MCP 地址 |
| `autoConnect` | `true` | DSH 启动时自动连 |
| `sessionPolicy` | `auto` | `auto` 按需开关 / `persistent` 常驻 / `manual` 不自动开 |
| `sessionIdleMs` | `900000` | 控制会话闲置多久自动关（15 分钟） |
| `sessionRetryMs` | `45000` | 撞上会话被占用时最多重试多久 |
| `exposeRawTool` | `true` | 是否注册 `axolotl_raw` |
| `requireApproval` | `true` | 完全访问权限的写操作是否走 DSH 审批 |
| `toolCallTimeoutMs` | `120000` | 单次上游调用超时 |

---

## 控制会话

启动器同一时刻**只允许一个**控制会话。插件自动开关，你大概不需要关心，但有两个场景值得知道：

**插件会占着启动器的「AI 已连接」**。闲置 15 分钟后自动释放。想立刻释放：设置页里关掉插件，或者点启动器标题栏的「AI 已连接」。

**刚重启 DSH 时头半分钟可能失败**。上一个进程被强杀后，启动器要等心跳超时（约 30 秒）才释放旧会话。这段时间 `start_session` 返回 `Another control session or approval request is active`，插件会重试到 45 秒。如果还是失败，等的就是这个。

---

## 审批

`requireApproval: true` 时，**需要完全访问权限的写操作**（删实例、删存档、改设置、装 Java、改 NBT……共 83 个）会在执行前走 DSH 审批，理由写清后果：

> 永久删除这个实例及其全部存档、快照备份：instance_delete（实例 local:e8fbbe72…）

只读操作不打扰。当前会话审批策略是 `never` 时也直接放行 —— 用户已经明确关掉审批，再问只会被立刻拒绝。

---

## 故障排查

**`axolotl_status` 说 `not connected`**

启动器没开，或者「设置 → MCP 服务器」里的启用开关关掉了。打开后会自己重连，不用重启 DSH。

**`upstream tools: 0`**

连上了但目录是空的。检查启动器版本 —— 1.10.5 稳定版只有 3 个空壳工具，需要 Beta 通道。

**`op "xxx" 不在「…」里`**

op 名打错了。错误信息会列出该领域全部可用 op，并给出最接近的建议。用 `op: "help"` 看完整清单。

**`Missing argument: "xxx"`**

上游的自定义 format 校验很严（`uuid`、`account-id`、`image-filename` 之类）。用 `op: "help"` 看必填参数，按格式给值。

**`game_running`**

游戏正在运行，启动器不允许改这个实例的世界/服务器条目。先关游戏。

---

## 限制

- **不做多启动器**：控制会话全局唯一，多实例没有意义。
- **不改启动器源码**：GPL-3.0，beta 迭代快，跟进成本高于收益。
- **图片依赖 attachments 服务**：没有挂载附件存储的 profile 里，截图会降级为空（工具仍能返回文本）。
- **只读启动器界面结构，不接管它**：`axolotl_ui` 能截图和点击，但真正的界面还是启动器自己的。

---

## 开发

```bash
npm install
npm test              # 单元测试，不需要启动器
AXOLOTL_LIVE=1 npm test   # 加真机集成测试，需要启动器在跑
```

代码结构：

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | 插件入口、生命周期、`/axolotl/api` 路由 |
| `src/upstream.js` | 常驻 MCP 客户端、单飞建连、断线重连 |
| `src/session.js` | 控制会话自动开关、抢占期重试、闲置回收 |
| `src/catalog.js` | 每次连接重拉工具清单与权限表 |
| `src/domains.js` | 269 → 9 的前缀分类、help 渲染、op 纠错 |
| `src/normalize.js` | `structuredContent` 归一、业务错误识别、图片提取 |
| `src/service.js` | 一次调用的完整流程（上面几层的编排） |
| `src/tools.js` | 11 个工具的注册与渲染 |
| `src/approval.js` | `tools/pre-execute` 闸门与审批文案 |
| `src/config.js` | schemastery 配置 schema |

## 许可

MIT

## 认证（连接令牌）

启动器的「设置 → MCP 服务器 → 要求身份验证」打开后，每个 HTTP 请求都要带 `Authorization: Bearer <令牌>`。
插件在设置页里提供了输入框，填一次即可。

**令牌存在哪**：`<DSH_HOME>/data/dsh-plugin-axolotl/config.json`，权限跟着文件系统走。
它不会写进 `cordis.patch.yml` —— 那是部署文件，插件不该覆写用户手写的配置。

**令牌不回显**：设置页只能看到「已配置」和首尾四位（`abcd…wxyz`），改和清各有一个入口。
把原文送到浏览器意味着它会出现在 DOM、devtools 和任何一次抓包里，而用户只需要改和清。

**改了立刻生效**：换令牌会断掉现有连接并在下次调用时用新令牌重连，不用重启 DSH。

**认证失败和启动器没开是两种提示**：

| 情况 | 提示 |
| --- | --- |
| 端口不通 | 连不上美西螈启动器（fetch failed）… 打开启动器后会自己重连 |
| 认证不过 | 启动器拒绝了这次连接（HTTP 401）… 在插件设置里填入连接令牌 |

启动器把这两件事都表现成「握手失败」，但它们的处置完全不同，所以插件分开判断
（`isUnauthorized` 认 401/403，`isUnreachable` 认连接层错误，前者优先）。

### 认证失败的两种提示

启动器把「端口不通」和「身份不对」都表现成握手失败，插件分开判断：

| 情况 | 判定依据 | 提示 |
| --- | --- | --- |
| 端口不通 | `fetch failed` / `ECONNREFUSED` | 连不上美西螈启动器…打开启动器后会自己重连 |
| 令牌不对 | **`error.code === 401`** | 启动器拒绝了这次连接（HTTP 401）：令牌不对或已失效… |
| 没带令牌 | 同上，且当前没配令牌 | 启动器拒绝了这次连接（HTTP 401）：没有带令牌… |

有一个坑值得记下来：SDK 抛的 401 错误**消息体是空的** ——
`"Streamable HTTP error: Error POSTing to endpoint: "`，状态码只在 `error.code` 上。
第一版代码只扫消息文本，扫不到 401，于是认证失败被 `isSessionGone` 的正则
（匹配 `Error POSTing to endpoint`）当成会话过期，去重连重试，最后把一句空消息丢给用户。
现在 `statusOf()` 优先读 `error.code`，`isSessionGone` 显式排除 401/403。
