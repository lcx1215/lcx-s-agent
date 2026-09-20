---
read_when:
  - 设置新机器
  - 你想要"最新最好的"而不破坏你的个人设置
summary: 设置指南：在保持最新的同时保持你的 LCX Agent 设置个性化
title: 设置
x-i18n:
  generated_at: "2026-02-03T07:54:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b7f4bd657d0df4feb5035c9f5ee727f9c67b991e9cedfc7768f99d010553fa01
  source_path: start/setup.md
  workflow: 15
---

# 设置

最后更新：2026-01-01

## 太长不看

- **个性化设置存放在仓库之外：** `~/.openclaw/workspace`（工作区）+ `~/.openclaw/openclaw.json`（配置）。
- **稳定工作流：** 把 Gateway 网关安装为服务，然后通过浏览器或已有的聊天渠道访问它。
- **前沿工作流：** 通过 `pnpm gateway:watch` 自己运行 Gateway 网关。
- **没有原生配套应用：** Gateway 网关是一个 TypeScript 服务；你通过浏览器、聊天渠道或 CLI 与它交互。

## 先决条件（从源码）

- Node `>=22`
- `pnpm`
- Docker（可选；仅用于容器化设置/e2e — 参阅 [Docker](/install/docker)）

## 个性化策略（让更新不会造成问题）

如果你想要"100% 为我定制"*并且*易于更新，将你的自定义内容保存在：

- **配置：** `~/.openclaw/openclaw.json`（JSON/JSON5 格式）
- **工作区：** `~/.openclaw/workspace`（Skills、提示、记忆；将其设为私有 git 仓库）

引导一次：

```bash
lcx setup
```

在此仓库内部，使用本地 CLI 入口：

```bash
lcx setup
```

如果你还没有全局安装，通过 `pnpm lcx setup` 运行它。

## 稳定工作流（Gateway 网关服务优先）

1. 安装 Gateway 网关服务（以下方式均受支持）：

```bash
lcx onboard --install-daemon   # 向导（推荐）
lcx gateway install            # 直接安装
lcx configure                  # 交互式：选择 "Gateway service"
lcx doctor                     # 修复或迁移已有服务
```

2. 链接表面（示例：WhatsApp）：

```bash
lcx channels login
```

3. 完整性检查：

```bash
lcx health
```

然后通过浏览器或已有的聊天渠道访问 Gateway 网关。

如果你的构建版本中没有新手引导：

- 运行 `lcx setup`，然后 `lcx channels login`，然后手动启动 Gateway 网关（`lcx gateway`）。

## 前沿工作流（在终端中运行 Gateway 网关）

目标：开发 TypeScript Gateway 网关，获得热重载。

### 1) 启动开发 Gateway 网关

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 以监视模式运行 Gateway 网关，并在 TypeScript 更改时重新加载。

### 2) 将客户端指向你正在运行的 Gateway 网关

Gateway 网关 WebSocket 默认为 `ws://127.0.0.1:18789`。在浏览器中打开 Control UI 或 WebChat，或在该端口上连接任意客户端。

### 3) 验证

```bash
lcx health
```

### 常见陷阱

- **端口错误：** Gateway 网关 WS 默认为 `ws://127.0.0.1:18789`；保持客户端 + CLI 在同一端口上。
- **状态存储位置：**
  - 凭证：`~/.openclaw/credentials/`
  - 会话：`~/.openclaw/agents/<agentId>/sessions/`
  - 日志：`/tmp/openclaw/`

## 凭证存储映射

在调试认证或决定备份什么时使用此映射：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**：配置/环境变量或 `channels.telegram.tokenFile`
- **Discord bot token**：配置/环境变量（尚不支持令牌文件）
- **Slack tokens**：配置/环境变量（`channels.slack.*`）
- **配对允许列表**：`~/.openclaw/credentials/<channel>-allowFrom.json`
- **模型认证配置文件**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **旧版 OAuth 导入**：`~/.openclaw/credentials/oauth.json`
  更多详情：[安全](/gateway/security#credential-storage-map)。

## 更新（不破坏你的设置）

- 将 `~/.openclaw/workspace` 和 `~/.openclaw/` 保持为"你的东西"；不要将个人提示/配置放入 `openclaw` 仓库。
- 更新源码：`git pull` + `pnpm install`（当锁文件更改时）+ 继续使用 `pnpm gateway:watch`。

## Linux（systemd 用户服务）

Linux 安装使用 systemd **用户**服务。默认情况下，systemd 在注销/空闲时停止用户服务，这会终止 Gateway 网关。新手引导会尝试为你启用 lingering（可能提示 sudo）。如果仍然关闭，运行：

```bash
sudo loginctl enable-linger $USER
```

对于常驻或多用户服务器，考虑使用**系统**服务而不是用户服务（不需要 lingering）。参阅 [Gateway 网关运行手册](/gateway) 了解 systemd 说明。

## 相关文档

- [Gateway 网关运行手册](/gateway)（标志、监督、端口）
- [Gateway 网关配置](/gateway/configuration)（配置模式 + 示例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回复标签 + replyToMode 设置）
- [LCX Agent 助手设置](/start/personal-assistant)
