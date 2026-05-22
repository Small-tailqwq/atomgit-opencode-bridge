# AtomGit Usage Monitor — Design Spec

## 概述

为 atomgit-opencode-bridge 添加用量查询能力，两种形态：

1. **CLI 脚本** `bin/atomgit-usage` — 零依赖 Node.js，可在任意设备上独立运行
2. **TUI 插件** `plugin/tui-usage.js` — 在 OpenCode 侧边栏渲染实时用量面板

## 数据源

```
GET https://api.gitcode.com/api/v5/coding-plan/status-v2
Authorization: Bearer <access_token>
User-Agent: atomcode/<version>
```

响应中 `current_usage` 字段包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `usage_percent` | f64 | 用量百分比 |
| `window_token_limit` | i64 | 滚动窗口 Token 限额 |
| `window_tokens_used` | i64 | 当前窗口已用 Token |
| `window_hours` | i32 | 窗口时长（小时） |
| `reset_at_display` | string | 重置时间（如 "12:13"） |
| `seconds_until_reset` | i64 | 剩余秒数 |
| `usage_status_desc` | string | 后端描述（如 "当前时间窗口用量约 7%"） |

## 1. CLI 脚本 — `bin/atomgit-usage`

### 行为

- 读取 `~/.atomcode/auth.toml`
- 如果 token 过期，自动刷新（复用 proxy.js 的刷新逻辑）
- 调 status-v2 API
- 打印格式化输出

### 输出示例

```
AtomGit CodingPlan 用量
━━━━━━━━━━━━━━━━━━━━━━━━━
Token 用量:   ████████░░░░  7% (350 / 5000)
窗口时长:     1小时滚动窗口
重置时间:     12:13 (剩余 693 秒)
状态描述:     当前时间窗口用量约 7%
```

### 错误处理

- 无 auth.toml → 提示运行 `atomcode login`
- token 过期且无 refresh_token → 提示重新登录
- 网络错误 → 显示错误信息
- 非 2xx → 显示 HTTP 状态码

### 退出码

- 0: 成功
- 1: 配置错误
- 2: API 错误

## 2. TUI 插件 — `plugin/tui-usage.js`

### 技术栈

- `@opencode-ai/plugin/tui` — TuiPlugin, TuiPluginApi, TuiSlotContext
- `@opentui/solid` — JSX 渲染（box, text, span）
- `solid-js` — createSignal, createEffect, onMount, onCleanup

### 侧边栏注册

```
api.slots.register({
  order: 60,      // 排在 visual-cache (55) 后面
  slots: {
    sidebar_content(ctx, { session_id }) {
      return <UsagePanel ... />
    }
  }
})
```

### 数据流

```
onMount
  ├── 读取 auth.toml
  ├── 调 status-v2 API
  ├── setSignal(response)
  └── setInterval(30s, repeat)

响应式:
  signal → createMemo(格式化) → JSX 渲染
```

### UI 设计

**折叠状态（默认）:**
```
AtomGit 用量 ██████░░░░ 7% ▼
```

**展开状态（点击切换）:**
```
AtomGit 用量 ██████░░░░ 7% ▼
  Token: 350 / 5000
  窗口:  1小时 · 重置 12:13
```

**色彩规则:**
- usage_percent < 80%: 正常（主题色去饱和）
- 80–95%: 黄色警告
- > 95%: 红色严重

**折叠面板**: 与 visual-cache 一样的 `▶`/`▼` 切换风格
**持久化**: 使用 `api.kv` 保存折叠状态 + 上次用量快照

### 错误处理

- API 不可达 → 显示 "⏳ 获取中..." 或 "⚠️ 网络错误"
- 无 auth → 显示 "⚠️ 未登录 (需 atomcode login)"
- 静默降级：每次 fetch 失败保留上次有效数据

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `bin/atomgit-usage` | CLI 脚本（CommonJS，`#!/usr/bin/env node`） |
| 新增 | `plugin/tui-usage.js` | TUI 插件（ESM） |
| 修改 | `AGENTS.md` | 添加新文件说明 |
