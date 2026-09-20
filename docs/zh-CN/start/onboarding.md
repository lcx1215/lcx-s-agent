---
read_when:
  - 运行首次运行新手引导流程
  - 实现认证或身份设置
summary: LCX Agent 的首次运行新手引导流程
title: 新手引导
x-i18n:
  generated_at: "2026-02-03T07:54:07Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ae883b2deb1f9032be7c47a04d67e1741dffbdcc4445de1e0bbaa976e606bc10
  source_path: start/onboarding.md
  workflow: 15
---

# 新手引导

本文档描述**当前**的首次运行新手引导流程。目标是流畅的"第 0 天"体验：选择 Gateway 网关运行位置、连接认证、运行向导，然后让智能体自行引导。

没有原生配套应用；新手引导通过 CLI 和新手引导聊天会话运行。

## 1) 启动向导

```bash
lcx onboard --install-daemon
```

其他入口：

```bash
lcx gateway install   # 直接安装 Gateway 网关服务
lcx configure         # 交互式：选择 "Gateway service"
lcx doctor            # 修复或迁移已有服务
```

## 2) 安全信任模型

- 默认情况下，LCX Agent 是个人智能体：一个受信任的操作员边界。
- 共享/多用户设置需要锁定（拆分信任边界，保持工具访问最小化，并遵循[安全](/gateway/security)）。
- 本地新手引导现在将新配置默认为 `tools.profile: "messaging"`，因此广泛的运行时/文件系统工具需要显式启用。
- 如果启用了 hooks/webhooks 或其他不受信任的内容源，请使用强大的现代模型层级并保持严格的工具策略/沙箱。

## 3) 本地 vs 远程

**Gateway 网关**在哪里运行？

- **本机（仅本地）：** 新手引导可以在本地配置认证并写入凭证。
- **远程（通过 SSH/Tailnet）：** 新手引导**不会**配置本地认证；凭证必须存在于 Gateway 网关主机上。
- **稍后配置：** 跳过设置并保持 Gateway 网关未配置状态。

Gateway 网关认证提示：

- 向导现在即使对于 loopback 也会生成**令牌**，因此本地 WS 客户端必须认证。
- 如果你禁用认证，任何本地进程都可以连接；仅在完全受信任的机器上使用。
- 对于多机器访问或非 loopback 绑定，使用**令牌**。

## 4) 认证

- Anthropic OAuth（Claude Pro/Max）在浏览器中进行（PKCE），凭证写入 `~/.openclaw/credentials/oauth.json`。
- 其他提供商（OpenAI、自定义 API）通过环境变量或配置文件配置。

## 5) 新手引导聊天（专用会话）

设置完成后，智能体会打开一个专用的新手引导聊天会话，以便自我介绍并指导后续步骤。这使首次运行指导与你的正常对话分开。
参阅[引导](/start/bootstrapping)了解首次智能体运行在 Gateway 网关主机上发生的事情。

## 智能体引导仪式

在首次智能体运行时，LCX Agent 会引导一个工作区（默认 `~/.openclaw/workspace`）：

- 初始化 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`
- 运行简短的问答仪式（一次一个问题）
- 将身份 + 偏好写入 `IDENTITY.md`、`USER.md`、`SOUL.md`
- 完成后删除 `BOOTSTRAP.md`，使其只运行一次

## 可选：Gmail 钩子（手动）

Gmail Pub/Sub 设置目前是手动步骤。使用：

```bash
lcx webhooks gmail setup --account you@gmail.com
```

参阅 [/automation/gmail-pubsub](/automation/gmail-pubsub) 了解详情。

## 远程模式说明

当 Gateway 网关在另一台机器上运行时，凭证和工作区文件存储在**该主机上**。如果你需要在远程模式下使用 OAuth，请在 Gateway 网关主机上创建：

- `~/.openclaw/credentials/oauth.json`
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
