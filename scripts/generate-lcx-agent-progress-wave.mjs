#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const outputPaths = [
  "docs/assets/lcx-agent-daily-progress-wave.svg",
  "docs/assets/lobster-daily-progress-wave.svg",
];
const now = new Date();
const dayMs = 24 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

const days = Array.from({ length: 7 }, (_, index) => {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (6 - index) * dayMs,
  );
  return {
    date,
    iso: isoDay(date),
    label: formatter.format(date),
    commits: 0,
    lark: 0,
    docs: 0,
    learning: 0,
    live: 0,
    evals: 0,
  };
});

const byIso = new Map(days.map((day) => [day.iso, day]));
const since = days[0].iso;
const rawLog = git(["log", `--since=${since}T00:00:00Z`, "--date=short", "--format=%ad%x09%s"]);

if (rawLog) {
  for (const line of rawLog.split("\n")) {
    const [date, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    const day = byIso.get(date);
    if (!day) {
      continue;
    }

    const lowered = subject.toLowerCase();
    day.commits += 1;
    if (/(feishu|lark|control-room|reply|auto-reply|language|interface)/i.test(subject)) {
      day.lark += 1;
    }
    if (/(docs|readme|diagram|graphic|runbook|asset|wave)/i.test(subject)) {
      day.docs += 1;
    }
    if (/(memory|learn|learning|artifact|anchor|finance|capability|brain)/i.test(subject)) {
      day.learning += 1;
    }
    if (/(infra|runtime|gateway|probe|launchd|cloudflared|cron|live|bridge)/i.test(subject)) {
      day.live += 1;
    }
    if (/(test|verify|regression|coverage|eval|gate)/i.test(lowered)) {
      day.evals += 1;
    }
  }
}

const totalCommits = days.reduce((sum, day) => sum + day.commits, 0);
const maxCommits = Math.max(1, ...days.map((day) => day.commits));
const activeDays = days.filter((day) => day.commits > 0).length;
const updated = isoDay(now);
const topDay = days.reduce((best, day) => (day.commits > best.commits ? day : best), days[0]);

const categories = [
  {
    label: "Lark interface",
    value: days.reduce((sum, day) => sum + day.lark, 0),
    color: "#ef5d4e",
    bg: "#fff0ec",
    detail: "intent families, replies, control room",
  },
  {
    label: "Learning brain",
    value: days.reduce((sum, day) => sum + day.learning, 0),
    color: "#2eb872",
    bg: "#ecfbf2",
    detail: "capabilities, memory, finance lessons",
  },
  {
    label: "Runbooks",
    value: days.reduce((sum, day) => sum + day.docs, 0),
    color: "#2f91e8",
    bg: "#eef7ff",
    detail: "README, docs, handoff artifacts",
  },
  {
    label: "Live bridge",
    value: days.reduce((sum, day) => sum + day.live, 0),
    color: "#d79a1f",
    bg: "#fff7dd",
    detail: "gateway, probes, runtime receipts",
  },
  {
    label: "Eval gates",
    value: days.reduce((sum, day) => sum + day.evals, 0),
    color: "#8067d8",
    bg: "#f2efff",
    detail: "tests, regression, verification",
  },
];

const x0 = 188;
const yBase = 452;
const chartWidth = 880;
const step = chartWidth / 6;
const chartHeight = 190;
const points = days.map((day, index) => {
  const normalized = day.commits / maxCommits;
  const y = yBase - 38 - normalized * chartHeight;
  return {
    ...day,
    x: x0 + step * index,
    y,
    barHeight: 42 + normalized * 174,
  };
});

const pointPath = points
  .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
  .join(" ");

const chartColors = ["#ffe4dc", "#e5f4ff", "#e8f9ed", "#fff3cf", "#eee9ff", "#dcf8ef", "#ffe3ee"];
const barSvg = points
  .map((point, index) => {
    const barWidth = 72;
    const barX = point.x - barWidth / 2;
    const barY = yBase - point.barHeight;
    return `
      <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth}" height="${point.barHeight.toFixed(1)}" rx="22" fill="${chartColors[index]}" stroke="#ffffff" stroke-width="3"/>
      <text x="${point.x.toFixed(1)}" y="496" text-anchor="middle" fill="#475b66" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="850">${point.label}</text>
      <text x="${point.x.toFixed(1)}" y="522" text-anchor="middle" fill="#8b9aa3" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="750">${point.iso.slice(5)}</text>`;
  })
  .join("");

const valueLabelSvg = points
  .map((point, index) => {
    const label = String(point.commits);
    const width = Math.max(42, 22 + label.length * 13);
    const height = 30;
    const isHighPoint = point.y < yBase - 128;
    const isLastPoint = index === points.length - 1;
    const x = isHighPoint
      ? isLastPoint
        ? point.x - width - 28
        : point.x + 30
      : point.x - width / 2;
    const y = isHighPoint ? point.y + 20 : point.y - 50;
    return `
      <g>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width}" height="${height}" rx="15" fill="#ffffff" stroke="#d9e5ec" stroke-width="2"/>
        <text x="${(x + width / 2).toFixed(1)}" y="${(y + 21).toFixed(1)}" text-anchor="middle" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="950">${label}</text>
      </g>`;
  })
  .join("");

function moduleCard(category, index) {
  const x = 1148;
  const y = 246 + index * 62;
  return `
    <g>
      <rect x="${x}" y="${y}" width="314" height="58" rx="18" fill="${category.bg}" stroke="${category.color}" stroke-opacity="0.25"/>
      <circle cx="${x + 28}" cy="${y + 29}" r="8" fill="${category.color}"/>
      <text x="${x + 48}" y="${y + 25}" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="900">${xml(category.label)} · ${category.value}</text>
      <text x="${x + 48}" y="${y + 45}" fill="#667780" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="700">${xml(category.detail)}</text>
    </g>`;
}

const moduleCards = categories.map(moduleCard).join("");

const bottomLabels = [
  ["Lark understands", "route language into work families"],
  ["Brain learns", "retain reusable capability cards"],
  ["Finance applies", "answer research-only with risk gates"],
  ["Live proves", "separate dev-fixed from live-fixed"],
];

const bottomPills = bottomLabels
  .map(([label, detail], index) => {
    const x = 88 + index * 368;
    return `
      <g>
        <rect x="${x}" y="594" width="326" height="58" rx="22" fill="#ffffff" stroke="#e0e8ee"/>
        <text x="${x + 24}" y="619" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="950">${xml(label)}</text>
        <text x="${x + 24}" y="641" fill="#697b84" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="750">${xml(detail)}</text>
      </g>`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="720" viewBox="0 0 1600 720" role="img" aria-labelledby="title desc">
  <title id="title">LCX Agent daily progress dashboard</title>
  <desc id="desc">An auto-generated seven day progress dashboard for the Lark interface, learning brain, finance research, live proof, and evaluation gates.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff4ef"/>
      <stop offset="0.46" stop-color="#f5fbff"/>
      <stop offset="1" stop-color="#f4fff3"/>
    </linearGradient>
    <linearGradient id="wave" x1="160" y1="0" x2="1080" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ef5d4e"/>
      <stop offset="0.52" stop-color="#2f91e8"/>
      <stop offset="1" stop-color="#2eb872"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#263238" flood-opacity="0.13"/>
    </filter>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <circle cx="7" cy="9" r="2" fill="#263238" opacity="0.045"/>
      <path d="M30 10 l2.2 4.2 l4.2 2.2 l-4.2 2.2 l-2.2 4.2 l-2.2 -4.2 l-4.2 -2.2 l4.2 -2.2 Z" fill="#ffb84d" opacity="0.13"/>
    </pattern>
  </defs>

  <rect width="1600" height="720" rx="44" fill="url(#bg)"/>
  <rect width="1600" height="720" rx="44" fill="url(#grid)"/>

  <rect x="52" y="46" width="1496" height="616" rx="34" fill="#ffffff" opacity="0.95" filter="url(#shadow)"/>

  <g transform="translate(88 96)">
    <text x="0" y="0" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="52" font-weight="950">LCX Agent</text>
    <text x="2" y="38" fill="#5d707a" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="19" font-weight="700">Lark language interface + learning brain + finance research loop, updated from git history.</text>
  </g>

  <g transform="translate(1042 66)">
    <rect x="0" y="0" width="420" height="94" rx="26" fill="#f7fbff" stroke="#d9e8f2"/>
    <text x="28" y="34" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="15" font-weight="950">last 7 days</text>
    <text x="28" y="74" fill="#ef5d4e" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="42" font-weight="950">${totalCommits}</text>
    <text x="112" y="61" fill="#4c606a" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="850">${activeDays}/7 active days</text>
    <text x="112" y="82" fill="#84949b" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="750">updated ${updated} · peak ${xml(topDay.label)} ${topDay.commits}</text>
  </g>

  <g>
    <rect x="88" y="164" width="1028" height="410" rx="28" fill="#fbfdff" stroke="#e1ebf1"/>
    <text x="124" y="206" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="950">Daily commit wave</text>
    <text x="124" y="232" fill="#73848d" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="750">Progress should show real work: language, learning, live proof, docs, and eval gates.</text>
    <line x1="132" y1="${yBase}" x2="1086" y2="${yBase}" stroke="#dce7ed" stroke-width="2"/>
    <line x1="132" y1="${yBase - 72}" x2="1086" y2="${yBase - 72}" stroke="#edf3f6" stroke-width="2"/>
    <line x1="132" y1="${yBase - 144}" x2="1086" y2="${yBase - 144}" stroke="#edf3f6" stroke-width="2"/>
    <line x1="132" y1="${yBase - 216}" x2="1086" y2="${yBase - 216}" stroke="#edf3f6" stroke-width="2"/>
${barSvg}
    <path d="${pointPath}" fill="none" stroke="url(#wave)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${pointPath}" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.76"/>
    ${points
      .map(
        (point) =>
          `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="12" fill="#ffffff" stroke="#263238" stroke-width="3"/>`,
      )
      .join("")}
${valueLabelSvg}
  </g>

  <g>
    <rect x="1132" y="164" width="350" height="410" rx="28" fill="#fbfdff" stroke="#e1ebf1"/>
    <text x="1164" y="206" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="950">Module lanes</text>
    <text x="1164" y="231" fill="#73848d" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="750">What the repo is actively improving.</text>
${moduleCards}
  </g>

  <g transform="translate(1410 74)">
    <rect x="0" y="0" width="82" height="82" rx="24" fill="#263238"/>
    <text x="41" y="51" text-anchor="middle" fill="#ffffff" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="28" font-weight="950">LCX</text>
    <circle cx="69" cy="15" r="6" fill="#ffcf5a"/>
    <path d="M13 20 l5 9 l9 5 l-9 5 l-5 9 l-5 -9 l-9 -5 l9 -5 Z" fill="#7de0b2" opacity="0.9"/>
  </g>

  <g>
${bottomPills}
  </g>
</svg>
`;

for (const outputPath of outputPaths) {
  writeFileSync(outputPath, svg, "utf8");
}
console.log(`wrote ${outputPaths.join(", ")} from ${totalCommits} commits across ${activeDays} active days`);
