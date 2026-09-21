// Read-only probe: enumerate duplicated string-literal tables inside ui/src,
// and list numeric bound reads (`?? <number>`) that could be degenerate.
import fs from "node:fs";
import path from "node:path";

const ROOT = "ui/src";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "styles") {
        continue;
      }
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);

// ---- 1. duplicated string-literal tables -------------------------------------
const tableRe = /(?:new Set(?:<[^>]*>)?\(\s*)?\[((?:\s*"[^"]*"\s*,?)+)\s*\]/g;
const tables = new Map(); // canonical key -> [{file,line,raw}]

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  let m;
  tableRe.lastIndex = 0;
  while ((m = tableRe.exec(src)) !== null) {
    const items = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (items.length < 3) {
      continue;
    }
    const key = [...items].toSorted().join("\u0000");
    const line = src.slice(0, m.index).split("\n").length;
    if (!tables.has(key)) {
      tables.set(key, []);
    }
    tables.get(key).push({ file, line, items, text: (lines[line - 1] ?? "").trim() });
  }
}

console.log("=== duplicated string-literal tables (>=3 items, same set, 2+ sites) ===");
let dupCount = 0;
for (const sites of tables.values()) {
  if (sites.length < 2) {
    continue;
  }
  dupCount += 1;
  console.log(`\n[${sites.length} sites] {${sites[0].items.join(", ")}}`);
  for (const s of sites) {
    console.log(`   ${s.file}:${s.line}  ${s.text.slice(0, 110)}`);
  }
}
if (dupCount === 0) {
  console.log("(none)");
}
console.log(`\ntotal duplicated table groups: ${dupCount}`);

// ---- 2. numeric bound reads ---------------------------------------------------
const BOUND_RE = /\?\?\s*(-?\d[\d_]*)\b|\?\?\s*(Number\.[A-Z]+|\d[\d_]*\s*[*+]\s*[\w.]+)/g;
const BOUNDISH =
  /(limit|max|min|size|count|capacity|interval|timeout|ttl|budget|threshold|width|height|depth|retry|attempts|batch|window|keep|entries)/i;

console.log("\n=== numeric fallbacks on bound-like identifiers ===");
const hits = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!/\?\?/.test(line)) {
      return;
    }
    if (!BOUNDISH.test(line)) {
      return;
    }
    const m = line.match(BOUND_RE);
    if (!m) {
      return;
    }
    hits.push({ file, line: i + 1, text: line.trim() });
  });
}
for (const h of hits) {
  console.log(`${h.file}:${h.line}\n   ${h.text.slice(0, 160)}`);
}
console.log(`\ntotal bound-like numeric fallbacks: ${hits.length}`);
