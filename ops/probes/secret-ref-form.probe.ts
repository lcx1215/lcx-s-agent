/**
 * Read-only differential probe.
 *
 * Question: for every config path whose JSON Schema accepts `string | SecretRef`,
 * what does the web config form do with it?
 *
 *  - `buildConfigSchema()` produces the authoritative schema the gateway serves
 *    to the UI (`config.schema`).
 *  - `analyzeConfigSchema()` is what the form uses to decide how to render a node.
 *
 * If the form collapses a `string | SecretRef` union to the string branch, then a
 * real SecretRef value (which `redactSecretRefId` preserves as an object with a
 * redacted `id`) is handed to a text input. `renderTextInput` renders
 * `String(value)`, so the field would display "[object Object]".
 */
import { buildConfigSchema } from "../../src/config/schema.js";
import { analyzeConfigSchema } from "../../ui/src/ui/views/config-form.analyze.ts";
import { schemaType, pathKey, type JsonSchema } from "../../ui/src/ui/views/config-form.shared.ts";

const schema = buildConfigSchema({ plugins: [], channels: [] }).schema as JsonSchema;

function isSecretRefVariant(entry: JsonSchema): boolean {
  if (schemaType(entry) !== "object") {
    return false;
  }
  const source = entry.properties?.source;
  const provider = entry.properties?.provider;
  const id = entry.properties?.id;
  if (!source || !provider || !id) {
    return false;
  }
  return (
    typeof source.const === "string" &&
    schemaType(provider) === "string" &&
    schemaType(id) === "string"
  );
}

function isSecretRefUnion(entry: JsonSchema): boolean {
  const variants = entry.oneOf ?? entry.anyOf;
  if (!variants || variants.length === 0) {
    return false;
  }
  return variants.every((v) => isSecretRefVariant(v));
}

type Site = { path: string; node: JsonSchema };

const sites: Site[] = [];
function walk(node: JsonSchema | undefined, path: Array<string | number>) {
  if (!node || typeof node !== "object") {
    return;
  }
  const union = node.anyOf ?? node.oneOf;
  if (union && union.length > 0) {
    const hasString = union.some((v) => schemaType(v) === "string");
    const secretRef = union.filter((v) => isSecretRefUnion(v));
    if (hasString && secretRef.length === 1) {
      sites.push({ path: pathKey(path) || "<root>", node });
    }
  }
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    walk(value, [...path, key]);
  }
  const addl = node.additionalProperties;
  if (addl && typeof addl === "object") {
    walk(addl, [...path, "*"]);
  }
  const items = Array.isArray(node.items) ? node.items[0] : node.items;
  if (items) {
    walk(items, [...path, "*"]);
  }
}

walk(schema, []);

console.log(`secret-ref union sites found in the generated schema: ${sites.length}\n`);

// The value the gateway hands the form for such a path: a redacted SecretRef.
const redactedRef = { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" };

const analysis = analyzeConfigSchema(schema);
const unsupported = new Set(analysis.unsupportedPaths);

let collapsedToText = 0;
let declaredUnsupported = 0;

for (const site of sites) {
  // Re-run the form's own normalizer on a root that contains just this node,
  // so the path label matches and nothing else interferes.
  const wrapper: JsonSchema = {
    type: "object",
    properties: { probe: site.node },
  };
  const res = analyzeConfigSchema(wrapper);
  const normalized = res.schema?.properties?.probe;
  const normalizedType = normalized ? schemaType(normalized) : undefined;
  const stillUnion = Boolean(normalized?.anyOf || normalized?.oneOf);
  // eslint-disable-next-line typescript-eslint/no-base-to-string -- intends to show the literal bad rendering
  const displayed = String(redactedRef);
  const kind =
    normalizedType === "string" && !stillUnion
      ? "TEXT-INPUT (string branch)"
      : stillUnion
        ? "still a union"
        : `type=${String(normalizedType)}`;
  if (normalizedType === "string" && !stillUnion) {
    collapsedToText += 1;
  }
  if (unsupported.has(site.path)) {
    declaredUnsupported += 1;
  }
  console.log(
    `${site.path}\n   normalized -> ${kind}   displayed value -> ${JSON.stringify(displayed)}   in unsupportedPaths: ${unsupported.has(site.path)}`,
  );
}

console.log(
  `\nsummary: ${sites.length} sites; ${collapsedToText} collapse to a plain string input; ` +
    `${declaredUnsupported} are reported as unsupportedPaths.`,
);
console.log(
  // eslint-disable-next-line typescript-eslint/no-base-to-string -- intends to show the literal bad rendering
  `a SecretRef value rendered by that input shows: ${JSON.stringify(String(redactedRef))}`,
);
