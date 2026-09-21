# LCX Lane Coverage Audit — 孤儿文件与"静默不跑"的路子

日期：2026-09-21。范围：`scripts/**` 的可执行入口 + 全仓 `*.test.*` 的门禁归属。
性质：**只读普查**（除一处临时探针，跑完即删，见 §A.3）。本文只记证据与判断，不改代码。

## 结论先行

1. **真正"没有任何门禁认领"的测试文件 = 0**（唯一的 1 条是 `vendor/` 第三方文件，被根配置正确排除）。
2. **但存在两条静默丢文件的路子**，两者都退出码 0、无警告：
   - `unit-isolated` lane **声明 57 条、实际只跑 17 条**；
   - **33 个 ui 测试文件零门禁**（只被 browser lane 认领，而该 lane 不在 CI）。
3. **`protocol:check` 是空洞门禁**：它比对的产物被 gitignore 且未跟踪 ⇒ `git diff` 恒为 0。
4. **孤儿脚本 6 条**，其中 2 条值得动作：`lcx-finance-tuning-proposal.ts`（**该接**）、
   `check-plugin-sdk-exports.mjs`（**不该接，该合并**）。1 条是普查假阳性。
5. "大量文件不在 CI 门禁"**不是缺陷**——`docs/reference/test.md:15,18` 已声明 `pnpm test` 只跑
   fast core unit lane。**但 `docs/help/testing.md:45-46` 与实现不符。**

---

## 0. 门禁拓扑（先数清楚，再谈谁没跑）

CI（`.github/workflows/ci.yml` 的 `checks` job）只有 3 条：

| lane          | 命令                                             | 说明                                       |
| ------------- | ------------------------------------------------ | ------------------------------------------ |
| node test     | `pnpm canvas:a2ui:bundle && pnpm test`           | `test` = `scripts/tests/test-parallel.mjs` |
| node protocol | `pnpm protocol:check`                            | 见 §C                                      |
| bun test      | `bunx vitest run --config vitest.unit.config.ts` | push 事件跳过                              |

仓库共 **8 个 vitest config**：`vitest.config.ts`(root) / `unit` / `gateway` / `extensions` /
`channels` / `e2e` / `live` / `ui`(browser)。其中 `test-parallel.mjs` **默认只枚举 unit lane**；
`extensions` 与 `gateway` 挂在 `OPENCLAW_TEST_INCLUDE_EXTENSIONS=1` / `OPENCLAW_TEST_INCLUDE_GATEWAY=1`
后面，**CI 从不设这两个变量**；`channels` config **没有任何脚本或 workflow 调用**（只有
`package.json` 的 `test:channels` 手动入口）。

`vitest.unit.config.ts` 的 include **继承根 `vitest.config.ts`**，只过滤掉 `extensions/`，
再额外 exclude 10 个目录（`src/gateway`、`extensions`、`src/telegram`、`src/discord`、`src/web`、
`src/browser`、`src/line`、`src/agents`、`src/auto-reply`、`src/commands`）。

---

## A. 测试文件归属

### A.1 全量普查

把 8 个 config 的 include/exclude 全建模后扫描全仓（排除 `node_modules`/`dist`/`vendor`/`.git`）：

```
TOTAL test files found: 2417
CLAIMED BY NO CONFIG : 1
  vendor/a2ui/renderers/lit/src/0.8/model.test.ts   ← 被根 exclude 的 **/vendor/** 正确排除
```

⇒ **真实孤儿 0。**

### A.2 ★ 33 个 ui 测试文件零门禁

`ui/vitest.config.ts`（browser / playwright）include 是 `ui/src/**/*.test.ts`。
其中 **33 个文件只被这一个 config 认领**：

```
ui/src/i18n/test/translate.test.ts
ui/src/ui/app-gateway.node.test.ts          ← 名字声明 node
ui/src/ui/app-lifecycle.node.test.ts        ← 名字声明 node
ui/src/ui/app-render.helpers.node.test.ts   ← 名字声明 node
ui/src/ui/app-tool-stream.node.test.ts      ← 名字声明 node
ui/src/ui/app-scroll.test.ts
ui/src/ui/app-settings.test.ts
ui/src/ui/chat-event-reload.test.ts
ui/src/ui/chat-markdown.browser.test.ts
ui/src/ui/chat/message-extract.test.ts
ui/src/ui/chat/message-normalizer.test.ts
ui/src/ui/chat/tool-helpers.test.ts
ui/src/ui/config-form.browser.test.ts
ui/src/ui/controllers/config/form-utils.node.test.ts  ← 名字声明 node
ui/src/ui/external-link.test.ts
ui/src/ui/focus-mode.browser.test.ts
ui/src/ui/format.test.ts
ui/src/ui/markdown.test.ts
ui/src/ui/navigation.browser.test.ts
ui/src/ui/navigation.test.ts
ui/src/ui/open-external-url.test.ts
ui/src/ui/storage.node.test.ts              ← 名字声明 node
ui/src/ui/text-direction.test.ts
ui/src/ui/usage-helpers.node.test.ts        ← 名字声明 node
ui/src/ui/uuid.test.ts
ui/src/ui/views/agents-panels-tools-skills.browser.test.ts
ui/src/ui/views/chat-image-open.browser.test.ts
ui/src/ui/views/chat.test.ts
ui/src/ui/views/config-search.node.test.ts  ← 名字声明 node
ui/src/ui/views/config.browser.test.ts
ui/src/ui/views/cron.test.ts
ui/src/ui/views/overview.node.test.ts       ← 名字声明 node
ui/src/ui/views/sessions.test.ts
```

而这 33 个**没有任何 CI 门禁**：

- `pnpm test:ui` = `pnpm lint:ui:no-raw-window-open && pnpm --dir ui test`；
- CI 的 3 条 lane 里**没有** `test:ui`，也没有任何 workflow 提到 `playwright`；
- `pnpm test:all` 的链（`lint → build → test → test:e2e → test:live → test:docker:all`）**也不含** `test:ui`；
- 本机 `ui/node_modules` **不存在** ⇒ playwright 与 ui 依赖都没装，本地也跑不起来。

### A.3 ★ 9 个 `*.node.test.ts` 的可跑性实测

命名约定上 `.node.test.ts` 表示"在 node 下跑"（根 include 里已有 3 个同类：
`config-form.node.test.ts`、`config-form.search.node.test.ts`、`usage.node.test.ts`）。
所以对这 9 个做了一次实测——**临时 config 探针**（`vitest.census-probe.config.ts`，跑完即删，
工作区无残留）：

```
Test Files  3 failed | 6 passed (9)
     Tests  47 passed (47)
```

| 结果          | 文件                                                                                                                                                  | 判断       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ✅ 零改动通过 | `controllers/config/form-utils.node`、`app-tool-stream.node`、`usage-helpers.node`、`storage.node`、`views/config-search.node`、`views/overview.node` | **该接**   |
| ❌ 失败       | `app-gateway.node`、`app-lifecycle.node`、`app-render.helpers.node`                                                                                   | **不该接** |

失败根因分两层（第二层是关键）：

1. `ui/src/i18n/lib/translate.ts:25` 在**导入期**读 `localStorage`
   → 用已有的 `ui/src/ui/controllers/test-storage-shim.ts` 挂上后**该错误消失**，确认这是第一层。
2. 露出更深一层：`ui/src/ui/device-identity.ts:1` 导入 `@noble/ed25519`
   → `Cannot find package '@noble/ed25519'`。该包**只是 `ui/package.json` 的依赖**，
   root `package.json` 没有它，`ui/node_modules` 也不存在。

⇒ 这 3 个不是"补个 shim 就能接"，而是**依赖面不在 node lane 里**。**不该接进 node lane**，
除非先把 ui 依赖装上——那已经不是"接线"，而是改依赖边界。

### A.4 剩余 24 个

`*.browser.test.ts` 与需要真实 DOM 的（`markdown`、`format`、`navigation`、`uuid`、
`chat/*`、`views/cron`、`views/chat` 等）**留在 browser lane**。
前提是**先给 browser lane 一个门禁**（CI 装 playwright + 调 `pnpm test:ui`），否则它们永远不跑。
这是一项有成本的决定（浏览器下载 + CI 时长），不建议顺手做。

### A.5 建议动作（A 部分）

| #   | 动作                                                                       | 成本             | 需要授权    |
| --- | -------------------------------------------------------------------------- | ---------------- | ----------- |
| A-1 | 把 6 个已实测通过的 `.node.test.ts` 加进根 `vitest.config.ts` 的 `include` | 6 行，零代码改动 | 否          |
| A-2 | 3 个失败文件保持现状（或先在 `ui/package.json` 侧解决依赖，再议）          | —                | 否          |
| A-3 | 决定 browser lane 是否进 CI（装 playwright）                               | 中               | 是（改 CI） |

---

## B. ★ `unit-isolated` lane：声明 57 / 实跑 17

`scripts/tests/test-parallel.mjs` 的 `unitIsolatedFilesRaw`（第 9-87 行）**声明 57 条**，
逐条对照 unit config 的 include/exclude：

| 结果                                 | 条数   | 机制                                                                                                                                        |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **真正跑**                           | **17** | 正常                                                                                                                                        |
| **被 unit config 的 `exclude` 吃掉** | **23** | unit-fast 用 `--exclude` 排掉它们；unit-isolated 又把它们当**位置参数**传入，而 config 的 `exclude` **压过位置参数** ⇒ **两个 lane 都不跑** |
| **文件已不存在**                     | **16** | `test-parallel.mjs:88` 的 `fs.existsSync` **静默过滤**（改名/删除后的陈旧条目）                                                             |
| 不在 unit include 里                 | 1      | `extensions/acpx/src/runtime.test.ts`（属 extensions lane，而该 lane 默认不跑）                                                             |

### 实证（不是读配置推断）

```
$ vitest run --config vitest.unit.config.ts src/agents/skills.test.ts
No test files found, exiting with code 1
exclude:  dist/**, **/node_modules/**, **/vendor/**, **/*.live.test.ts, **/*.e2e.test.ts,
          src/gateway/**, extensions/**, src/telegram/**, src/discord/**, src/web/**,
          src/browser/**, src/line/**, src/agents/**, src/auto-reply/**, src/commands/**

$ vitest run --config vitest.unit.config.ts src/media/store.test.ts      # 对照
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

⇒ 机制确证：**同一个位置参数写法，不在 exclude 目录里的跑得起来，在的跑不起来。**

### 被吃掉的那 23 条（按目录）

```
src/agents/**      12   src/browser/**  6   src/auto-reply/**  6
src/commands/**     5   src/web/**      3   src/telegram/**    2
```

### 判断

- **该修**：这 23 条文件的注释写的都是"keep them off the unit-fast critical path"——
  即**本意是"晚点跑"而不是"不跑"**。现状与声明意图相反，且**静默**（exit 0、无警告）。
- **修法方向**（未实施，需先定预期调用者）：把"被 config exclude 的目录"从
  `unitIsolatedFilesRaw` 里移出并登记到它真正的 lane（`src/telegram`/`src/web`/`src/browser`
  → `channels` lane；`src/agents`/`src/commands`/`src/auto-reply` → 需要一条新 lane 或并入 root）；
  同时给 `existsSync` 过滤**加一条警告**，让陈旧条目自己暴露，而不是等下一次普查。
- **不要**把 `src/agents/**` 从 unit exclude 里删掉来"修"——那会把 12 个重文件塞回 fast lane，
  与既有性能设计冲突。

---

## C. `protocol:check` 是空洞门禁

`pnpm protocol:check` 做两件事：生成协议产物，然后 `git diff --exit-code -- dist/protocol.schema.json`。
但 `dist` 在 `.gitignore:5` 里，`dist/protocol.schema.json` **未跟踪** ⇒ `git diff` 对该文件
**恒为 0**（实测 exit=0）。

⇒ CI 里这条 lane **永远绿**，它不证明"协议产物与源码一致"。

**判断：该修**（改成对生成产物做内容比对，或把产物移出 gitignore 并纳入跟踪）。
属共享契约面（G2），需要单独一轮。

---

## D. 文档与实现不符

| 文件                           | 说法                                                        | 实测                                                          |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/reference/test.md:15,18` | `pnpm test` 只跑 fast core unit lane；gateway 是 opt-in     | **准确** ⇒ "大量文件不在门禁"是**已声明设计**，不是缺陷       |
| `docs/help/testing.md:45-46`   | 称跑 3 个 config、Files 为 `src/**/*.test.ts`、"Runs in CI" | **与实现不符**（默认只跑 1 条 lane，且 ui 文件不在 Files 里） |

**判断**：`docs/help/testing.md` **该改**（G0，纯文档）。

---

## E. 孤儿脚本（`scripts/**` 224 个；语料 = 全仓 8348 个文本文件）

判"零引用"用了四种引用形态：完整相对路径、`./` 前缀、basename、
**`NodeNext` 的 `.js` 后缀形式**、以及**正则转义形式**（`scripts\/a\/b\.ts`）。
前两轮各有假阴性，修正后才收敛到 6 条。

| 脚本                                              | 字节 | 判断               | 依据                                                                                                                           |
| ------------------------------------------------- | ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/operator/lcx-finance-tuning-proposal.ts` | 4730 | **该接**           | 见 §E.1                                                                                                                        |
| `scripts/checks/check-plugin-sdk-exports.mjs`     | 3542 | **不该接，该合并** | 见 §E.2                                                                                                                        |
| `scripts/setup-auth-system.sh`                    | 3746 | 不接               | 一次性机器设置（`claude setup-token` + Termux widgets），属个人环境；但已与当前 `auth-profiles.json` 授权故事脱节，宜标 legacy |
| `scripts/changelog-to-html.sh`                    | 2541 | 不接（或删）       | release 流程的 `release-check.ts` / `CHANGELOG.md` / `CONTRIBUTING.md` **三处都不提它**                                        |
| `scripts/sqlite-vec-smoke.mjs`                    | 1002 | 待定               | `sqlite-vec@0.1.7-alpha.2` 是真依赖且已装；smoke 无人调用 ⇒ 接进一条 lane 或删除                                               |
| `scripts/watch-node.d.mts`                        | 349  | **假阳性**         | 它是 `watch-node.mjs` 的类型声明，被 `src/infra/watch-node.test.ts` 经 `import "../../scripts/watch-node.mjs"` **隐式消费**    |

### E.1 ★ `lcx-finance-tuning-proposal.ts` —— 该接

**它自己的文档说它必须在调度上闭合**（`lcx-finance-tuning-proposal.ts:9-11`）：

> It exists as an operator entry rather than only as a tool because a step that only a
> conversation can reach is a step that does not happen on a schedule. The loop has to
> close on its own up to the point where a human is required.

**实测：全仓零引用**（唯一出现是它自己的用法注释）。取证分三面：

1. **不违反既有设计约束**：它调 `proposeTuning`，是**纯算术**（`FloorSample[]` → proposals），
   **不调模型**。而 `lcx-finance-daily-cycle.ts:8-10` 与 `lcx-finance-scheduler.ts:13-14` 说的是
   "nightly self-calibration（**需要模型**的那一步）故意不在循环里，单独预算" ⇒ 本步骤不在该豁免范围。
2. **调度面**：唯一的 launchd 小时级 runner 是 `lcx.local.operator.loop.plist`
   → `~/.openclaw/bin/lcx-local-operator-loop.sh`，它调用 7 个 operator 脚本
   （`lcx-system-doctor`、`local-brain-training-plan`、`lcx-governance-autopilot`、`lcx-mind-model`、
   `lcx-flow-graph`、`lcx-context-recovery-exam`、`lcx-agent-exam`）——**没有一个 finance 步骤**。
   `~/.openclaw/cron/jobs.json` 只有 1 个 job（记忆沉淀，`agentTurn`），**无 finance**。
   `~/Library/LaunchAgents/` 里**没有** finance 调度器 plist。
3. **运行时证据**（`state/finance/`）：`research-scored.jsonl` = **0 字节**；
   **`tuning-proposals.jsonl` 不存在** ⇒ 这一步在此状态根**从未运行过**。

**判断：该接**（挂到 night 之后，或挂到 operator loop 并加日频守卫）。
**但当前影响为 0**：输入为空（结算 horizon 未到）⇒ 即使跑了也只会输出 "no proposal"。
闭环在 "propose" 这一步是断的，只是**还没到会疼的时候**。

⚠️ **改动面在 `~/.openclaw/bin/*.sh`（只读禁区，改前 `cp -p`、只做加法）或 finance 调度器
⇒ 需用户明确授权后再动。**

### E.2 ★ `check-plugin-sdk-exports.mjs` —— 不该接，该合并

与 `scripts/release-check.ts:checkPluginSdkExports()`（第 155-188 行）是**同一检查的两份实现**：

- 21 个导出名清单**逐字相同**（`isDangerousNameMatchingEnabled` … `DEFAULT_GROUP_HISTORY_LIMIT`）；
- `release-check.ts:192` **确实调用**它，且 `.github/workflows/ci.yml:113` 跑 `pnpm release:check`
  ⇒ **覆盖存在**，不是"没人守"。

**漂移点只有一个**：`.mjs` 的 `requiredSubpathEntries`（9 条）里多一个 `account-id`，
而 `release-check.ts` 的 `requiredPathGroups`（第 11-34 行）**没有 `dist/plugin-sdk/account-id.{js,d.ts}`**。

**判断：不该接**——再挂一条重复门禁只会再漂一次（这正是现在这份漂移的成因）。
**该合并**：把 `dist/plugin-sdk/account-id.js` / `.d.ts` 补进 `release-check.ts` 的
`requiredPathGroups`，`.mjs` 即可退场（**删除需授权**，不在本轮范围）。

---

## F. 复现方式

- 测试文件归属：把 8 个 config 的 include/exclude 建模为 glob 后扫描全仓
  （`**/` 需按 picomatch 语义匹配 0 段，否则会误报）。
- `unit-isolated` 核算：从 `test-parallel.mjs` 抽出 `unitIsolatedFilesRaw` 数组字面量，
  逐条套 unit config 的 include/exclude + `fs.existsSync`。
- 可跑性实测：临时 config（继承根 config、扩展 `include`）⇒ `vitest run --config <temp>`，
  **跑完删除**，不在工作区留文件。
- 引用判定：四种引用形态 + `NodeNext` 的 `.js` 后缀 + 正则转义；语料含 `scripts/` 自身
  （只搜 `src/` 会把 `scripts/` 内部的 helper 全判成孤儿）。

## G. 未做的事（边界）

- **未改任何生产代码 / CI / 文档**：本文只有证据与判断。
- **未提交、未推送**：所有改动留在工作区。
- **未动 `~/.openclaw/`**：只读取 `cron/jobs.json` 与 `bin/lcx-local-operator-loop.sh`，未写入。
- **未给 browser lane 装 playwright**：那是有成本的决定，需用户拍板。
