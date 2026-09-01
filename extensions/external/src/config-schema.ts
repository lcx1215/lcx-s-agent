import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

const ExternalGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const ExternalAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    defaultTo: z.string().optional(),
    webhookPath: z.string().optional(),
    inboundAuth: z.enum(["token", "none"]).optional().default("token"),
    inboundToken: buildSecretInputSchema().optional(),
    inboundTokenHeader: z.string().min(1).optional().default("authorization"),
    outboundUrl: z.string().url().optional(),
    outboundAuth: z.enum(["bearer", "header", "none"]).optional().default("none"),
    outboundToken: buildSecretInputSchema().optional(),
    outboundTokenHeader: z.string().min(1).optional().default("x-external-channel-token"),
    timeoutMs: z.number().int().positive().max(120_000).optional().default(10_000),
    textChunkLimit: z.number().int().positive().max(100_000).optional().default(4_000),
    dmPolicy: z.enum(["allowlist", "open", "disabled"]).optional().default("allowlist"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), ExternalGroupConfigSchema).optional(),
  })
  .strict();

function validateExternalAccount(
  value: z.infer<typeof ExternalAccountSchemaBase>,
  ctx: z.RefinementCtx,
  pathPrefix: string,
) {
  if (value.inboundAuth === "token" && !hasConfiguredSecretInput(value.inboundToken)) {
    ctx.addIssue({
      code: "custom",
      path: ["inboundToken"],
      message: `${pathPrefix}.inboundAuth="token" requires inboundToken`,
    });
  }
  if (value.outboundAuth !== "none" && !hasConfiguredSecretInput(value.outboundToken)) {
    ctx.addIssue({
      code: "custom",
      path: ["outboundToken"],
      message: `${pathPrefix}.outboundAuth requires outboundToken`,
    });
  }
  if (
    value.dmPolicy === "open" &&
    !value.allowFrom?.some((entry) => String(entry).trim() === "*")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allowFrom"],
      message: `${pathPrefix}.dmPolicy="open" requires allowFrom to include "*"`,
    });
  }
}

const ExternalAccountSchema = ExternalAccountSchemaBase.superRefine((value, ctx) => {
  validateExternalAccount(value, ctx, "channels.external");
});

export const ExternalConfigSchema = ExternalAccountSchemaBase.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), ExternalAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  // Account-only configurations intentionally leave the top-level account
  // empty. Its defaults are still useful to the resolver, but must not make
  // validation require a duplicate top-level credential.
  if (!value.accounts || Object.keys(value.accounts).length === 0) {
    validateExternalAccount(value, ctx, "channels.external");
  }
});

export const ExternalChannelConfigSchema = buildChannelConfigSchema(ExternalConfigSchema);
