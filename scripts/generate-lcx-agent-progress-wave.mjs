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

function subjectMatches(subject, pattern) {
  return pattern.test(subject);
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
    if (
      subjectMatches(subject, /(feishu|lark|control-room|reply|auto-reply|language|interface)/i)
    ) {
      day.lark += 1;
    }
    if (subjectMatches(subject, /(docs|readme|diagram|graphic|runbook|asset|wave|visual)/i)) {
      day.docs += 1;
    }
    if (
      subjectMatches(subject, /(memory|learn|learning|artifact|anchor|finance|capability|brain)/i)
    ) {
      day.learning += 1;
    }
    if (
      subjectMatches(subject, /(infra|runtime|gateway|probe|launchd|cloudflared|cron|live|bridge)/i)
    ) {
      day.live += 1;
    }
    if (subjectMatches(lowered, /(test|verify|regression|coverage|eval|gate|health)/i)) {
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
    label: "Lark",
    title: "Language interface",
    value: days.reduce((sum, day) => sum + day.lark, 0),
    color: "#f06449",
    bg: "#fff1ed",
  },
  {
    label: "Brain",
    title: "Learning system",
    value: days.reduce((sum, day) => sum + day.learning, 0),
    color: "#18a66a",
    bg: "#ecfbf2",
  },
  {
    label: "Docs",
    title: "README + runbooks",
    value: days.reduce((sum, day) => sum + day.docs, 0),
    color: "#238be6",
    bg: "#eef7ff",
  },
  {
    label: "Live",
    title: "Runtime proof",
    value: days.reduce((sum, day) => sum + day.live, 0),
    color: "#d78a16",
    bg: "#fff7dd",
  },
  {
    label: "Eval",
    title: "Tests + gates",
    value: days.reduce((sum, day) => sum + day.evals, 0),
    color: "#765bd8",
    bg: "#f3efff",
  },
];

const chartX = 96;
const chartY = 286;
const chartWidth = 968;
const chartHeight = 268;
const chartBase = chartY + chartHeight;
const dayCardWidth = 124;
const dayStep = chartWidth / 7;

const points = days.map((day, index) => {
  const normalized = day.commits / maxCommits;
  const x = chartX + dayStep * index + dayStep / 2;
  const barHeight = 22 + normalized * 210;
  const y = chartBase - barHeight;
  return { ...day, x, y, barHeight, normalized };
});

const smoothPath = points
  .map((point, index) => {
    if (index === 0) {
      return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }
    const prev = points[index - 1];
    const midX = (prev.x + point.x) / 2;
    return `C ${midX.toFixed(1)} ${prev.y.toFixed(1)}, ${midX.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  })
  .join(" ");

const areaPath = `${smoothPath} L ${points.at(-1).x.toFixed(1)} ${chartBase} L ${points[0].x.toFixed(1)} ${chartBase} Z`;

const dayCards = points
  .map((point, index) => {
    const x = chartX + dayStep * index + (dayStep - dayCardWidth) / 2;
    const isPeak = point.iso === topDay.iso && point.commits > 0;
    return `
      <g>
        <rect x="${x.toFixed(1)}" y="172" width="${dayCardWidth}" height="82" rx="24" fill="${isPeak ? "#263238" : "#ffffff"}" stroke="${isPeak ? "#263238" : "#dfe9ef"}" stroke-width="2"/>
        <text x="${(x + 18).toFixed(1)}" y="202" fill="${isPeak ? "#ffffff" : "#51626b"}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="900">${xml(point.label)}</text>
        <text x="${(x + 18).toFixed(1)}" y="232" fill="${isPeak ? "#ffcf5c" : "#f06449"}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="31" font-weight="950">${point.commits}</text>
        <text x="${(x + dayCardWidth - 18).toFixed(1)}" y="232" text-anchor="end" fill="${isPeak ? "#c9d6dc" : "#8a9aa3"}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="800">${point.iso.slice(5)}</text>
      </g>`;
  })
  .join("");

const bars = points
  .map((point, index) => {
    const colors = ["#ffd9cf", "#def1ff", "#dff7e8", "#fff0c2", "#ece7ff", "#d8f7ec", "#ffddeb"];
    const barWidth = 86;
    return `
      <rect x="${(point.x - barWidth / 2).toFixed(1)}" y="${point.y.toFixed(1)}" width="${barWidth}" height="${point.barHeight.toFixed(1)}" rx="26" fill="${colors[index]}" stroke="#ffffff" stroke-width="4"/>
      <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="14" fill="#ffffff" stroke="#263238" stroke-width="3"/>
      <text x="${point.x.toFixed(1)}" y="${(chartBase + 36).toFixed(1)}" text-anchor="middle" fill="#52666f" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="900">${xml(point.label)}</text>`;
  })
  .join("");

const moduleCards = categories
  .map((category, index) => {
    const x = 1118 + (index % 2) * 184;
    const y = 286 + Math.floor(index / 2) * 104;
    const width = index === 4 ? 372 : 168;
    return `
      <g>
        <rect x="${x}" y="${y}" width="${width}" height="82" rx="24" fill="${category.bg}" stroke="${category.color}" stroke-opacity="0.28" stroke-width="2"/>
        <text x="${x + 22}" y="${y + 30}" fill="${category.color}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="15" font-weight="950">${xml(category.label)}</text>
        <text x="${x + 22}" y="${y + 58}" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="30" font-weight="950">${category.value}</text>
        <text x="${x + 70}" y="${y + 56}" fill="#667780" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="800">${xml(category.title)}</text>
      </g>`;
  })
  .join("");

const bottomItems = [
  ["Understand", "natural language into families"],
  ["Learn", "capability cards and notes"],
  ["Verify", "tests, receipts, live probes"],
  ["Remember", "durable artifacts over chat"],
];

const bottomBand = bottomItems
  .map(([label, detail], index) => {
    const x = 96 + index * 366;
    return `
      <g>
        <rect x="${x}" y="616" width="322" height="78" rx="26" fill="#ffffff" stroke="#dfe9ef" stroke-width="2"/>
        <circle cx="${x + 34}" cy="655" r="12" fill="${["#f06449", "#18a66a", "#765bd8", "#238be6"][index]}"/>
        <text x="${x + 58}" y="648" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="20" font-weight="950">${xml(label)}</text>
        <text x="${x + 58}" y="674" fill="#6e7f88" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="800">${xml(detail)}</text>
      </g>`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="760" viewBox="0 0 1600 760" role="img" aria-labelledby="title desc">
  <title id="title">LCX Agent daily progress board</title>
  <desc id="desc">An auto-generated seven day progress board showing commit activity and work lanes for LCX Agent.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff3ed"/>
      <stop offset="0.52" stop-color="#f5fbff"/>
      <stop offset="1" stop-color="#effff4"/>
    </linearGradient>
    <linearGradient id="wave" x1="${chartX}" y1="0" x2="${chartX + chartWidth}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f06449"/>
      <stop offset="0.48" stop-color="#238be6"/>
      <stop offset="1" stop-color="#18a66a"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="${chartY}" x2="0" y2="${chartBase}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#238be6" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#238be6" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#23323a" flood-opacity="0.14"/>
    </filter>
    <pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse">
      <circle cx="8" cy="9" r="2" fill="#263238" opacity="0.045"/>
    </pattern>
  </defs>

  <rect width="1600" height="760" rx="48" fill="url(#background)"/>
  <rect width="1600" height="760" rx="48" fill="url(#dots)"/>
  <rect x="48" y="42" width="1504" height="674" rx="38" fill="#ffffff" opacity="0.96" filter="url(#shadow)"/>

  <g transform="translate(96 94)">
    <text x="0" y="0" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="58" font-weight="950">LCX Agent Progress</text>
    <text x="2" y="42" fill="#5d707a" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="20" font-weight="780">Language · learning · finance · live proof · eval gates.</text>
  </g>

  <g transform="translate(1118 72)">
    <rect x="0" y="0" width="378" height="116" rx="30" fill="#263238"/>
    <text x="28" y="34" fill="#d8e6ec" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="15" font-weight="950">LAST 7 DAYS</text>
    <text x="28" y="88" fill="#ffcf5c" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="54" font-weight="950">${totalCommits}</text>
    <text x="146" y="67" fill="#ffffff" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="20" font-weight="950">${activeDays}/7 active days</text>
    <text x="146" y="91" fill="#b7c9d0" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="800">updated ${updated} · peak ${xml(topDay.label)} ${topDay.commits}</text>
  </g>

  ${dayCards}

  <g>
    <rect x="72" y="270" width="1020" height="326" rx="32" fill="#fbfdff" stroke="#e1ebf1" stroke-width="2"/>
    <text x="108" y="316" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="24" font-weight="950">Seven-day work wave</text>
    <text x="108" y="344" fill="#73848d" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="800">Numbers live in the day cards above; this chart keeps the motion clean.</text>
    <line x1="${chartX}" y1="${chartBase}" x2="${chartX + chartWidth}" y2="${chartBase}" stroke="#dce7ed" stroke-width="2"/>
    <line x1="${chartX}" y1="${chartBase - 70}" x2="${chartX + chartWidth}" y2="${chartBase - 70}" stroke="#edf3f6" stroke-width="2"/>
    <line x1="${chartX}" y1="${chartBase - 140}" x2="${chartX + chartWidth}" y2="${chartBase - 140}" stroke="#edf3f6" stroke-width="2"/>
    <line x1="${chartX}" y1="${chartBase - 210}" x2="${chartX + chartWidth}" y2="${chartBase - 210}" stroke="#edf3f6" stroke-width="2"/>
    <path d="${areaPath}" fill="url(#area)"/>
    ${bars}
    <path d="${smoothPath}" fill="none" stroke="url(#wave)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${smoothPath}" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.78"/>
  </g>

  <g>
    <rect x="1096" y="270" width="428" height="326" rx="32" fill="#fbfdff" stroke="#e1ebf1" stroke-width="2"/>
    <text x="1128" y="316" fill="#263238" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="24" font-weight="950">Work lanes</text>
    <text x="1128" y="344" fill="#73848d" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="800">Auto-counted from commit messages.</text>
    ${moduleCards}
  </g>

  ${bottomBand}
</svg>
`;

for (const outputPath of outputPaths) {
  writeFileSync(outputPath, svg.replace(/[ \t]+$/gmu, ""), "utf8");
}
