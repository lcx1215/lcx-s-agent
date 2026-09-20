import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { describeReadFailure, type SourceReadFailure } from "../../infra/unreadable-source.js";

export type ReceiptDirectoryStatus = "read" | "absent" | "unreadable";

/**
 * Re-exported rather than redefined: "absent" versus "unreadable" is one judgement about a failed
 * read, and two copies of it drift apart the moment somebody fixes one of them.
 */
export type ReceiptDirectoryIssue = SourceReadFailure;

export type ReceiptDirectoryListing = Readonly<{
  entries: readonly Dirent[];
  issue: ReceiptDirectoryIssue | null;
}>;

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
    return { entries: [], issue: describeReadFailure(err) };
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
