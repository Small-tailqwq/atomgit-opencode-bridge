# AtomCode CodingPlan → OpenCode Bridge

将 AtomCode CodingPlan 订阅的模型接入任意 OpenAI 兼容客户端。

Bridge AtomCode CodingPlan models to any OpenAI-compatible client.

> **⚠️ 安全警告 / Security Warning**
>
> **本项目仅适合在可信网络环境下使用。** 请仔细评估以下安全局限性：
>
> 1. **本地通信未加密** — 代理模式下客户端与代理之间的流量是明文的 HTTP（非 HTTPS），localhost 上的其他进程可以嗅探请求内容
> 2. **凭据明文存储** — `~/.atomcode/auth.toml` 以明文保存 access_token 和 refresh_token，任何能读取该文件的进程均可盗用
> 3. **默认无访问认证** — 除非设置 `LOCAL_API_KEY`，任何能访问 `127.0.0.1:9457` 的本地进程均可自由使用代理
> 4. **旁路官方安全模型** — 本项目绕过了 AtomCode 官方的客户端绑定和 UA 校验，本质上属于逆向工程产物
> 5. **无审计日志** — 代理不记录请求来源、频率和内容，发生滥用时无法追溯
>
> **免责声明 / Disclaimer**：本项目仅供学习和研究目的，不隶属于 AtomCode/AtomGit，也不为其官方认可。使用者需自行承担风险，并确保遵守 AtomCode 的《服务条款》。作者不对因使用本项目导致的任何账号封禁、数据泄露或其它损失承担责任。
>
> **AI 生成说明**：本项目 100% 由 AI 编写（AtomCode / OpenCode），人类仅提出需求和进行审核。

## 原理 / How It Works

AtomCode 的 CodingPlan 订阅让你能使用底层模型，但被限制在官方客户端内。
分析发现网关只校验两样东西：

1. **`Authorization: Bearer <access_token>`** — 来自 OAuth 登录
2. **`User-Agent: atomcode/...`** — 必须以 `atomcode/` 开头

本项目提供两种部署模式，最终数据流一致：

```
                        ┌─────────────────────────────────────┐
                        │  ~/.atomcode/auth.toml              │
                        │  (auto-refresh on expiry)           │
                        └──────┬──────────────────────────────┘
                               │reads
                               ▼
┌──────────────┐   OpenAI API  ┌──────────────┐  Bearer Token  ┌──────────────────┐
│  Client      │ ────────────► │  Local Proxy │ + User-Agent   │ llm-api.atomgit  │
│ (any client) │ ◄──────────── │  :9457       │ ─────────────► │ .com/v1          │
└──────────────┘               └──────────────┘ ◄──────────────│                  │
                                   │     ↑                     └──────────────────┘
                       插件模式     │     │ 独立代理模式
                      OpenCode自动 │     │ node proxy.js
                      启动内嵌proxy┘      │
                                   ┌─────┴──────┐
                                   │ 任意客户端   │
                                   │ (Cline/    │
                                   │ SillyTavern│
                                   │ /Continue) │
                                   └────────────┘
```

**两种模式都运行同一个本地代理**，差异仅在于启动方式：插件模式由 OpenCode 自动在进程内启动，独立代理模式需要手动运行 `node proxy.js`。

## 前置条件 / Prerequisites

- **AtomCode 已安装**并完成 `atomcode codingplan`（订阅激活）
- **Node.js 18+**（自带模块，无需额外依赖）
- 确认身份文件存在：`cat ~/.atomcode/auth.toml`（没有则先 `atomcode login`）

> **跨设备使用**：认证信息全部储存在 `~/.atomcode/auth.toml`，没有设备绑定。
> 将该文件复制到其他设备的相同路径即可直接使用代理。
> Token 自动续命（用 `refresh_token` 刷新）在任何设备上都能正常工作。
>
> **WSL + Windows 双端共享**：推荐用 symlink 将 WSL 的 `auth.toml` 指向 Windows 文件，
> 这样任一端刷新 token 后自动同步。详见 [AGENTS.md](./AGENTS.md) 的「多机共享」章节。

## 部署方式一：插件模式（OpenCode 内嵌代理） / Plugin Mode

**OpenCode 启动时自动加载插件，插件在进程内启动本地代理（`:9457`）**。
无需常驻进程，零额外操作。

### 安装步骤

```bash
# 1. 安装插件文件
cp plugin/index.js ~/.config/opencode/plugins/atomcode-auth.js

# 2. 将 opencode-config.json 的内容合并到 ~/.config/opencode/opencode.json
#    需要在 provider 块添加 atomgit，并在 plugin 数组添加引用
```

`~/.config/opencode/opencode.json` 需包含以下结构：

```json
{
  "plugin": [
    "~/.config/opencode/plugins/atomcode-auth.js"
  ],
  "provider": {
    "atomgit": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AtomGit (via AtomCode)",
      "options": {
        "baseURL": "http://127.0.0.1:9457/v1",
        "apiKey": "dummy"
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "options": { "reasoningEffort": "high" },
          "variants": {
            "none": {},
            "low": { "reasoningEffort": "low" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "GLM-5.1": { "name": "GLM-5.1" },
        "Qwen/Qwen3.6-35B-A3B": { "name": "Qwen3.6-35B-A3B" },
        "Qwen/Qwen3-VL-8B-Instruct": { "name": "Qwen3-VL-8B (Vision)" }
      }
    }
  }
}
```

重启 OpenCode，在模型列表中选择 `AtomGit` 下的模型即可。

### 工作原理

- `atomcode-auth.js` 插件作为 OpenCode 的全局插件被加载
- 插件在 `127.0.0.1:9457` 启动本地 HTTP 代理（端口被占用则复用已有实例）
- OpenCode 的 `baseURL` 指向该本地代理，所有请求经过代理转发到上游
- 代理自动注入 `Authorization`、`User-Agent`、`Accept` 等精确的请求头，模拟真实 atomcode 客户端
- 支持 `X-API-Key` 认证（设置 `LOCAL_API_KEY` 环境变量后启用）

### （可选）TUI 用量面板

在 `~/.config/opencode/tui.jsonc` 的 `plugin` 数组中加入 TUI 插件路径，即可在 OpenCode 侧边栏实时查看 CodingPlan 用量：

```json
{
  "plugin": [
    "/home/你的用户名/code/atomgit-opencode-bridge/plugin/tui-usage.tsx"
  ]
}
```

面板每 30 秒自动刷新，显示 token 使用量、重置时间等。

## 部署方式二：代理模式（对接任意客户端） / Proxy Mode

**适用场景**：SillyTavern（酒馆）、Cline、Continue、LobeChat、ChatGPT-Next-Web 等非 OpenCode 客户端。

### 启动代理

```bash
# 前台启动
node proxy.js

# 或后台启动（自动绕过系统代理）
./bin/atomgit-proxy start

# 管理命令
./bin/atomgit-proxy stop
./bin/atomgit-proxy status
```

成功输出：

```
┌────────────────────────────────────────────┐
│  atomgit-opencode-bridge                   │
│  Listening on http://127.0.0.1:9457        │
│  Auth token: ✓ loaded                      │
│  Upstream:  llm-api.atomgit.com            │
│  Models:                                   │
│    - deepseek-v4-flash                     │
│    - GLM-5.1                               │
│    - Qwen/Qwen3.6-35B-A3B                  │
│    - Qwen/Qwen3-VL-8B-Instruct             │
└────────────────────────────────────────────┘
```

验证代理工作：

```bash
curl http://127.0.0.1:9457/v1/models
```

### 在 OpenCode 中使用代理

将 `baseURL` 指向本地代理（配置示例与插件模式相同，见上方）：

```json
{
  "provider": {
    "atomgit": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AtomGit (via Proxy)",
      "options": {
        "baseURL": "http://127.0.0.1:9457/v1"
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "options": { "reasoningEffort": "high" },
          "variants": {
            "none": {},
            "low": { "reasoningEffort": "low" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "GLM-5.1": { "name": "GLM-5.1" },
        "Qwen/Qwen3.6-35B-A3B": { "name": "Qwen3.6-35B-A3B" },
        "Qwen/Qwen3-VL-8B-Instruct": { "name": "Qwen3-VL-8B (Vision)" }
      }
    }
  }
}
```

### 对接其他客户端

| 客户端 | 配置方式 |
|--------|---------|
| **SillyTavern（酒馆）** | API 类型选「OpenAI」→ API URL 填 `http://127.0.0.1:9457/v1` → API Key 随便填 |
| **Cline** | 添加 OpenAI 兼容 provider，`baseUrl` 设为 `http://127.0.0.1:9457/v1`，`apiKey` 随便填 |
| **Continue** | 在 `config.json` 添加 `{"type": "openai", "apiBase": "http://127.0.0.1:9457/v1", "model": "deepseek-v4-flash"}` |
| **ChatGPT-Next-Web** | 自定义接口设为 `http://127.0.0.1:9457/v1/chat/completions` |
| **LobeChat** | 添加自定义 OpenAI 兼容 provider，baseURL `http://127.0.0.1:9457/v1` |

## Token 自动续命 (Auto-Refresh)

所有部署模式均内置自动续命：

1. 每次请求前检查 `~/.atomcode/auth.toml` 中的 `created_at + expires_in`
2. 离过期不到 5 分钟时，自动调用 `POST https://acs.atomgit.com/oauth/refresh`
3. 获取新 token 后写入 `auth.toml`
4. 刷新异步且去重，高并发下只触发一次刷新请求

只需确保 `auth.toml` 中有 `refresh_token` 字段（`atomcode login` 会自动保存）。

## 用量监控 / Usage Monitor

代理和插件都提供 CodingPlan 用量查询功能。

### 通过代理查询（任意客户端可用）

```bash
curl http://127.0.0.1:9457/v1/usage
```

返回示例：
```json
{
  "current_usage": {
    "window_token_limit": 2000000,
    "window_tokens_used": 384210,
    "usage_percent": 19.2,
    "window_hours": 720,
    "reset_at_display": "2026-05-28 18:53:03",
    "seconds_until_reset": 281643,
    "usage_status_desc": "Normal"
  },
  "window_quota_exhausted": false
}
```

### CLI 工具

零依赖 Node.js 脚本，直接查询上游 API：

```bash
node bin/atomgit-usage
```

### TUI 用量面板（OpenCode 侧边栏）

在 `~/.config/opencode/tui.jsonc` 的 `plugin` 数组中添加：

```json
"/home/你的用户名/code/atomgit-opencode-bridge/plugin/tui-usage.tsx"
```

面板每 30 秒自动轮询，以进度条和百分比显示 token 使用量。

## Reasoning Effort / Thinking 注入

deepseek-v4-flash 支持 `reasoning_effort` 参数和 `thinking` 模式。

- 代理和插件**自动注入** `reasoning_effort: "high"` + `thinking: { type: "enabled" }`
- 可通过 `X-Reasoning-Effort` 请求头覆盖（`none` / `low` / `high` / `max`）
- 在 OpenCode 中通过 variants 切换不同力度（见上方配置示例）
- 非 reasoning 模型（GLM-5.1、Qwen 系列）不受影响

## 故障排查 / Troubleshooting

### 端口占用 / EADDRINUSE

代理启动时如果 `9457` 端口已被占用，会自动复用已有实例（不会报错退出）。

### 代理日志位置

```bash
# 独立代理模式的日志
cat bin/logs/atomgit-bridge.log
```

### Bad Gateway / 502

**原因**：系统代理（Clash/V2Ray）拦截了本地请求。

**修复**：

```bash
# 方式 1：启动前清除代理环境变量
http_proxy="" https_proxy="" node proxy.js

# 方式 2：设置 NO_PROXY（适用于插件模式或 OpenCode 直连）
export NO_PROXY="localhost,127.0.0.1,::1"
```

### Token 过期 / 401

`access_token` 约 7 天过期。代理会自动刷新。如果 `refresh_token` 也失效了：

```bash
atomcode codingplan
```

### 403 ATOMCODE_UA_REQUIRED

`User-Agent` 没有以 `atomcode/` 开头。插件和代理已自动处理，一般不会出现。

### 模型列表不对

运行以下命令获取最新列表：

```bash
curl -s -H "Authorization: Bearer $(grep access_token ~/.atomcode/auth.toml | cut -d'"' -f2)" \
  "https://api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max" | python3 -m json.tool
```

然后更新 `proxy.js` 和 `plugin/index.js` 中的 `KNOWN_MODELS` 数组。

## 技术细节 / Technical Details

- [atomcode-integration-notes.md](./docs/atomcode-integration-notes.md) — 完整逆向分析
- **为什么不需要签名？** AtomCode 官方实现了 HMAC-SHA256 签名算法，但网关不强制校验，只检查 `User-Agent` 前缀。

## 项目结构

```
atomgit-opencode-bridge/
├── proxy.js                 # 独立代理服务器（CJS，零依赖）
├── bin/
│   ├── atomgit-proxy        # 代理管理脚本（start/stop/status）
│   └── atomgit-usage        # CLI 用量查询（零依赖 Node.js）
├── plugin/
│   ├── index.js             # OpenCode 插件（ESM，内嵌代理）
│   └── tui-usage.tsx        # TUI 用量面板（SolidJS）
├── opencode-config.json     # 插件模式的 OpenCode 配置片段
├── test-reasoning-effort.sh # Reasoning effort 功能测试脚本
├── AGENTS.md                # OpenCode 代理开发指南
├── INSTALL.md               # 完整安装手册（另见）
├── docs/
│   └── atomcode-integration-notes.md  # 逆向分析文档
└── package.json
```

## License

MIT
