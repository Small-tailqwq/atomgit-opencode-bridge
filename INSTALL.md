# AtomGit OpenCode Bridge — 安装手册

> **使用对象**：需要在用户环境部署 AtomCode 模型接入的 OpenCode 代理（agent）。
> 本文档供 agent 读取后按步骤操作，也适合用户手动跟随。

---

## 1. 前置检查

在执行任何安装步骤之前，确认以下条件：

```bash
# 1. Node.js 18+
node --version

# 2. AtomCode 是否已安装
which atomcode
atomcode --version

# 3. 订阅是否激活
cat ~/.atomcode/auth.toml
```

**如果缺少 `auth.toml`**：

```bash
atomcode login
# 或
atomcode codingplan
```

> `auth.toml` 中必须包含 `access_token` 和 `refresh_token`。`refresh_token` 用于自动续命，缺少会导致 token 过期后无法自动刷新。

---

## 2. 安装方式选择

| 场景 | 推荐方式 | 说明 |
|------|---------|------|
| **仅对接 OpenCode** | 插件模式 | 零常驻进程，OpenCode 启动时自动加载 |
| **对接其他客户端（酒馆/Cline 等）** | 代理模式 | 需要保持 `node proxy.js` 运行 |

---

## 3. 插件模式安装（推荐，仅 OpenCode）

### 3.1 复制插件文件

```bash
cp plugin/index.js ~/.config/opencode/plugins/atomcode-auth.js
```

### 3.2 配置 OpenCode

将 `opencode-config.json` 的内容合并到 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "~/.config/opencode/plugins/atomcode-auth.js"
  ],
  "provider": {
    "atomgit": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AtomGit (via AtomCode)",
      "options": {
        "baseURL": "https://llm-api.atomgit.com/v1",
        "apiKey": "dummy"
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

> **注意**：合并时保留用户原有的 `provider`、`plugin`、`mcp` 等配置，不要覆盖。

### 3.3 重启 OpenCode

退出 OpenCode 后重新启动，在模型列表中选择 `AtomGit` 下的模型即可。

### 3.4 验证

在对话中测试任意消息，观察是否正常响应。如果看到 `401` 或 `403`，跳到下文的故障排查。

---

## 4. 代理模式安装（对接任意客户端）

### 4.1 启动代理

```bash
# 方式 A：后台运行（推荐）
./bin/atomgit-proxy start

# 方式 B：前台调试
node proxy.js
```

### 4.2 验证代理

```bash
curl http://127.0.0.1:9457/v1/models
```

应返回包含 4 个模型的 JSON 列表。

### 4.3 配置客户端

#### SillyTavern（酒馆）
- API 类型：OpenAI
- API URL：`http://127.0.0.1:9457/v1`
- API Key：任意字符串
- 模型：`deepseek-v4-flash`（或列表中的任意 ID）

#### Cline
- Provider 类型：OpenAI Compatible
- Base URL：`http://127.0.0.1:9457/v1`
- API Key：随意填写

#### 对接 OpenCode
在 `~/.config/opencode/opencode.json` 中配置 provider，`baseURL` 指向 `http://127.0.0.1:9457/v1`，**不需要 plugin**。

---

## 5. 故障排查

### 5.1 代理无法启动

```
Error: listen EADDRINUSE :::9457
```

端口 9457 已被占用，说明代理已在运行或端口被其他程序占用：

```bash
lsof -ti:9457
# 如需强制释放：
kill -9 $(lsof -ti:9457)
```

### 5.2 请求返回 502 Bad Gateway

**原因**：系统代理（Clash/V2Ray 等）拦截了本地到 `llm-api.atomgit.com` 的请求。

**解决**：

```bash
# 代理模式：启动时清除代理环境变量
http_proxy="" https_proxy="" node proxy.js

# bin/atomgit-proxy 已内置此逻辑，用 start 命令会自动处理

# 插件模式（对接 OpenCode）：在终端设置
export NO_PROXY="localhost,127.0.0.1,::1"
```

### 5.3 请求返回 401 Unauthorized

**原因**：token 过期且自动刷新失败。

**排查步骤**：

```bash
# 1. 检查 auth.toml 是否存在
cat ~/.atomcode/auth.toml

# 2. 检查是否有 refresh_token 字段（用于自动刷新）
# 如果缺少 refresh_token：
atomcode codingplan

# 3. 手动测试刷新
# 用 curl 模拟刷新请求（将 <refresh_token> 替换为实际值）：
curl -s -X POST https://acs.atomgit.com/oauth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}'
```

### 5.4 请求返回 403 ATOMCODE_UA_REQUIRED

**原因**：请求未携带 `User-Agent: atomcode/...` 头。

插件和代理已自动注入，一般不会出现。如果手动用 `curl` 测试：

```bash
curl -H "User-Agent: atomcode/4.23.0" \
  -H "Authorization: Bearer $(grep access_token ~/.atomcode/auth.toml | cut -d'"' -f2)" \
  https://llm-api.atomgit.com/v1/models
```

### 5.5 OpenCode 加载插件后无效

**排查步骤**：

```bash
# 1. 确认插件文件存在
ls -la ~/.config/opencode/plugins/atomcode-auth.js

# 2. 确认 opencode.json 中的 plugin 路径正确
# 路径必须与文件实际位置一致

# 3. 确认 provider 配置正确
# opencode.json 需要有 provider.atomgit 块

# 4. 检查 opencode 启动日志是否有报错
# 插件错误会输出到 opencode 的控制台
```

### 5.6 模型列表为空或不完整

模型硬编码在 `KNOWN_MODELS` 数组中（`proxy.js` 和 `plugin/index.js` 各一份）。
如果上游新增模型，手动更新：

```bash
# 获取最新模型列表
curl -s -H "Authorization: Bearer $(grep access_token ~/.atomcode/auth.toml | cut -d'"' -f2)" \
  "https://api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max" | python3 -m json.tool
```

然后编辑对应文件，替换 `KNOWN_MODELS` 数组内容。

---

## 6. 完整安装（自动化脚本）

对于 agent 自动化安装，可按此顺序执行：

```bash
# === 1. 前置检查 ===
if ! command -v node &>/dev/null; then echo "需要 Node.js 18+"; exit 1; fi
if ! command -v atomcode &>/dev/null; then echo "需要安装 AtomCode"; exit 1; fi
if [ ! -f ~/.atomcode/auth.toml ]; then
  echo "请先运行 atomcode login 或 atomcode codingplan"
  exit 1
fi

# === 2. 安装插件 ===
mkdir -p ~/.config/opencode/plugins
cp plugin/index.js ~/.config/opencode/plugins/atomcode-auth.js

# === 3. 合并 opencode.json（示例：用 jq 合并 provider 和 plugin） ===
# 这里假设已安装 jq，实际操作中需要用文本处理工具合并
# 关键字段: provider.atomgit 和 plugin 数组
```

---

## 7. 参考链接

- [README.md](./README.md) — 功能概述和快速开始
- [AGENTS.md](./AGENTS.md) — 面向 agent 的开发指南
- [opencode-config.json](./opencode-config.json) — 配置模板
- [docs/atomcode-integration-notes.md](./docs/atomcode-integration-notes.md) — 逆向分析笔记
