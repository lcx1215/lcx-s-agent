// Select a semantic predecessor from LCX's own published versions.
const parse = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (match?.[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
    return null;
  }
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") } : null;
};
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] < b.core[i] ? -1 : 1;
    }
  }
  if (!a.pre || !b.pre) {
    return a.pre ? -1 : b.pre ? 1 : 0;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) {
      continue;
    }
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      return BigInt(x) < BigInt(y) ? -1 : 1;
    }
    if (xn !== yn) {
      return xn ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
};
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const candidate = parse(process.argv[2]);
    if (!candidate) {
      throw new Error("invalid_candidate");
    }
    const raw = JSON.parse(input);
    const versions = (Array.isArray(raw) ? raw : [raw])
      .map((value) => ({ value, version: parse(value) }))
      .filter((entry) => entry.version && compare(entry.version, candidate) < 0)
      .toSorted((a, b) => compare(a.version, b.version));
    const previous = versions.at(-1);
    if (!previous) {
      throw new Error("no_predecessor");
    }
    process.stdout.write(previous.value);
  } catch {
    process.stderr.write("no_valid_prior_lcx_version\n");
    process.exitCode = 1;
  }
});
