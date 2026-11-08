# Changelog

## 0.2.1

### 修正：认证失败被误判成「会话过期」

启动器开了「要求身份验证」而令牌不对时，SDK 抛的错是这样的：

```js
Error: "Streamable HTTP error: Error POSTing to endpoint: "   // 消息里什么都没有
  code: 401                                                    // 状态码在这里
```

原来的 `isUnauthorized` 只扫消息文本，扫不到 401；而 `isSessionGone` 的正则
匹配 `Error POSTing to endpoint`，于是认证失败被当成会话过期，去重连、重试，
最后把一句空的 `Streamable HTTP error:` 丢给用户。

现在 `statusOf()` 优先从 `error.code` / `error.status` / `error.cause.status` 取状态码，
`isUnauthorized` 认 401/403，`isSessionGone` 显式排除它们。提示也改成可照做的两步：

```
启动器拒绝了这次连接（HTTP 401）：令牌不对或已失效。
启动器开着「要求身份验证」，需要填写连接令牌：
启动器 → 设置 → MCP 服务器 → 要求身份验证，旁边的令牌就是。
在插件设置里填好，点「测试连接」，不用重启 DSH。
```

（没带令牌时第一句换成「没有带令牌」。）

### 修正：装配测试会连到真实启动器

`wiring.test.js` 原来的默认地址是 5219，跑测试时会连上用户正在用的启动器、
占住控制会话，并且 SDK 的 SSE 流让测试进程永远不退出。现在统一指向 59999，
并把 `DSH_HOME` 指到临时目录（避免读写真实配置里的令牌）。

## 0.2.0

### 新增：连接令牌

启动器的「要求身份验证」打开后，插件会以 `Authorization: Bearer` 头随每个请求带上令牌。

- 设置页有密码输入框，值不会回显（只显示「已配置」与首尾四位）
- 令牌存 `<DSH_HOME>/data/dsh-plugin-axolotl/config.json`，不写进 `cordis.patch.yml`
- 换令牌立刻重连，不用重启 DSH
- **认证失败与「启动器没开」分开提示**：前者引导去填令牌，后者引导去开启动器

### 新增：设置页（客户端半边）

- `lib/client.js`，声明 `dsh.client.platform: web`，挂在「插件」管理器里本插件的配置卡片上
- 连接状态灯（绿/红）、启动器版本、上游工具数、控制会话
- 上游地址、连接令牌、会话策略、闲置超时、重试时长、调用超时
- 「测试连接」用**当前填的值**握一次手，不复用现有连接 —— 用户点它就是要验这组新参数
- 「保存」写入配置文件并即时应用到运行中的组件（地址/令牌会触发重连）

### 新增：配置持久化

三层合并：内置默认 ← `cordis.patch.yml` 的部署配置 ← 设置页的用户覆盖。
用户改的活过重启，部署方的基线不被插件覆写。

### 修正

- 设置页里的 CSRF 标记头（`x-dsh-axolotl`）：跨源表单提交带不了自定义头，等同挡住跨站写请求
- 会话巡检定时器加了 `unref()`：没有它，用假 ctx 跑 `apply()` 的测试会永远挂住不退

## 0.1.0

首个版本。把「美西螈启动器」的 MCP 接口接进 DSH。

### 工具

- 9 个领域工具（instances / launch / content / files / worlds / schematics / servers / ui / system），
  按上游工具名前缀自动分类，新增的上游工具自动归位，认不出来的落到 `system`。
- `axolotl_status`：诊断用，不需要授权。
- `axolotl_raw`：逃生口，可按上游原名调任意工具。

### 解决的三件事

- **会话寿命**：启动器每 15 秒 ping 一次、10 秒超时杀会话。插件代持常驻 SDK 客户端自动应答，
  断了自动重连并重试一次。
- **上下文成本**：269 个工具的完整 schema 约 195 KB；领域收窄后约 9 KB。
- **图片直出**：截图转成 DSH 附件引用直接进对话，不再需要落盘 + `read_image`。

### 其它

- 控制会话自动开关，撞上「另一个会话占用」时重试到 45 秒（盖过启动器约 30 秒的心跳超时）。
- 上游那些返回数组型 `structuredContent` 的工具（`process_list`、`operations_list`…）
  会被包成 `{items: [...]}`，数据不丢。
- 上游的业务错误（`structuredContent.error`，`isError` 为 false）被识别为失败，
  模型不会误以为成功。
- 需要完全访问权限的写操作走 DSH 审批，理由写清后果。
- 启动器没开时降级为 `status` + `raw` 两个工具，并给出可读的中文原因。
