import type { Dirent } from "node:fs";
import fs from "node:fs/promises";

export type ReceiptDirectoryStatus = "read" | "absent" | "unreadable";

export type ReceiptDirectoryIssue = Readonly<{
  status: "absent" | "unreadable";
  code: string;
}>;

export type ReceiptDirectoryListing = Readonly<{
  entries: readonly Dirent[];
  issue: ReceiptDirectoryIssue | null;
}>;

function errnoCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as NodeJS.ErrnoException).code)
    : "error";
}

/**
 * Read a receipt directory, separating "there is nothing in there" from "I cannot see in there".
 *
 * A review tool answers the question "did the learning loop produce anything today?". Returning an
 * empty list when the directory cannot be read answers a different question — "what could I read?"
 * — while looking identical to a day with no output. The two have opposite consequences: one says
 * the loop is idle, the other says the review is blind. Callers surface `issue` rather than
 * letting it collapse into an empty result.
 */
export async function readReceiptDirectory(directory: string): Promise<ReceiptDirectoryListing> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    return {
      entries: [],
      issue: {
        status: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable",
        code,
      },
    };
  }
  return { entries, issue: null };
}

export function describeReceiptSource(params: {
  directory: string;
  issue: ReceiptDirectoryIssue | null;
}): string {
  if (params.issue === null) {
    return `read ${params.directory}`;
  }
  return `${params.issue.status} ${params.directory} (${params.issue.code})`;
}
