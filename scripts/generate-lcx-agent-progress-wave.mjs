#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const architecturePath = "docs/assets/lcx-agent-architecture.png";
const boardPaths = [
  "docs/assets/lcx-agent-daily-progress-wave.svg",
  "docs/assets/lobster-daily-progress-wave.svg",
];

const font = "PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const architectureModules = [
  {
    no: "1",
    title: "Harness",
    subtitle: "约束与验收",
    color: "#1557c0",
    bg: "#edf4ff",
    items: ["权限与风险门", "eval / test / probe", "失败显式化"],
  },
  {
    no: "2",
    title: "Hermes",
    subtitle: "消息与证据流",
    color: "#0f8a9d",
    bg: "#ecfbff",
    items: ["意图与上下文", "handoff / receipt", "模块间传递"],
  },
  {
    no: "3",
    title: "Control Room",
    subtitle: "飞书主入口",
    color: "#6a45c9",
    bg: "#f4f0ff",
    items: ["自然语言请求", "任务 family", "summary-first"],
  },
  {
    no: "4",
    title: "Local Brain",
    subtitle: "本地沉淀层",
    color: "#15803d",
    bg: "#effbf2",
    items: ["能力卡", "修正笔记", "蒸馏样本"],
  },
  {
    no: "5",
    title: "Research Loop",
    subtitle: "低频研究工作流",
    color: "#b66a00",
    bg: "#fff8e8",
    items: ["ETF / 大资产", "research-only", "风险门控"],
  },
];

function architectureSvg() {
  const x0 = 54;
  const cardW = 300;
  const gap = 28;
  const cardH = 420;
  const cards = architectureModules
    .map((module, index) => {
      const x = x0 + index * (cardW + gap);
      const y = 190;
      const itemRows = module.items
        .map((item, itemIndex) => {
          const iy = y + 142 + itemIndex * 78;
          return `
      <rect x="${x + 24}" y="${iy}" width="${cardW - 48}" height="54" rx="16" fill="#ffffff" stroke="${module.color}" stroke-opacity="0.22"/>
      <circle cx="${x + 48}" cy="${iy + 27}" r="7" fill="${module.color}"/>
      <text x="${x + 66}" y="${iy + 34}" fill="#18212b" font-size="20" font-weight="760">${xml(item)}</text>`;
        })
        .join("");
      const arrow =
        index < architectureModules.length - 1
          ? `<path d="M ${x + cardW + 6} 400 L ${x + cardW + gap - 8} 400" stroke="#1d4ed8" stroke-width="8" stroke-linecap="round"/><path d="M ${x + cardW + gap - 8} 400 L ${x + cardW + gap - 26} 384 L ${x + cardW + gap - 26} 416 Z" fill="#1d4ed8"/>`
          : "";
      return `
    <g font-family="${font}">
      <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="28" fill="${module.bg}" stroke="${module.color}" stroke-opacity="0.46" stroke-width="2"/>
      <circle cx="${x + 42}" cy="${y + 50}" r="25" fill="${module.color}"/>
      <text x="${x + 42}" y="${y + 59}" text-anchor="middle" fill="#ffffff" font-size="28" font-weight="900">${module.no}</text>
      <text x="${x + 78}" y="${y + 52}" fill="${module.color}" font-size="27" font-weight="950">${xml(module.title)}</text>
      <text x="${x + 78}" y="${y + 82}" fill="#51606f" font-size="18" font-weight="820">${xml(module.subtitle)}</text>
      <text x="${x + 26}" y="${y + 118}" fill="#51606f" font-size="16" font-weight="700">长期运行系统的职责面</text>
      ${itemRows}
    </g>
    ${arrow}`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1717" height="916" viewBox="0 0 1717 916">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fbff"/>
      <stop offset="0.55" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f2fff7"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#102030" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="1717" height="916" fill="url(#bg)"/>
  <g font-family="${font}">
    <text x="858.5" y="92" text-anchor="middle" fill="#071225" font-size="56" font-weight="950">LCX Agent：Harness + Hermes 研究系统</text>
    <text x="858.5" y="138" text-anchor="middle" fill="#51606f" font-size="24" font-weight="760">约束验收层 + 消息证据流 + 飞书控制室 + 本地大脑 + 低频金融研究</text>
  </g>
  <g filter="url(#shadow)">${cards}</g>
  <g font-family="${font}">
    <rect x="54" y="684" width="1609" height="146" rx="30" fill="#ffffff" stroke="#cfe0f6" stroke-width="2"/>
    <text x="858.5" y="732" text-anchor="middle" fill="#0b3b86" font-size="30" font-weight="900">核心边界</text>
    <rect x="90" y="760" width="350" height="46" rx="18" fill="#eff6ff" stroke="#bfd7ff"/>
    <text x="265" y="791" text-anchor="middle" fill="#123a7a" font-size="22" font-weight="850">研究系统，不是交易执行</text>
    <rect x="474" y="760" width="274" height="46" rx="18" fill="#effbf2" stroke="#bee8c8"/>
    <text x="611" y="791" text-anchor="middle" fill="#14532d" font-size="22" font-weight="850">Feishu = Lark</text>
    <rect x="782" y="760" width="350" height="46" rx="18" fill="#fff7e6" stroke="#f5d08a"/>
    <text x="957" y="791" text-anchor="middle" fill="#7a4a00" font-size="22" font-weight="850">dev-fixed ≠ live-fixed</text>
    <rect x="1166" y="760" width="460" height="46" rx="18" fill="#f5f3ff" stroke="#d8ccff"/>
    <text x="1396" y="791" text-anchor="middle" fill="#4c1d95" font-size="22" font-weight="850">底层 runtime 不是主叙事</text>
  </g>
</svg>`;
}

const boardCards = [
  ["Harness", "约束与验收", "权限、风险、测试、eval、live 验收", "#1557c0", "#edf4ff"],
  ["Hermes", "消息与证据流", "上下文、handoff、receipt、review artifact", "#0f8a9d", "#ecfbff"],
  ["飞书控制室", "自然语言入口", "一个主入口承接研究、学习、运维和审计", "#6a45c9", "#f4f0ff"],
  ["本地大脑", "学习沉淀", "吸收蒸馏样本、能力卡和修正笔记", "#15803d", "#effbf2"],
  ["金融研究", "research-only", "ETF、主要资产、头部公司、风险门控", "#b66a00", "#fff8e8"],
  ["Runtime", "底层执行", "gateway、channel、session、CLI、工具调用", "#be123c", "#fff1f2"],
];

function boardSvg() {
  const cardMarkup = boardCards
    .map(([title, tag, detail, color, bg], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = 96 + col * 486;
      const y = 224 + row * 178;
      return `<g>
        <rect x="${x}" y="${y}" width="430" height="136" rx="24" fill="${bg}" stroke="${color}" stroke-opacity="0.28" stroke-width="2"/>
        <circle cx="${x + 38}" cy="${y + 42}" r="18" fill="${color}"/>
        <text x="${x + 68}" y="${y + 47}" fill="${color}" font-size="25" font-weight="950">${xml(title)}</text>
        <text x="${x + 28}" y="${y + 84}" fill="#071225" font-size="21" font-weight="900">${xml(tag)}</text>
        <text x="${x + 28}" y="${y + 114}" fill="#51606f" font-size="16" font-weight="760">${xml(detail)}</text>
      </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="760" viewBox="0 0 1600 760" role="img" aria-labelledby="title desc">
  <title id="title">LCX Agent 能力看板</title>
  <desc id="desc">LCX Agent 的 Harness、Hermes、控制室、本地大脑、研究工作流和底层 runtime。</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7fbff"/>
      <stop offset="0.55" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f3fff7"/>
    </linearGradient>
    <filter id="shadow" x="-12%" y="-12%" width="124%" height="136%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#102030" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="1600" height="760" rx="44" fill="url(#background)"/>
  <rect x="48" y="42" width="1504" height="674" rx="38" fill="#ffffff" opacity="0.96" filter="url(#shadow)"/>
  <g font-family="${font}">
    <text x="96" y="112" fill="#071225" font-size="54" font-weight="950">LCX Agent 架构哲学</text>
    <text x="98" y="152" fill="#51606f" font-size="22" font-weight="760">Harness 约束验收，Hermes 传递证据，本地大脑沉淀长期经验。</text>
    <rect x="1100" y="78" width="356" height="96" rx="26" fill="#071225"/>
    <text x="1128" y="114" fill="#cfe3ff" font-size="15" font-weight="900">CURRENT MODE</text>
    <text x="1128" y="154" fill="#ffffff" font-size="31" font-weight="950">Baseline Hardening</text>
    ${cardMarkup}
    <rect x="96" y="602" width="1408" height="72" rx="24" fill="#f8fbff" stroke="#d5e4f7" stroke-width="2"/>
    <text x="128" y="647" fill="#0b3b86" font-size="24" font-weight="950">验证边界：</text>
    <text x="260" y="647" fill="#273445" font-size="23" font-weight="850">底层 runtime 支撑通道和工具；产品主线是 Harness、Hermes、记忆和研究闭环。</text>
  </g>
</svg>
`;
}

await sharp(Buffer.from(architectureSvg())).png().toFile(architecturePath);
console.log(`wrote ${architecturePath}`);

const board = boardSvg();
for (const outputPath of boardPaths) {
  writeFileSync(outputPath, board);
  console.log(`wrote ${outputPath}`);
}
