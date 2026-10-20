// Shared migration inventory metadata; keep root activation and receipt writers aligned.
export const LCX_IDENTITY_MIGRATION_INVENTORY = "lcx-identity-writer-inventory-v1" as const;

export type LcxIdentityMigrationCompletionMarker = Readonly<{
  schemaVersion: 1;
  canonicalStateDir: string;
  completedAt: string;
  inventory: typeof LCX_IDENTITY_MIGRATION_INVENTORY;
  targetKeys: readonly string[];
}>;

export type LcxIdentityWriterName =
  | "config"
  | "sessions"
  | "credentials"
  | "queues"
  | "backups"
  | "audit"
  | "cron"
  | "device"
  | "device-auth"
  | "node-host"
  | "device-pairing"
  | "device-pair-notify"
  | "node-pairing"
  | "exec-approvals"
  | "restart-sentinel"
  | "subagents"
  | "workspace"
  | "nostr-bus"
  | "nostr-profile"
  | "discord-bindings"
  | "discord-model-picker"
  | "telegram-offset"
  | "telegram-sticker-cache"
  | "update-check"
  | "voicewake"
  | "matrix-storage"
  | "channel-local"
  | "channel-pairing"
  | "phone-control";

export const LCX_IDENTITY_WRITER_NAMES: readonly LcxIdentityWriterName[] = [
  "config",
  "sessions",
  "credentials",
  "queues",
  "backups",
  "audit",
  "cron",
  "device",
  "device-auth",
  "node-host",
  "device-pairing",
  "device-pair-notify",
  "node-pairing",
  "exec-approvals",
  "restart-sentinel",
  "subagents",
  "workspace",
  "nostr-bus",
  "nostr-profile",
  "discord-bindings",
  "discord-model-picker",
  "telegram-offset",
  "telegram-sticker-cache",
  "update-check",
  "voicewake",
  "matrix-storage",
  "channel-local",
  "channel-pairing",
  "phone-control",
];
