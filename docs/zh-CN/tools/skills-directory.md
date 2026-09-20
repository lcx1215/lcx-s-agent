---
read_when:
  - 向新用户介绍 Skills 目录
  - 添加、共享或备份 Skills
  - 说明 Skills 加载顺序
summary: Skills 目录：Skills 存放位置与添加方式
title: Skills 目录
---

# Skills 目录

一个 Skill 就是一个包含 `SKILL.md` 文件（以及辅助文本文件）的文件夹。LCX Agent 在仓库的 `skills/`
目录中内置了一批 Skills，同时也会加载你放到下列任一 Skills 根目录中的额外 Skill 文件夹。

浏览内置 Skills：[skills/](https://github.com/lcx1215/lcx-s-agent/tree/main/skills)

## Skills 存放位置

Skills 从四个位置加载，优先级从高到低：

1. `<workspace>/skills` —— 单个项目专用的 Skills。
2. `~/.openclaw/skills` —— 本机所有智能体共享的 Skills。
3. **内置** Skills，随安装一起提供。
4. `skills.load.extraDirs` —— 在 `~/.openclaw/openclaw.json` 中配置的额外目录（最低优先级）。

macOS 应用还提供 Skills UI。在 Linux 或无界面安装中，请直接复制文件夹。

## 添加 Skill

- 将 Skill 添加到你的工作区（下一个会话生效）：

  ```bash
  mkdir -p ./skills
  cp -R <skill-folder> ./skills/<skill-name>
  ```

- 在本机所有智能体之间共享：

  ```bash
  mkdir -p ~/.openclaw/skills
  cp -R <skill-folder> ~/.openclaw/skills/<skill-name>
  ```

放在当前工作目录 `./skills` 下的 Skills 会在下一个会话作为 `<workspace>/skills` 被加载。

## 备份你的 Skills

你自己的 Skills 就是普通文件夹，所以常规备份方式都适用 —— 把 `./skills` 和
`~/.openclaw/skills` 复制到安全的地方，或者放进 git 仓库。如果希望把 Skill 贡献给本项目，
请向仓库的 `skills/` 目录发起 Pull Request。

## 安全注意事项

- 将第三方 Skills 视为**不受信任的代码**。启用前请阅读它们。
- 对不受信任的输入和高风险工具，优先使用沙箱运行。参见[沙箱隔离](/gateway/sandboxing)。
