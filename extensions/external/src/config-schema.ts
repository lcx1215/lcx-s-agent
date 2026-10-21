import { buildChannelConfigSchema } from "lcx-agent/plugin-sdk";
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
    inboundAuth: z.enum(["token", "none"]).optional(),
    inboundToken: buildSecretInputSchema().optional(),
    inboundTokenHeader: z.string().min(1).optional(),
    outboundUrl: z
      .string()
      .url()
      .refine(
        (value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "outboundUrl must use HTTP or HTTPS",
        },
      )
      .optional(),
    outboundAuth: z.enum(["bearer", "header", "none"]).optional(),
    outboundToken: buildSecretInputSchema().optional(),
    outboundTokenHeader: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    textChunkLimit: z.number().int().positive().max(100_000).optional(),
    dmPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), ExternalGroupConfigSchema).optional(),
  })
  .strict();

function validateExternalAccount(
  value: z.infer<typeof ExternalAccountSchemaBase>,
  ctx: z.RefinementCtx,
  pathPrefix: string,
  issuePrefix: PropertyKey[] = [],
) {
  if ((value.inboundAuth ?? "token") === "token" && !hasConfiguredSecretInput(value.inboundToken)) {
    ctx.addIssue({
      code: "custom",
      path: [...issuePrefix, "inboundToken"],
      message: `${pathPrefix}.inboundAuth="token" requires inboundToken`,
    });
  }
  if ((value.outboundAuth ?? "none") !== "none" && !hasConfiguredSecretInput(value.outboundToken)) {
    ctx.addIssue({
      code: "custom",
      path: [...issuePrefix, "outboundToken"],
      message: `${pathPrefix}.outboundAuth requires outboundToken`,
    });
  }
  if (
    value.dmPolicy === "open" &&
    !value.allowFrom?.some((entry) => String(entry).trim() === "*")
  ) {
    ctx.addIssue({
      code: "custom",
      path: [...issuePrefix, "allowFrom"],
      message: `${pathPrefix}.dmPolicy="open" requires allowFrom to include "*"`,
    });
  }
}

export const ExternalConfigSchema = ExternalAccountSchemaBase.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), ExternalAccountSchemaBase.optional()).optional(),
}).superRefine((value, ctx) => {
  // Account-only configurations intentionally leave the top-level account
  // empty. Apply defaults only in the resolver so child fields remain true overrides.
  if (!value.accounts || Object.keys(value.accounts).length === 0) {
    validateExternalAccount(value, ctx, "channels.external");
    return;
  }
  const { accounts, defaultAccount: _defaultAccount, ...base } = value;
  for (const [accountId, account] of Object.entries(accounts)) {
    validateExternalAccount(
      { ...base, ...account },
      ctx,
      `channels.external.accounts.${accountId}`,
      ["accounts", accountId],
    );
  }
});

export const ExternalChannelConfigSchema = buildChannelConfigSchema(ExternalConfigSchema);
