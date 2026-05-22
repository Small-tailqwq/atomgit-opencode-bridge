# AtomCode CodingPlan → OpenCode 逆向集成笔记

## 背景

AtomCode 是一个 Rust 编写的 AI 编程助手，提供 "CodingPlan" 订阅服务。用户付费用其底层模型
（deepseek-v4-flash, GLM-5.1, Qwen 等），但这些模型被限制在 AtomCode 客户端内使用。
本文记录了如何绕过限制，在任意 OpenAI 兼容客户端（如 OpenCode）中使用订阅的模型。

## 认证流程

### 1. OAuth 登录

```
┌─────────┐     GET /auth/login?provider=atomgit     ┌──────────────┐
│ Client  │ ────────────────────────────────────────► │ acs.atomgit.com│
│         │ ◄──── { login_url, state } ───────────── │              │
│         │                                           │              │
│         │  打开浏览器 → 用户登录 AtomGit             │              │
│         │                                           │              │
│         │     GET /auth/check?state=... (轮询 ~2s)  │              │
│         │ ────────────────────────────────────────► │              │
│         │ ◄────────── { valid: true } ───────────── │              │
│         │                                           │              │
│         │     GET /auth/token?state=...              │              │
│         │ ────────────────────────────────────────► │              │
│         │ ◄── { access_token, refresh_token, ... } ──│              │
└─────────┘                                           └──────────────┘
```

Token 存储在 `~/.atomcode/auth.toml`：
```toml
access_token = "AfBx..."
refresh_token = "fd5f..."
token_type = "Bearer"
expires_in = 604400        # ~7 天
created_at = 1779445711

[user]
id = "6a10..."
username = "Small-tailqwq"
```

### 2. Token 刷新

`expires_in - 300` 秒前自动刷新：`POST /oauth/refresh { refresh_token }` 到 `acs.atomgit.com`。

## 模型 API 调用

### 端点

`https://llm-api.atomgit.com/v1/chat/completions` — 完全 OpenAI 兼容。

### 鉴权方式（重要）

**只需要两个头：**

```http
Authorization: Bearer <access_token>
User-Agent: atomcode/<任意版本号>
```

`User-Agent` 必须**以 `atomcode/` 开头**，版本号不限（`atomcode/0.0.0` 也可以）。
没有这个头会返回 `403 ATOMCODE_UA_REQUIRED`。

### 🚫 不需要的签名（踩坑记录）

AtomCode 的闭源代码实现了 HMAC-SHA256 签名算法，生成 5 个 `X-AtomCode-*` 请求头：
- `X-AtomCode-Sig: v1:<64-char-hex>`
- `X-AtomCode-Ts: <unix-timestamp>`
- `X-AtomCode-Nonce: <32-char-hex>`
- `X-AtomCode-Alg: 1`
- `X-AtomCode-Ver: 4.23.0`

**但实际测试发现网关不强制校验这些签名头！** 只检查 `User-Agent` 前缀。
这省下了大量逆向闭源签名算法的工作量。

签名算法结构（供参考）：
```
body_hash = SHA256(body)
signing_key = HKDF-SHA256(master_key, salt={user_id, oauth_token, time_bucket, client_version})
sig = HMAC-SHA256(signing_key, canonical_msg)
```

其中 `master_key` 在闭源 `atomcode-codingplan-crypto` crate 中，
存放在官方二进制偏移 `0x8b8d0` 附近（32 字节），但可能经过编译时 XOR 混淆（Level 2 protection）。
`canonical_msg` 格式和 HKDF salt 精确构造均未公开。

## 模型列表

从 `https://api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max` 获取：

| 模型名称 | 上下文 | 类型 |
|---|---|---|
| `deepseek-v4-flash` | 128K | OpenAI |
| `GLM-5.1` | 64K | OpenAI |
| `Qwen/Qwen3.6-35B-A3B` | 64K | OpenAI |
| `Qwen/Qwen3-VL-8B-Instruct` | 64K | OpenAI (Vision) |

所有模型使用 `https://llm-api.atomgit.com/v1` 作为 base_url。

## OpenCode 集成方案

### 架构

```
┌──────────┐   OpenAI-compatible    ┌──────────────┐   Bearer + UA    ┌──────────────────┐
│ OpenCode │ ──── POST /v1/chat ──► │ atomgit-proxy│ ───────────────► │ llm-api.atomgit  │
│          │ ◄──── SSE stream ───── │ (:9457)      │ ◄─────────────── │ .com/v1          │
└──────────┘                        └──────────────┘                  └──────────────────┘
                                            │
                                    读取 auth.toml
                                    注入 Bearer Token
                                    注入 User-Agent
```

### 代理文件

`~/.config/opencode/atomgit-proxy.js` — 轻量 Node.js HTTP 代理，约 80 行。

### 启动脚本

`~/.local/bin/atomgit-proxy` — 管理脚本：

```bash
atomgit-proxy start     # 启动
atomgit-proxy stop      # 停止
atomgit-proxy status    # 状态
```

### OpenCode 配置

`~/.config/opencode/opencode.json` 中添加 provider：

```json
{
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
```

### 坑：http_proxy 环境变量

WSL/Linux 如果设置了系统代理（Clash/V2Ray 等），opencode 的 AI SDK 内部使用
Node.js `fetch()`，会**通过系统代理转发所有请求**。代理服务器找不到本地的
atomgit-proxy，返回 Bad Gateway。

**修复**：设置 `NO_PROXY`：

```bash
export NO_PROXY="localhost,127.0.0.1,::1"
```

或者加入 `~/.bashrc` 让新终端自动生效。

### Token 过期处理

`expires_in` 约 7 天。到期后代理读取 `auth.toml` 会拿到过期 token。
AtomGit 网关返回 401。解决：

```bash
atomcode codingplan    # 重新登录 + 刷新 token
```

（或手动 `atomcode login`）

## 附录：逆向工具链

- **源码分析**：atomcode 开源部分在 `crates/atomcode-core/`
- **闭源部分**：`crates/atomcode-codingplan-crypto/` 是存根，实际实现在官方构建中
- **二进制分析**：提取 master key 需从 `~/.local/bin/atomcode` 偏移 `0x8b8d0` 处读取 32 字节
- **密钥混淆**：注释称 "Level 2 protection"（编译时 XOR 混淆），裸字节可能不是原始密钥
- **MITM 建议**：若需完全破解签名算法，用 mitmproxy 捕获 atomcode 发出的真实请求，
  比对 body + 签名头反推 HMAC canonical message 格式
