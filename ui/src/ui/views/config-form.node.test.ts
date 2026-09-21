import { describe, expect, it } from "vitest";
import { coerceFormValues } from "../controllers/config/form-coerce.ts";
import { serializeConfigForm } from "../controllers/config/form-utils.ts";
import type { ConfigUiHints } from "../types.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import { renderNode } from "./config-form.node.ts";
import type { JsonSchema } from "./config-form.shared.ts";

/**
 * A `string | SecretRef` field, the shape `buildConfigSchema()` emits for every
 * secret input (`gateway.auth.password`, `models.providers.*.apiKey`, ...).
 * 17 such paths exist in the generated schema; see
 * `ops/probes/secret-ref-form.probe.ts`.
 */
const secretRefVariant: JsonSchema = {
  type: "object",
  properties: {
    source: { type: "string", const: "env" },
    provider: { type: "string" },
    id: { type: "string" },
  },
};

const secretInputSchema: JsonSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            password: {
              anyOf: [{ type: "string" }, { oneOf: [secretRefVariant] }],
            },
          },
        },
      },
    },
  },
};

const HINTS: ConfigUiHints = { "gateway.auth.password": { sensitive: true } };

/** The value `config.get` hands the form: a SecretRef with a redacted id. */
const redactedRef = { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" };

/** Read a lit TemplateResult without a DOM. */
function templateSource(result: unknown): { markup: string; values: unknown[] } {
  const r = result as { strings?: readonly string[]; values?: unknown[] };
  return { markup: (r.strings ?? []).join("\u0001"), values: r.values ?? [] };
}

function renderPassword(value: unknown) {
  return renderNode({
    schema: secretInputSchema.properties!.gateway.properties!.auth.properties!.password,
    value,
    path: ["gateway", "auth", "password"],
    hints: HINTS,
    unsupported: new Set<string>(),
    disabled: false,
    onPatch: () => {},
  });
}

describe("config form: a structured value is never handed to a text input", () => {
  it("reports a SecretRef instead of rendering an editable input", () => {
    const { markup, values } = templateSource(renderPassword(redactedRef));

    expect(markup).not.toContain("<input");
    expect(markup).toContain("Structured value");
    expect(markup).toContain("Raw mode");
    // The reference itself is never echoed back into the page.
    expect(JSON.stringify(values)).not.toContain("__OPENCLAW_REDACTED__");
  });

  it("still renders an editable input for a plain string value", () => {
    const { markup, values } = templateSource(renderPassword("sk-live-123"));

    expect(markup).toContain("<input");
    expect(values).toContain("sk-live-123");
  });

  it("still renders an editable input for an unset field", () => {
    const { markup } = templateSource(renderPassword(undefined));
    expect(markup).toContain("<input");
  });

  it("reports an array value too, since a text input cannot carry it either", () => {
    const { markup } = templateSource(renderPassword(["a", "b"]));
    expect(markup).not.toContain("<input");
    expect(markup).toContain("Structured value");
  });
});

describe("config form: the collapse that produces the structured value", () => {
  it("normalizes the string | SecretRef union down to the string branch", () => {
    const analysis = analyzeConfigSchema(secretInputSchema);
    const node = analysis.schema?.properties?.gateway?.properties?.auth?.properties?.password;

    expect(node?.type).toBe("string");
    expect(node?.anyOf).toBeUndefined();
    expect(node?.oneOf).toBeUndefined();
    // The analyzer does not declare it unsupported, so the field is rendered.
    expect(analysis.unsupportedPaths).toEqual([]);
  });

  it("keeps the object intact while the field is untouched", () => {
    const analysis = analyzeConfigSchema(secretInputSchema);
    const form = { gateway: { auth: { password: redactedRef } } };

    const coerced = coerceFormValues(form, analysis.schema ?? secretInputSchema);
    const submitted = serializeConfigForm(coerced as Record<string, unknown>);

    expect(JSON.parse(submitted).gateway.auth.password).toEqual(redactedRef);
  });

  it("would replace the reference with its string rendering if it were editable", () => {
    // This is the substitution the guard exists to prevent: the value a text
    // input displays, submitted back through the form's own coercion.
    const analysis = analyzeConfigSchema(secretInputSchema);
    // eslint-disable-next-line typescript-eslint/no-base-to-string -- intentional: shows the literal replacement the guard prevents
    const form = { gateway: { auth: { password: String(redactedRef) } } };

    const coerced = coerceFormValues(form, analysis.schema ?? secretInputSchema);
    const submitted = serializeConfigForm(coerced as Record<string, unknown>);

    expect(JSON.parse(submitted).gateway.auth.password).toBe("[object Object]");
  });
});
