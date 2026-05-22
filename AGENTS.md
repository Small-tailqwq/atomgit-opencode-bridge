# AtomGit OpenCode Bridge — AGENTS.md

## 项目说明

让 AtomCode CodingPlan 订阅用户能在任意 OpenAI 兼容客户端中使用模型（deepseek-v4-flash、GLM-5.1、Qwen）。两种部署模式：

- **插件模式**：OpenCode 插件（`plugin/index.js`），在 fetch 调用中注入认证头 — 不需要代理
- **代理模式**：`proxy.js` 运行独立 HTTP 代理（端口 `:9457`）— 适用于任意客户端（Cline、Continue 等）

## 关键文件

| 文件 | 用途 |
|---|---|
| `proxy.js` | 独立代理（CommonJS，零依赖）。入口：`node proxy.js` |
| `plugin/index.js` | OpenCode 插件（ESM）。安装到 `~/.config/opencode/plugins/atomcode-auth.js` |
| `opencode-config.json` | 配置片段 — 合并到用户的 `~/.config/opencode/opencode.json` |
| `bin/atomgit-proxy` | Bash 生命周期脚本：`start\|stop\|restart\|status` |
| `docs/atomcode-integration-notes.md` | AtomCode 认证的完整逆向分析笔记 |

## 常用命令

```bash
# 代理模式
node proxy.js                           # 前台运行
./bin/atomgit-proxy start               # 后台运行（绕过系统代理）
./bin/atomgit-proxy stop
./bin/atomgit-proxy status
curl http://127.0.0.1:9457/v1/models    # 验证

# 插件模式 — 复制到全局插件目录：
cp plugin/index.js ~/.config/opencode/plugins/atomcode-auth.js
# 然后将 opencode-config.json 中的 plugin 引用和 provider 配置合并到 ~/.config/opencode/opencode.json
```

## 架构

上游：`llm-api.atomgit.com`（OpenAI 兼容）。认证只需 2 个头：
- `Authorization: Bearer <token>` — 来自 `~/.atomcode/auth.toml`
- `User-Agent: atomcode/4.23.0` — 必须以 `atomcode/` 开头

`proxy.js` 和 `plugin/index.js` 都内置了 token 自动刷新：检测到过期（预留 5 分钟余量），调用 `POST https://acs.atomgit.com/oauth/refresh`，将新 token 写回 `auth.toml`。并发请求已去重。

## 注意事项

- **零 npm 依赖** — 只使用 Node.js 内置模块（`http`、`https`、`fs`、`path`）。不需要 `npm install`。
- **无测试、无 CI、无构建步骤** — 代理本身就是测试。用 `curl http://127.0.0.1:9457/v1/models` 验证。
- **系统代理（Clash/V2Ray）会拦截 localhost** — 必须设置 `NO_PROXY=localhost,127.0.0.1,::1`，或者启动时清空 `http_proxy="" https_proxy=""`。
- **模型列表硬编码**在 `proxy.js` 和 `plugin/index.js` 的 `KNOWN_MODELS` 数组中。如果上游新增模型，从 `api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max` 获取更新。
- `proxy.js` 是 CommonJS（`require`）；`plugin/index.js` 是 ESM（`import`）。
- **已移除 CORS 头** — 终端/WSL 不需要浏览器跨域。`Access-Control-Allow-Origin: *` 打开了通过浏览器 localhost 进行 CSRF 的攻击面。如果需要浏览器访问（例如 Windows 上 SillyTavern 的 Web UI 通过 WSL 代理），重新加上即可。
- **可选的 `LOCAL_API_KEY` 环境变量** — 设置 `LOCAL_API_KEY=<secret>` 后，所有请求需要携带 `X-API-Key: <secret>` 头。不设置时行为不变（无认证）。这可以防止本地恶意进程（如流氓 VS Code 插件、被污染的 npm 包）不知道 key 而无法使用你的代理。

## AGENTS.md 维护说明

本文档通过研究代码库自动生成。添加新的部署模式、修改认证流程或增加依赖时，请同步更新。
