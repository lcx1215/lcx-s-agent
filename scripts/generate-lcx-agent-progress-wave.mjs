#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const outputPaths = [
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

const cards = [
  ["飞书控制室", "自然语言入口", "一个主入口承接研究、学习、运维和审计请求", "#1557c0", "#edf4ff"],
  ["任务路由", "模块化拆解", "大模型先拆任务，本地规则守边界", "#0f8a9d", "#ecfbff"],
  ["本地大脑", "学习沉淀", "吸收蒸馏样本和 review artifact", "#15803d", "#effbf2"],
  ["证据审计", "truth surface", "区分 searched、learned、written、dev/live", "#6a45c9", "#f4f0ff"],
  ["金融研究", "research-only", "ETF、主要资产、头部公司、风险门控", "#b66a00", "#fff8e8"],
  ["live 回路", "真实验收", "build、restart、probe、真实 Lark 消息", "#be123c", "#fff1f2"],
];

const cardMarkup = cards
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

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="760" viewBox="0 0 1600 760" role="img" aria-labelledby="title desc">
  <title id="title">LCX Agent 能力看板</title>
  <desc id="desc">LCX Agent 的核心能力、验证边界和当前工程重点。</desc>
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
    <text x="96" y="112" fill="#071225" font-size="54" font-weight="950">LCX Agent 能力看板</text>
    <text x="98" y="152" fill="#51606f" font-size="22" font-weight="760">飞书控制室、Agent 路由、持久记忆、证据审计、金融研究工作流。</text>
    <rect x="1100" y="78" width="356" height="96" rx="26" fill="#071225"/>
    <text x="1128" y="114" fill="#cfe3ff" font-size="15" font-weight="900">CURRENT MODE</text>
    <text x="1128" y="154" fill="#ffffff" font-size="31" font-weight="950">Baseline Hardening</text>
    ${cardMarkup}
    <rect x="96" y="602" width="1408" height="72" rx="24" fill="#f8fbff" stroke="#d5e4f7" stroke-width="2"/>
    <text x="128" y="647" fill="#0b3b86" font-size="24" font-weight="950">验证边界：</text>
    <text x="260" y="647" fill="#273445" font-size="23" font-weight="850">dev-fixed 只代表开发证明；live-fixed 必须经过 build / restart / probe / 真实 Lark 可见回复。</text>
  </g>
</svg>
`;

for (const outputPath of outputPaths) {
  writeFileSync(outputPath, svg);
  console.log(`wrote ${outputPath}`);
}
