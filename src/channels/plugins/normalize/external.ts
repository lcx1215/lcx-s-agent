import type { ChatType } from "../../chat-type.js";

/** Decode one routing layer; the remaining conversation ID is opaque. */
export function parseExternalTarget(raw: string): { id: string; kind?: ChatType } | undefined {
  const target = raw
    .trim()
    .replace(/^external:/i, "")
    .trim();
  const prefix = /^(group|room|channel|dm|user|direct|conversation):/i.exec(target);
  const id = (prefix ? target.slice(prefix[0].length) : target).trim();
  if (!id) {
    return undefined;
  }
  const token = prefix?.[1]?.toLowerCase();
  const kind =
    token === "group" || token === "room"
      ? "group"
      : token === "channel"
        ? "channel"
        : token
          ? "direct"
          : undefined;
  return { id, ...(kind ? { kind } : {}) };
}

export function normalizeExternalTarget(raw: string): string | undefined {
  return parseExternalTarget(raw)?.id;
}

/** Persist raw IDs with an explicit kind/escape before they re-enter routing. */
export function formatExternalTarget(id: string, kind: ChatType): string {
  const value = id.trim();
  if (!value) {
    throw new Error("external conversation ID is required");
  }
  return `external:${kind === "direct" ? "conversation" : kind}:${value}`;
}
