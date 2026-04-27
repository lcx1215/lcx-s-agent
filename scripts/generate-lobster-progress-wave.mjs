#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const outputPath = "docs/assets/lobster-daily-progress-wave.svg";
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
    feishu: 0,
    docs: 0,
    memory: 0,
    infra: 0,
    tests: 0,
  };
});

const byIso = new Map(days.map((day) => [day.iso, day]));
const since = days[0].iso;
const rawLog = git(["log", `--since=${since}T00:00:00Z`, "--date=short", "--format=%ad%x09%s"]);
const subjects = [];

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
    if (/(feishu|lark|control-room|reply|auto-reply)/i.test(subject)) {
      day.feishu += 1;
    }
    if (/(docs|readme|diagram|graphic|runbook)/i.test(subject)) {
      day.docs += 1;
    }
    if (/(memory|learn|learning|artifact|anchor)/i.test(subject)) {
      day.memory += 1;
    }
    if (/(infra|runtime|gateway|probe|launchd|cloudflared|cron)/i.test(subject)) {
      day.infra += 1;
    }
    if (/(test|verify|regression|coverage)/i.test(lowered)) {
      day.tests += 1;
    }
    subjects.push(subject);
  }
}

const totalCommits = days.reduce((sum, day) => sum + day.commits, 0);
const maxCommits = Math.max(1, ...days.map((day) => day.commits));
const activeDays = days.filter((day) => day.commits > 0).length;
const updated = isoDay(now);
const topDay = days.reduce((best, day) => (day.commits > best.commits ? day : best), days[0]);

const categories = {
  "Lark truth": days.reduce((sum, day) => sum + day.feishu, 0),
  Docs: days.reduce((sum, day) => sum + day.docs, 0),
  Memory: days.reduce((sum, day) => sum + day.memory, 0),
  Runtime: days.reduce((sum, day) => sum + day.infra, 0),
  Tests: days.reduce((sum, day) => sum + day.tests, 0),
};

const x0 = 118;
const yBase = 286;
const chartWidth = 900;
const step = chartWidth / 6;
const chartHeight = 150;
const points = days.map((day, index) => {
  const normalized = day.commits / maxCommits;
  const y = yBase - 22 - normalized * chartHeight;
  return {
    ...day,
    x: x0 + step * index,
    y,
    barHeight: 26 + normalized * 126,
  };
});

const pointPath = points
  .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
  .join(" ");

function pill(x, y, label, value, color, bg, width) {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="34" rx="17" fill="${bg}" stroke="${color}" stroke-opacity="0.28"/>
    <circle cx="${x + 22}" cy="${y + 17}" r="6" fill="${color}"/>
    <text x="${x + 38}" y="${y + 22}" fill="#31424c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="800">${xml(label)} ${value}</text>`;
}

const barSvg = points
  .map((point, index) => {
    const colors = ["#ffe1dc", "#dff1ff", "#e7f8eb", "#fff1c5", "#eee7ff", "#ddf8f0", "#ffe0ea"];
    return `
      <rect x="${(point.x - 28).toFixed(1)}" y="${(yBase - point.barHeight).toFixed(1)}" width="56" height="${point.barHeight.toFixed(1)}" rx="14" fill="${colors[index]}" stroke="#ffffff" stroke-width="2"/>
      <text x="${point.x.toFixed(1)}" y="${(yBase - point.barHeight - 11).toFixed(1)}" text-anchor="middle" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="900">${point.commits}</text>
      <text x="${point.x.toFixed(1)}" y="320" text-anchor="middle" fill="#63737c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="800">${point.label}</text>
      <text x="${point.x.toFixed(1)}" y="340" text-anchor="middle" fill="#95a2a8" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="11" font-weight="700">${point.iso.slice(5)}</text>`;
  })
  .join("");

const categoryValues = Object.entries(categories)
  .map(([label, value], index) => {
    const specs = [
      ["#ff7564", "#fff1ed", 162],
      ["#41a7ff", "#eaf6ff", 108],
      ["#47c97b", "#edf9ee", 130],
      ["#f5b83d", "#fff6d8", 128],
      ["#9b83ff", "#f2eeff", 104],
    ];
    const x = 94 + [0, 184, 314, 466, 616][index];
    const [color, bg, width] = specs[index];
    return pill(x, 360, label, value, color, bg, width);
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="430" viewBox="0 0 1200 430" role="img" aria-labelledby="title desc">
  <title id="title">Lobster OpenClaw auto-updating daily progress wave</title>
  <desc id="desc">A cute auto-generated seven day progress chart based on recent git commits.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff5ee"/>
      <stop offset="0.42" stop-color="#f3fbff"/>
      <stop offset="1" stop-color="#f7fff0"/>
    </linearGradient>
    <linearGradient id="wave" x1="100" y1="0" x2="1020" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff6d5c"/>
      <stop offset="0.5" stop-color="#399fff"/>
      <stop offset="1" stop-color="#42c978"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#263238" flood-opacity="0.14"/>
    </filter>
    <pattern id="sparkles" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="5" cy="6" r="2" fill="#263238" opacity="0.05"/>
      <path d="M24 8 l2 4 l4 2 l-4 2 l-2 4 l-2 -4 l-4 -2 l4 -2 Z" fill="#ffb84d" opacity="0.14"/>
    </pattern>
  </defs>

  <rect width="1200" height="430" rx="34" fill="url(#bg)"/>
  <rect width="1200" height="430" rx="34" fill="url(#sparkles)"/>
  <rect x="52" y="42" width="1096" height="342" rx="28" fill="#ffffff" opacity="0.94" filter="url(#shadow)"/>

  <g transform="translate(88 78)">
    <text x="0" y="0" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="35" font-weight="900">Lobster OpenClaw</text>
    <text x="0" y="34" fill="#61727b" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="650">Auto-updating daily progress wave from git history. Build, learn, verify, clean.</text>
  </g>

  <g transform="translate(820 62)">
    <rect x="0" y="0" width="290" height="76" rx="22" fill="#f7fbff" stroke="#d9e8f2"/>
    <text x="24" y="30" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="900">last 7 days</text>
    <text x="24" y="58" fill="#ff6d5c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="30" font-weight="950">${totalCommits}</text>
    <text x="92" y="58" fill="#63737c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="800">commits · ${activeDays}/7 active days · updated ${updated}</text>
  </g>

  <g transform="translate(0 0)">
    <line x1="88" y1="${yBase}" x2="1048" y2="${yBase}" stroke="#dfe8ed" stroke-width="2"/>
    <line x1="88" y1="${yBase - 52}" x2="1048" y2="${yBase - 52}" stroke="#eef3f6" stroke-width="2"/>
    <line x1="88" y1="${yBase - 104}" x2="1048" y2="${yBase - 104}" stroke="#eef3f6" stroke-width="2"/>
    <line x1="88" y1="${yBase - 156}" x2="1048" y2="${yBase - 156}" stroke="#eef3f6" stroke-width="2"/>
${barSvg}
    <path d="${pointPath}" fill="none" stroke="url(#wave)" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${pointPath}" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.74"/>
    ${points
      .map(
        (point) =>
          `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="10" fill="#ffffff" stroke="#263238" stroke-width="3"/>`,
      )
      .join("")}
  </g>

  <g transform="translate(1010 190)">
    <path d="M48 2 C 72 2, 92 20, 92 44 C 92 68, 72 86, 48 86 C 24 86, 4 68, 4 44 C 4 20, 24 2, 48 2 Z" fill="#ff705f" stroke="#3a0a0d" stroke-width="4"/>
    <circle cx="38" cy="37" r="5" fill="#101820"/>
    <circle cx="59" cy="37" r="5" fill="#101820"/>
    <path d="M36 54 C 44 61, 54 61, 62 54" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <path d="M8 39 C -11 27, -8 9, 8 5 C 20 10, 21 27, 8 39 Z" fill="#ff9a83" stroke="#3a0a0d" stroke-width="4"/>
    <path d="M88 39 C 107 27, 104 9, 88 5 C 76 10, 75 27, 88 39 Z" fill="#ff9a83" stroke="#3a0a0d" stroke-width="4"/>
    <text x="-6" y="116" fill="#63737c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="900">peak: ${xml(topDay.label)} · ${topDay.commits}</text>
  </g>

  <g>${categoryValues}</g>
</svg>
`;

writeFileSync(outputPath, svg, "utf8");
console.log(`wrote ${outputPath} from ${totalCommits} commits across ${activeDays} active days`);
