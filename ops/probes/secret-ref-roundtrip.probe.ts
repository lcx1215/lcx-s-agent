import { validateConfigObjectWithPlugins } from "../../src/config/config.js";
import { redactConfigSnapshot } from "../../src/config/redact-snapshot.js";
/**
 * Read-only differential probe: the web config form's round trip for a SecretRef.
 *
 * Chain under test:
 *   config.get  -> redactConfigSnapshot   (SecretRef kept as an object, `id` sentinel)
 *   form render -> analyzeConfigSchema    (union collapsed to the string branch)
 *              -> renderTextInput .value  (String(object) === "[object Object]")
 *   user edit   -> onPatch(path, raw)     (object replaced by a plain string)
 *   config.set  -> restoreRedactedValues  (string is not the sentinel -> no restore)
 *              -> validateConfigObjectWithPlugins (is a plain string accepted?)
 *
 * The question is whether the last step reports an error. If it does not, the
 * user's SecretRef is replaced by the literal text "[object Object]" with no
 * diagnostic anywhere.
 */
import { buildConfigSchema } from "../../src/config/schema.js";
import { coerceFormValues } from "../../ui/src/ui/controllers/config/form-coerce.ts";
import { serializeConfigForm } from "../../ui/src/ui/controllers/config/form-utils.ts";
import { analyzeConfigSchema } from "../../ui/src/ui/views/config-form.analyze.ts";
import type { JsonSchema } from "../../ui/src/ui/views/config-form.shared.ts";

const built = buildConfigSchema({ plugins: [], channels: [] });
const schema = built.schema as JsonSchema;
const uiHints = built.uiHints;

const REF = { source: "env" as const, provider: "default", id: "GATEWAY_PASSWORD" };
const TARGET = "gateway.auth.password";

const baseConfig = {
  gateway: { auth: { password: REF } },
};

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setIn(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const next = cur[segs[i]];
    if (!next || typeof next !== "object") {
      cur[segs[i]] = {};
    }
    cur = cur[segs[i]] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

console.log("=== 1. what config.get hands the form ===");
const snapshot = redactConfigSnapshot(
  {
    valid: true,
    exists: true,
    config: baseConfig,
    parsed: baseConfig,
    raw: JSON.stringify(baseConfig),
    resolved: baseConfig,
  } as never,
  uiHints,
);
const formConfig = snapshot.config as Record<string, unknown>;
const formValue = pick(formConfig, TARGET);
console.log(`   redacted value: ${JSON.stringify(formValue)}`);
console.log(`   still an object: ${typeof formValue === "object" && formValue !== null}`);

console.log("\n=== 2. how the form renders it ===");
const analysis = analyzeConfigSchema(schema);
const node = (() => {
  let cur: JsonSchema | undefined = analysis.schema ?? undefined;
  for (const seg of TARGET.split(".")) {
    cur = cur?.properties?.[seg];
  }
  return cur;
})();
console.log(
  `   normalized schema type: ${String(node?.type)}  anyOf left: ${Boolean(node?.anyOf)}`,
);
console.log(`   input .value would be: ${JSON.stringify(String(formValue))}`);

console.log("\n=== 3. untouched field: does the object survive coerce + serialize? ===");
const untouched = coerceFormValues(formConfig, analysis.schema ?? schema) as Record<
  string,
  unknown
>;
console.log(`   after coerce: ${JSON.stringify(pick(untouched, TARGET))}`);
console.log(`   serialized:   ${serializeConfigForm(untouched).replace(/\s+/g, " ")}`);

console.log("\n=== 4. user edits the field (what onPatch writes) ===");
const edited = JSON.parse(JSON.stringify(formConfig)) as Record<string, unknown>;
setIn(edited, TARGET, String(formValue));
const coercedEdit = coerceFormValues(edited, analysis.schema ?? schema) as Record<string, unknown>;
const submitted = serializeConfigForm(coercedEdit);
console.log(`   submitted:    ${submitted.replace(/\s+/g, " ")}`);

console.log("\n=== 5. does the gateway accept it? (differential on validation issues) ===");
const withRef = validateConfigObjectWithPlugins({
  gateway: { auth: { password: REF } },
} as never);
const withGarbage = validateConfigObjectWithPlugins({
  gateway: { auth: { password: "[object Object]" } },
} as never);

const issuesOf = (r: unknown): string[] =>
  ((r as { issues?: unknown[] }).issues ?? []).map((issue) =>
    JSON.stringify(issue).replace(/\s+/g, " "),
  );

console.log(`   SecretRef      -> ok=${String(withRef.ok)} issues=${issuesOf(withRef).length}`);
for (const i of issuesOf(withRef)) {
  console.log(`        ${i.slice(0, 150)}`);
}
console.log(
  `   "[object Object]" -> ok=${String(withGarbage.ok)} issues=${issuesOf(withGarbage).length}`,
);
for (const i of issuesOf(withGarbage)) {
  console.log(`        ${i.slice(0, 150)}`);
}

const refIssues = new Set(issuesOf(withRef));
const newIssues = issuesOf(withGarbage).filter((i) => !refIssues.has(i));
console.log(
  `\n   verdict: the garbage string introduces ${newIssues.length} new validation issue(s)` +
    (newIssues.length === 0
      ? " -> accepted, so the substitution is silent."
      : " -> rejected, so the user would see an error."),
);
