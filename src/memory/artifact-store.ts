import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openFileWithinRoot, SafeOpenError } from "../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../infra/path-alias-guards.js";
import { ensureMemoryIndexCoreSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

export const ARTIFACT_TEXT_PREVIEW_MAX_BYTES = 64 * 1024;
export const ARTIFACT_JSON_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const TEXT_LIMIT = ARTIFACT_TEXT_PREVIEW_MAX_BYTES;
type Database = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ArtifactStoreError";
  }
}

export type ArtifactRegistration = Readonly<{
  id: string;
  owner: string;
  runId: string;
  observedAt: string;
  relativePath: string;
  mimeType: string;
  summary: string;
  conclusion?: string;
  cutoff?: string;
  sourceReceiptRefs?: readonly string[];
}>;
export type ArtifactRecord = ArtifactRegistration &
  Readonly<{
    sha256: string;
    bytes: number;
    format: "text" | "binary";
    extractionStatus: "utf8" | "opaque" | "invalid_utf8";
    textTruncated: boolean;
  }>;

function bounded(value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ArtifactStoreError("artifact_metadata_invalid");
  }
  return value;
}
function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ArtifactStoreError("artifact_timestamp_invalid");
  }
  return new Date(value).toISOString();
}
function allowedPath(relativePath: string): string {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > 2048 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
    !(
      relativePath.startsWith("state/") || /^memory\/module-learning-[^/]+\//u.test(relativePath)
    ) ||
    /(?:^|\/)(?:credentials?|auth(?:-profiles)?|provider(?:-config)?|config|protected-memory)(?:[./-]|$)/iu.test(
      relativePath,
    )
  ) {
    throw new ArtifactStoreError("artifact_path_blocked");
  }
  return relativePath;
}
function normalize(input: ArtifactRegistration): ArtifactRegistration {
  if (!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/u.test(input.mimeType) || input.mimeType.length > 160) {
    throw new ArtifactStoreError("artifact_mime_invalid");
  }
  const refs = input.sourceReceiptRefs;
  if (
    refs &&
    (refs.length > 20 || refs.some((ref) => typeof ref !== "string" || !ref || ref.length > 2048))
  ) {
    throw new ArtifactStoreError("artifact_source_refs_invalid");
  }
  return {
    id: bounded(input.id, 240),
    owner: bounded(input.owner, 128),
    runId: bounded(input.runId, 240),
    observedAt: timestamp(input.observedAt),
    relativePath: allowedPath(input.relativePath),
    mimeType: input.mimeType,
    summary: bounded(input.summary, 8192),
    ...(input.conclusion === undefined ? {} : { conclusion: bounded(input.conclusion, 8192) }),
    ...(input.cutoff === undefined ? {} : { cutoff: timestamp(input.cutoff) }),
    ...(refs === undefined ? {} : { sourceReceiptRefs: [...refs] }),
  };
}
async function rejectSymlinkComponents(workspaceDir: string, relativePath: string): Promise<void> {
  let current = workspaceDir;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) {
      throw new ArtifactStoreError("artifact_original_blocked");
    }
  }
}

function encodeCursor(scope: string, observedAt: string, id: string): string {
  const payload = Buffer.from(JSON.stringify([1, scope, observedAt, id])).toString("base64url");
  return `${payload}.${createHash("sha256").update(payload).digest("base64url")}`;
}
function decodeCursor(cursor: string, scope: string): { observedAt: string; id: string } {
  if (
    typeof cursor !== "string" ||
    cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new ArtifactStoreError("artifact_cursor_invalid");
  }
  const [payload, checksum] = cursor.split(".");
  if (createHash("sha256").update(payload).digest("base64url") !== checksum) {
    throw new ArtifactStoreError("artifact_cursor_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url")),
    );
  } catch {
    throw new ArtifactStoreError("artifact_cursor_invalid");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== 1 ||
    value[1] !== scope ||
    typeof value[2] !== "string" ||
    !Number.isFinite(Date.parse(value[2])) ||
    new Date(value[2]).toISOString() !== value[2] ||
    typeof value[3] !== "string" ||
    !value[3].trim() ||
    value[3].length > 240 ||
    Buffer.from(JSON.stringify(value)).toString("base64url") !== payload
  ) {
    throw new ArtifactStoreError("artifact_cursor_invalid");
  }
  return { observedAt: value[2], id: value[3] };
}

function textMime(mime: string): boolean {
  const type = mime.split(";")[0].toLowerCase();
  return (
    type.startsWith("text/") ||
    /^application\/(?:json|[\w.+-]+\+json|(?:x-)?ndjson|jsonl|xml|[\w.+-]+\+xml|javascript)$/u.test(
      type,
    )
  );
}
function decodePrefix(prefix: Buffer, truncated: boolean): string | undefined {
  for (let trim = 0; trim <= (truncated ? 3 : 0); trim++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        prefix.subarray(0, prefix.length - trim),
      );
    } catch {
      /* A bounded prefix can end inside one UTF-8 code point. */
    }
  }
  return undefined;
}

function toolEnvelopeProjection(text: string | undefined): { text?: string; projected: boolean } {
  if (text === undefined || !text.includes('"lcx_agent_artifact_v1"')) {
    return { text, projected: false };
  }
  try {
    const envelope: unknown = JSON.parse(text);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("schemaVersion" in envelope) ||
      envelope.schemaVersion !== "lcx_agent_artifact_v1"
    ) {
      return { text, projected: false };
    }
    const safeValue = (value: unknown, binaryContext = false): unknown => {
      if (Array.isArray(value)) {
        return value.map((item) => safeValue(item, binaryContext));
      }
      if (!value || typeof value !== "object") {
        return value;
      }
      const object = value as Record<string, unknown>;
      const binary =
        binaryContext ||
        ["image", "image_url", "audio", "audio_url", "input_audio", "input_image"].includes(
          String(object.type),
        ) ||
        (typeof object.mimeType === "string" &&
          /^(?:image|audio|video)\/|^application\/(?:pdf|octet-stream)(?:;|$)/iu.test(
            object.mimeType,
          ));
      return Object.fromEntries(
        Object.entries(object)
          .filter(
            ([key]) => !(binary && ["data", "base64", "b64", "url", "image_url"].includes(key)),
          )
          .map(([key, item]) => [key, safeValue(item, binary)]),
      );
    };
    return { text: JSON.stringify(safeValue(envelope)), projected: true };
  } catch {
    // A truncated mixed-media envelope cannot safely identify all binary fields.
    return { projected: true };
  }
}

/** Derived searchable registry in the existing memory SQLite; original files keep their owner. */
export class ArtifactStore {
  private constructor(
    private readonly db: Database,
    private readonly workspaceDir: string,
    private readonly readOnly: boolean,
    private readonly ftsAvailable: boolean,
  ) {}

  static open(params: { dbPath: string; workspaceDir: string; readOnly?: boolean }): ArtifactStore {
    const readOnly = params.readOnly ?? false;
    if (readOnly && !fs.existsSync(params.dbPath)) {
      throw new ArtifactStoreError("artifact_database_missing");
    }
    const { DatabaseSync } = requireNodeSqlite();
    let db: Database | undefined;
    try {
      if (!readOnly) {
        fs.mkdirSync(path.dirname(params.dbPath), { recursive: true, mode: 0o700 });
      }
      db = new DatabaseSync(params.dbPath, { readOnly });
      db.exec("PRAGMA busy_timeout=5000");
      if (!readOnly) {
        ensureMemoryIndexCoreSchema(db);
      } else if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='owner_artifacts' AND type='table'")
          .get()
      ) {
        throw new ArtifactStoreError("artifact_registry_missing");
      }
      let ftsAvailable = false;
      if (!readOnly) {
        try {
          const existed = Boolean(
            db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE name='owner_artifacts_fts' AND type='table'",
              )
              .get(),
          );
          db.exec(
            "CREATE VIRTUAL TABLE IF NOT EXISTS owner_artifacts_fts USING fts5(id UNINDEXED, search_text)",
          );
          if (!existed) {
            // One bootstrap when FTS first becomes available, never a full scan on every open.
            db.exec(
              "INSERT INTO owner_artifacts_fts(id,search_text) SELECT id,search_text FROM owner_artifacts",
            );
          }
          ftsAvailable = true;
        } catch {
          /* Search explicitly reports its LIKE fallback. */
        }
      } else {
        ftsAvailable = Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name='owner_artifacts_fts' AND type='table'",
            )
            .get(),
        );
      }
      return new ArtifactStore(db, fs.realpathSync(params.workspaceDir), readOnly, ftsAvailable);
    } catch (error) {
      db?.close();
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      throw new ArtifactStoreError("artifact_database_unavailable", { cause: error });
    }
  }

  private async inspect(relativePath: string, mimeType: string, textLimit = TEXT_LIMIT) {
    const safePath = allowedPath(relativePath);
    try {
      await assertNoPathAliasEscape({
        absolutePath: path.join(this.workspaceDir, safePath),
        rootPath: this.workspaceDir,
        boundaryLabel: "artifact original",
      });
      await rejectSymlinkComponents(this.workspaceDir, safePath);
      const opened = await openFileWithinRoot({
        rootDir: this.workspaceDir,
        relativePath: safePath,
      });
      try {
        if (
          opened.realPath !== path.join(await fs.promises.realpath(this.workspaceDir), safePath)
        ) {
          throw new ArtifactStoreError("artifact_original_blocked");
        }
        const hash = createHash("sha256");
        const prefixes: Buffer[] = [];
        let bytes = 0;
        let prefixBytes = 0;
        const chunk = Buffer.alloc(64 * 1024);
        while (true) {
          const result = await opened.handle.read(chunk, 0, chunk.length, null);
          if (!result.bytesRead) {
            break;
          }
          const part = chunk.subarray(0, result.bytesRead);
          hash.update(part);
          bytes += part.length;
          if (prefixBytes < textLimit) {
            const head = Buffer.from(part.subarray(0, textLimit - prefixBytes));
            prefixes.push(head);
            prefixBytes += head.length;
          }
        }
        const after = await opened.handle.stat();
        if (
          bytes !== opened.stat.size ||
          after.size !== opened.stat.size ||
          after.mtimeMs !== opened.stat.mtimeMs
        ) {
          throw new ArtifactStoreError("artifact_changed_during_read");
        }
        await assertNoPathAliasEscape({
          absolutePath: path.join(this.workspaceDir, safePath),
          rootPath: this.workspaceDir,
          boundaryLabel: "artifact original",
        });
        await rejectSymlinkComponents(this.workspaceDir, safePath);
        const current = await fs.promises.stat(path.join(this.workspaceDir, safePath));
        if (current.ino !== after.ino || current.dev !== after.dev) {
          throw new ArtifactStoreError("artifact_changed_during_read");
        }
        const truncated = bytes > textLimit;
        const text = textMime(mimeType)
          ? decodePrefix(Buffer.concat(prefixes), truncated)
          : undefined;
        return {
          sha256: hash.digest("hex"),
          bytes,
          format: text === undefined ? ("binary" as const) : ("text" as const),
          extractionStatus:
            text === undefined
              ? textMime(mimeType)
                ? ("invalid_utf8" as const)
                : ("opaque" as const)
              : ("utf8" as const),
          textTruncated: text !== undefined && truncated,
          text,
          originalPath: opened.realPath,
        };
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      const missing =
        (error instanceof SafeOpenError && error.code === "not-found") ||
        (error instanceof Error && "code" in error && error.code === "ENOENT");
      throw new ArtifactStoreError(
        missing ? "artifact_original_missing" : "artifact_original_blocked",
        { cause: error },
      );
    }
  }

  async register(
    input: ArtifactRegistration,
  ): Promise<{ status: "registered" | "unchanged"; artifact: ArtifactRecord }> {
    if (this.readOnly) {
      throw new ArtifactStoreError("artifact_store_read_only");
    }
    const metadata = normalize(input);
    const inspected = await this.inspect(metadata.relativePath, metadata.mimeType);
    const artifact: ArtifactRecord = {
      ...metadata,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
      format: inspected.format,
      extractionStatus: inspected.extractionStatus,
      textTruncated: inspected.textTruncated,
    };
    const encoded = JSON.stringify(artifact);
    const searchText = [
      artifact.owner,
      artifact.runId,
      artifact.summary,
      artifact.conclusion ?? "",
      toolEnvelopeProjection(inspected.text).text ?? "",
    ].join("\n");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT record_json,workspace_root FROM owner_artifacts WHERE id=?")
        .get(artifact.id) as { record_json: string; workspace_root: string } | undefined;
      if (existing) {
        if (existing.record_json !== encoded || existing.workspace_root !== this.workspaceDir) {
          throw new ArtifactStoreError("artifact_identity_conflict");
        }
        this.db.exec("COMMIT");
        return { status: "unchanged", artifact };
      }
      this.db
        .prepare(
          "INSERT INTO owner_artifacts(id,workspace_root,owner,observed_at,cutoff,record_json,search_text) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          artifact.id,
          this.workspaceDir,
          artifact.owner,
          artifact.observedAt,
          artifact.cutoff ?? null,
          encoded,
          searchText,
        );
      if (this.ftsAvailable) {
        this.db
          .prepare("INSERT INTO owner_artifacts_fts(id,search_text) VALUES(?,?)")
          .run(artifact.id, searchText);
      }
      this.db.exec("COMMIT");
      return { status: "registered", artifact };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(params: {
    query?: string;
    owner?: string;
    asOf?: string;
    limit?: number;
    cursor?: string;
  }): {
    artifacts: ArtifactRecord[];
    backend: "fts" | "like" | "browse";
    limitation?: string;
    hasMore: boolean;
    nextCursor: string | null;
  } {
    if (
      params.query !== undefined &&
      (typeof params.query !== "string" || params.query.length > 1000)
    ) {
      throw new ArtifactStoreError("artifact_query_invalid");
    }
    const query = params.query?.trim() ?? "";
    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(params.limit) ? Math.trunc(params.limit!) : 20),
    );
    const asOf = params.asOf === undefined ? null : timestamp(params.asOf);
    const owner = params.owner === undefined ? null : bounded(params.owner, 128);
    // CJK phrases are not segmented by unicode61. Pick a stable substring backend,
    // rather than switching only after a zero-result FTS page.
    const substring =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query) ||
      !/[\p{L}\p{N}]/u.test(query);
    const backend = !query ? "browse" : !substring && this.ftsAvailable ? "fts" : "like";
    const scope = createHash("sha256")
      .update(JSON.stringify([this.workspaceDir, query, owner, asOf, backend]))
      .digest("base64url");
    const cursor = params.cursor === undefined ? undefined : decodeCursor(params.cursor, scope);
    const filters =
      "a.workspace_root=? AND (? IS NULL OR a.owner=?) AND (? IS NULL OR (a.observed_at<=? AND (a.cutoff IS NULL OR a.cutoff<=?)))" +
      (cursor ? " AND (a.observed_at<? OR (a.observed_at=? AND a.id>?))" : "");
    const values = [
      this.workspaceDir,
      owner,
      owner,
      asOf,
      asOf,
      asOf,
      ...(cursor ? [cursor.observedAt, cursor.observedAt, cursor.id] : []),
    ];
    const select = "SELECT a.id,a.observed_at,a.record_json FROM owner_artifacts a";
    const tail = " ORDER BY a.observed_at DESC,a.id ASC LIMIT ?";
    let rows: { id: string; observed_at: string; record_json: string }[];
    if (backend === "fts") {
      const phrase = '"' + query.replaceAll('"', '""') + '"';
      rows = this.db
        .prepare(
          `${select} JOIN owner_artifacts_fts f ON f.id=a.id WHERE owner_artifacts_fts MATCH ? AND ${filters}${tail}`,
        )
        .all(phrase, ...values, limit + 1) as typeof rows;
    } else if (backend === "like") {
      const escaped = query.replace(/[\\%_]/gu, (value) => `\\${value}`);
      rows = this.db
        .prepare(`${select} WHERE ${filters} AND a.search_text LIKE ? ESCAPE '\\'${tail}`)
        .all(...values, `%${escaped}%`, limit + 1) as typeof rows;
    } else {
      rows = this.db
        .prepare(`${select} WHERE ${filters}${tail}`)
        .all(...values, limit + 1) as typeof rows;
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      artifacts: page.map((row) => JSON.parse(row.record_json) as ArtifactRecord),
      backend,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(scope, last.observed_at, last.id) : null,
      ...(backend === "like"
        ? {
            limitation: substring
              ? "artifact_substring_search"
              : "artifact_fts_unavailable_bounded_like",
          }
        : {}),
    };
  }

  async read(
    id: string,
    options: { completeJsonText?: boolean } = {},
  ): Promise<{
    artifact: ArtifactRecord;
    text?: string;
    truncated: boolean;
    format: "text" | "binary";
    originalPath: string;
    textProjection?: "metadata_and_text";
  }> {
    const row = this.db
      .prepare("SELECT record_json FROM owner_artifacts WHERE id=? AND workspace_root=?")
      .get(bounded(id, 240), this.workspaceDir) as { record_json: string } | undefined;
    if (!row) {
      throw new ArtifactStoreError("artifact_not_registered");
    }
    const artifact = JSON.parse(row.record_json) as ArtifactRecord;
    const inspected = await this.inspect(
      artifact.relativePath,
      artifact.mimeType,
      options.completeJsonText ? ARTIFACT_JSON_SOURCE_MAX_BYTES : TEXT_LIMIT,
    );
    if (artifact.sha256 !== inspected.sha256 || artifact.bytes !== inspected.bytes) {
      throw new ArtifactStoreError("artifact_original_hash_mismatch");
    }
    const projection = toolEnvelopeProjection(inspected.text);
    return {
      artifact,
      ...(projection.text === undefined ? {} : { text: projection.text }),
      truncated: inspected.textTruncated,
      format: inspected.format,
      originalPath: inspected.originalPath,
      ...(projection.projected ? { textProjection: "metadata_and_text" as const } : {}),
    };
  }

  close(): void {
    this.db.close();
  }
}
