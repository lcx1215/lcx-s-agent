const teamList = document.querySelector("#team-list");
const dateLine = document.querySelector("#date-line");
const refreshButton = document.querySelector("#refresh");
const syncPill = document.querySelector("#sync-pill");
const briefLine = document.querySelector("#brief-line");
const statusLanes = document.querySelector("#status-lanes");
const xpLabel = document.querySelector("#xp-label");
const xpBar = document.querySelector("#xp-bar");
const xpDetail = document.querySelector("#xp-detail");
const supervisionCards = document.querySelector("#supervision-cards");
const questionButtons = document.querySelector("#question-buttons");
const answerLabel = document.querySelector("#answer-label");
const answerTitle = document.querySelector("#answer-title");
const answerBody = document.querySelector("#answer-body");
const costTitle = document.querySelector("#cost-title");
const costBody = document.querySelector("#cost-body");
const failureState = document.querySelector("#failure-state");
const failureCards = document.querySelector("#failure-cards");
const arenaTable = document.querySelector("#arena-table");

let latestSnapshot = null;
let selectedItemId = "active_eval_and_mlx";

const team = [
  ["governance", "总控", "看全局"],
  ["training", "训练", "写入权重"],
  ["eval", "评测", "小考验收"],
  ["lark", "Lark", "真实可见"],
  ["provider", "外部模型", "高额度评审"],
  ["learning", "资料学习", "吸收证据"],
  ["worktree", "脏文件", "归类收口"],
  ["authority", "高权限", "永不自动"],
];

const questionSet = [
  ["today", "今天产出了什么"],
  ["blocked", "为什么卡住"],
  ["auth", "要我授权什么"],
  ["trainable", "能不能喂回训练"],
];

function text(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function statusTone(status) {
  if (status === "blocked_now") {return "red";}
  if (status === "never_auto") {return "black";}
  if (status === "codex_can_act_when_safe") {return "yellow";}
  return "green";
}

function statusLabel(status) {
  return {
    blocked_now: "必须看住",
    never_auto: "永不放权",
    codex_can_act_when_safe: "可代管",
    owner_visible: "可查看",
  }[status] ?? "观察中";
}

function currentItem() {
  const items = array(latestSnapshot?.controlItems);
  return items.find((item) => item.id === selectedItemId) ?? items[0];
}

function renderTeam(snapshot) {
  const items = array(snapshot.controlItems);
  teamList.innerHTML = team
    .map(([_id, title, subtitle], index) => {
      const item = items[index % Math.max(items.length, 1)];
      const tone = statusTone(item?.status);
      return `
        <button class="team-item ${tone}" type="button" data-index="${index}">
          <span class="team-icon">${index + 1}</span>
          <span><strong>${title}</strong><small>${subtitle}</small></span>
          <b>${statusLabel(item?.status)}</b>
        </button>
      `;
    })
    .join("");
}

function renderLanes(snapshot) {
  const summary = snapshot.controlSummary ?? {};
  const total = Math.max(Number(summary.totalItems ?? 0), 1);
  const lanes = [
    ["green", "绿色通道", "能看清", Math.max(total - Number(summary.blockedNowCount ?? 0) - Number(summary.neverAutoCount ?? 0), 0)],
    ["yellow", "黄色通道", "可代管", Number(summary.codexActionableCount ?? 0)],
    ["red", "红色通道", "必须停手", Number(summary.blockedNowCount ?? 0) + Number(summary.neverAutoCount ?? 0)],
  ];
  statusLanes.innerHTML = lanes
    .map(([tone, title, label, count]) => {
      const width = Math.min(100, Math.round((Number(count) / total) * 100));
      return `
        <article class="lane ${tone}">
          <div><span></span><strong>${title}</strong><b>${count}</b></div>
          <small>${label}</small>
          <i style="width:${width}%"></i>
        </article>
      `;
    })
    .join("");
}

function renderXp(snapshot) {
  const evolution = snapshot.evolution ?? {};
  const packets = Number(evolution.acceptedSkillOptPackets ?? 0);
  const slice = Number(evolution.trainSliceWritten ?? 0);
  const blocked = Number(evolution.blockedAdapterCandidates ?? 0);
  const percent = Math.max(12, Math.min(82, Math.round((packets * 12 + slice / 80) % 100)));
  xpLabel.textContent = `Lv.${Math.max(1, packets + 25)} · ${percent}%`;
  xpBar.style.width = `${percent}%`;
  xpDetail.textContent = `${Number(evolution.datasetExamples ?? 0).toLocaleString()} 条材料 · ${slice.toLocaleString()} 条训练切片 · ${blocked} 个候选被拦住`;
}

function renderCards(snapshot) {
  const items = array(snapshot.controlItems);
  supervisionCards.innerHTML = items
    .map((item, index) => {
      const tone = statusTone(item.status);
      const active = item.id === selectedItemId ? "active" : "";
      return `
        <button class="supervision-card ${tone} ${active}" type="button" data-id="${item.id}">
          <div class="card-title"><span>${index + 1}</span><strong>${item.title}</strong><b>${statusLabel(item.status)}</b></div>
          <dl>
            <div><dt>谁看</dt><dd>${text(item.supervisor)}</dd></div>
            <div><dt>看什么</dt><dd>${text(item.evidenceNow)}</dd></div>
            <div><dt>允许继续</dt><dd>${text(item.proceedWhen)}</dd></div>
            <div><dt>必须停手</dt><dd>${text(item.stopWhen)}</dd></div>
          </dl>
        </button>
      `;
    })
    .join("");
}

function answerFor(kind, snapshot) {
  const item = currentItem();
  const evolution = snapshot.evolution ?? {};
  if (kind === "today") {
    return [
      "今天产出了什么",
      `已刷新老板总览和管控图；训练材料账本 ${Number(evolution.datasetExamples ?? 0).toLocaleString()} 条，训练切片 ${Number(evolution.trainSliceWritten ?? 0).toLocaleString()} 条，小规则候选 ${evolution.acceptedSkillOptPackets ?? 0} 条。`,
    ];
  }
  if (kind === "blocked") {
    return ["为什么卡住", `${text(item?.title)}：${text(item?.reason)} ${text(item?.stopWhen)}`];
  }
  if (kind === "auth") {
    return ["要我授权什么", text(item?.ownerAuthorization, "现在不需要授权，只需要继续观察。")];
  }
  return [
    "能不能喂回训练",
    snapshot.failureTrace?.canBecomeTrainingMaterial
      ? `可以。当前失败小票说可以变训练材料；下一步是 ${text(snapshot.failureTrace.nextSafeAction)}。`
      : "暂时不能。还缺能证明失败原因的记录，不能直接塞进训练。",
  ];
}

function renderQuestions(snapshot) {
  questionButtons.innerHTML = questionSet
    .map(([id, label]) => `<button type="button" data-question="${id}">${label}<span>›</span></button>`)
    .join("");
  const [title, body] = answerFor("blocked", snapshot);
  answerLabel.textContent = "当前选择";
  answerTitle.textContent = title;
  answerBody.textContent = body;
}

function renderCost(snapshot) {
  const summary = snapshot.realCostLedger?.summary ?? {};
  const rows = array(snapshot.realCostLedger?.byModel);
  const dailyUse = snapshot.providerDailyUse ?? {};
  const calls = Number(summary.confirmedProviderCalls ?? 0).toLocaleString();
  const accepted = Number(summary.confirmedAcceptedTeacherSamples ?? 0).toLocaleString();
  const estimated = Number(summary.estimatedCapturedTextTokens ?? 0).toLocaleString();
  const council = Number(summary.councilRoleCalls ?? 0).toLocaleString();
  const usage =
    summary.confirmedUsageTokens === null || summary.confirmedUsageTokens === undefined
      ? "旧日志未保存"
      : Number(summary.confirmedUsageTokens).toLocaleString();
  const cost =
    summary.confirmedBilledCostCny === null || summary.confirmedBilledCostCny === undefined
      ? "无账单证据"
      : `¥${Number(summary.confirmedBilledCostCny).toFixed(2)}`;
  const providerLine = rows
    .filter((row) => /kimi|deepseek|minimax|moonshot/i.test(String(row.model ?? row.providerFamily ?? "")))
    .slice(0, 5)
    .map((row) => `${text(row.model)} ${Number(row.calls ?? 0).toLocaleString()}次`)
    .join("；");
  const dailyLine = dailyUse.completeCouncilInWindow
    ? "今日三方已用"
    : `今日三方未完成${array(dailyUse.missingSuccessfulRoles).length ? `，缺 ${array(dailyUse.missingSuccessfulRoles).join("/")}` : ""}`;
  costTitle.textContent = `${calls} 次三方和老师调用`;
  costBody.textContent = `${dailyLine}；三方评审 ${council} 次；可用 ${accepted} 条；确认 usage token：${usage}；确认金额：${cost}；粗估总文本 Token：${estimated}。${providerLine ? ` 分账：${providerLine}。` : ""}`;
}

function renderFailure(snapshot) {
  const recovered = array(snapshot.parseRecoveredCaseIds);
  const failed = array(snapshot.failedCaseIds);
  const cases = [...failed, ...recovered].slice(0, 4);
  failureState.textContent = `${snapshot.failureTrace?.result ?? "unknown"} · ${text(snapshot.failureTrace?.firstFailedGate)}`;
  failureCards.innerHTML = (cases.length ? cases : ["等待下一张失败卡"])
    .map((name, index) => `
      <article class="failure-card level-${index}">
        <span>${index === 0 ? "高" : index === 1 ? "中" : "低"}</span>
        <strong>${name}</strong>
        <p>${index === 0 ? "优先变成小考或训练材料。" : "进入复盘池，等待空闲窗口处理。"}</p>
        <small>影响：防止同类问题再次混进晋级。</small>
      </article>
    `)
    .join("");
}

function renderArena(snapshot) {
  const dailyUse = snapshot.providerDailyUse ?? {};
  const rows = [
    ["本地干净模型", snapshot.promotionReady ? "可守擂" : "守擂中", "只读辅助", "不直接交付"],
    ["候选模型", array(snapshot.parseRecoveredCaseIds).length ? "未通过" : "待验收", "需要小考", "不能晋级"],
    ["MiniMax Agent", "强老师", "可产训练材料", "要过滤网"],
    [
      "外部评审团",
      dailyUse.completeCouncilInWindow ? "今日已用" : snapshot.providerBlocks?.length ? "被挡住" : "可计划",
      "高额度",
      "不改配置",
    ],
  ];
  arenaTable.innerHTML = `
    <div class="arena-row head"><span>角色</span><span>状态</span><span>用途</span><span>边界</span></div>
    ${rows
      .map((row) => `<div class="arena-row">${row.map((cell) => `<span>${cell}</span>`).join("")}</div>`)
      .join("")}
  `;
}

function render(snapshot) {
  latestSnapshot = snapshot;
  dateLine.textContent = `${text(snapshot.checkedAt)} · ${text(snapshot.nextAction)}`;
  briefLine.textContent = text(snapshot.ownerBriefHeadline);
  syncPill.textContent = snapshot.activeHeavyCount > 0 ? "机器忙，保持只读" : "空闲，可按门禁推进";
  syncPill.className = snapshot.activeHeavyCount > 0 ? "sync-pill busy" : "sync-pill";
  renderTeam(snapshot);
  renderLanes(snapshot);
  renderXp(snapshot);
  renderCards(snapshot);
  renderQuestions(snapshot);
  renderCost(snapshot);
  renderFailure(snapshot);
  renderArena(snapshot);
}

async function refresh() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/farm-snapshot", { cache: "no-store" });
    if (!response.ok) {throw new Error(`HTTP ${response.status}`);}
    render(await response.json());
  } catch (error) {
    briefLine.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    refreshButton.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const card = event.target.closest("[data-id]");
  if (card) {
    selectedItemId = card.dataset.id;
    if (latestSnapshot) {renderCards(latestSnapshot);}
  }
  const question = event.target.closest("[data-question]");
  if (question && latestSnapshot) {
    const [title, body] = answerFor(question.dataset.question, latestSnapshot);
    answerLabel.textContent = text(currentItem()?.title, "当前系统");
    answerTitle.textContent = title;
    answerBody.textContent = body;
  }
});

void refresh();
setInterval(() => void refresh(), 30_000);
