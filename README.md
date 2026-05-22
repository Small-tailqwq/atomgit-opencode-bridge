# AtomCode CodingPlan → OpenCode Bridge

将 AtomCode CodingPlan 订阅的模型接入任意 OpenAI 兼容客户端（OpenCode, Cline, Continue 等）。

Bridge AtomCode CodingPlan models to any OpenAI-compatible client.

## 原理 / How It Works

```
┌──────────┐   OpenAI-compatible    ┌──────────────┐   Bearer Token    ┌──────────────────┐
│  Client  │ ─── POST /v1/chat ──► │  proxy.js    │  + User-Agent    │ llm-api.atomgit  │
│(OpenCode)│ ◄──── SSE stream ──── │  (:9457)     │ ◄─────────────── │ .com/v1          │
└──────────┘                        └──────────────┘                  └──────────────────┘
                                            │
                                    读取 ~/.atomcode/auth.toml
                                    注入 Authorization + User-Agent
```

AtomCode 的 CodingPlan 订阅让你能使用底层模型，但被限制在官方客户端内。
分析发现网关只校验两样东西：

1. **`Authorization: Bearer <access_token>`** — 来自 OAuth 登录
2. **`User-Agent: atomcode/...`** — 必须以 `atomcode/` 开头

这 2 个条件即可调用任意模型，不需要闭源的 HMAC 签名头。

## 前置条件 / Prerequisites

- **AtomCode 已安装**并完成 `atomcode codingplan`（订阅激活）
- **Node.js 18+**（自带 `https` 和 `http` 模块，无需额外依赖）
- **一个 OpenAI 兼容客户端**（OpenCode, Cline, Continue 等）

## 快速开始 / Quick Start

### 1. 提取身份信息

CodingPlan 的 OAuth token 存储在：

```bash
cat ~/.atomcode/auth.toml
```

输出类似：
```toml
access_token = "AfBx..."
refresh_token = "fd5f..."
token_type = "Bearer"
expires_in = 604400
created_at = 1779445711

[user]
id = "6a10..."
username = "你的用户名"
```

> ⚠️ **`access_token` 就是你的 API Key，约 7 天过期**。
> 过期后重新运行 `atomcode codingplan` 刷新。

如果没有这个文件，先登录：

```bash
atomcode login
# 或
atomcode codingplan
```

### 2. 启动代理

```bash
# 从本项目目录启动
node proxy.js

# 或用管理脚本（后台运行）
./bin/atomgit-proxy start
```

看到以下输出即为成功：
```
┌────────────────────────────────────────────┐
│  atomgit-opencode-bridge                    │
│  Listening on http://127.0.0.1:9457         │
│  Auth token: ✓ loaded                       │
│  Upstream:  llm-api.atomgit.com             │
│  Models:                                     │
│    - deepseek-v4-flash                      │
│    - GLM-5.1                                │
│    - Qwen/Qwen3.6-35B-A3B                   │
│    - Qwen/Qwen3-VL-8B-Instruct              │
└────────────────────────────────────────────┘
```

验证代理工作：

```bash
curl http://127.0.0.1:9457/v1/models
```

### 3. 接入 OpenCode

将 `opencode-config.json` 中的 provider 配置合并到你的 `~/.config/opencode/opencode.json`：

```json
{
  "provider": {
    "atomgit": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AtomGit (via AtomCode)",
      "options": {
        "baseURL": "http://127.0.0.1:9457/v1"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" },
        "GLM-5.1": { "name": "GLM-5.1" },
        "Qwen/Qwen3.6-35B-A3B": { "name": "Qwen3.6-35B-A3B" },
        "Qwen/Qwen3-VL-8B-Instruct": { "name": "Qwen3-VL-8B (Vision)" }
      }
    }
  }
}
```

重启 OpenCode，在模型列表中选择 `AtomGit` 下的模型即可。

### 4. 接入其他客户端

| 客户端 | 配置方式 |
|--------|---------|
| **Cline** | 添加 OpenAI 兼容 provider，`baseUrl` 设为 `http://127.0.0.1:9457/v1`，`apiKey` 随便填 |
| **Continue** | 在 `config.json` 添加 `{"type": "openai", "apiBase": "http://127.0.0.1:9457/v1", "model": "deepseek-v4-flash"}` |
| **ChatGPT-Next-Web** | 自定义接口设为 `http://127.0.0.1:9457/v1/chat/completions` |
| **LobeChat** | 添加自定义 OpenAI 兼容 provider |

## 常见问题 / Troubleshooting

### Bad Gateway / 502

**原因**：系统代理（Clash/V2Ray）拦截了本地请求。

**修复**：

```bash
# 方式 1：在启动 opencode 的终端设置
export NO_PROXY="localhost,127.0.0.1,::1"

# 方式 2：永久写入 ~/.bashrc
echo 'export NO_PROXY="localhost,127.0.0.1,::1"' >> ~/.bashrc
```

或者启动代理时自动绕过系统代理（已内置在 `bin/atomgit-proxy` 中）：

```bash
http_proxy="" https_proxy="" node proxy.js
```

### Token 过期 / 401

`access_token` 约 7 天过期。刷新：

```bash
atomcode codingplan        # 刷新 token 和模型列表
# 或
atomcode login             # 仅刷新登录
```

### 403 ATOMCODE_UA_REQUIRED

说明 `User-Agent` 没有以 `atomcode/` 开头。代理已自动处理，一般不会出现。
如果手动调用 API，记得加头：

```bash
-H "User-Agent: atomcode/4.23.0"
```

### 模型列表不对

运行以下命令获取最新列表：

```bash
curl -s -H "Authorization: Bearer $(grep access_token ~/.atomcode/auth.toml | cut -d'"' -f2)" \
  "https://api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max" | python3 -m json.tool
```

然后更新 `proxy.js` 中的 `KNOWN_MODELS` 数组。

## 技术细节 / Technical Details

### 逆向过程

完整逆向流程见 [atomcode-integration-notes.md](./docs/atomcode-integration-notes.md)。

### 为什么不需要签名？

AtomCode 的官方客户端实现了 HMAC-SHA256 签名算法，生成 5 个 `X-AtomCode-*` 请求头。
实际测试发现 **网关不强制校验这些签名头**，只检查 `User-Agent` 前缀。
详见仓库内分析文档。

### 项目结构

```
atomgit-opencode-bridge/
├── proxy.js              # 核心代理服务器
├── bin/atomgit-proxy     # 启动/停止管理脚本
├── opencode-config.json  # OpenCode 配置片段
├── package.json          # npm 元数据
└── README.md             # 本文件
```

## License

MIT
