import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MEMORY_ALT_FILENAME, type WorkspaceBootstrapFile } from "../../agents/workspace.js";

export type MemoryNoteFile = {
  name: string;
  path: string;
  content: string;
};

export function resolveRecentCount(hookConfig: Record<string, unknown>): number {
  const raw = hookConfig.recentCount;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.min(8, Math.floor(raw)));
  }
  return 3;
}

export async function loadNewestMemoryNote(params: {
  workspaceDir: string;
  includes: string;
}): Promise<MemoryNoteFile | undefined> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const noteName = entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.includes(params.includes),
      )
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!noteName) {
      return undefined;
    }
    const filePath = path.join(memoryDir, noteName);
    const content = await fs.readFile(filePath, "utf-8");
    return { name: noteName, path: filePath, content };
  } catch {
    return undefined;
  }
}

export async function loadRecentMemoryNotes(params: {
  workspaceDir: string;
  recentCount: number;
  includes: string;
  excludes?: string[];
}): Promise<MemoryNoteFile[]> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const names = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name.includes(params.includes) &&
          !(params.excludes ?? []).some((exclude) => entry.name.includes(exclude)),
      )
      .map((entry) => entry.name)
      .toSorted()
      .toReversed()
      .slice(0, params.recentCount);

    return Promise.all(
      names.map(async (name) => {
        const filePath = path.join(memoryDir, name);
        const content = await fs.readFile(filePath, "utf-8");
        return { name, path: filePath, content };
      }),
    );
  } catch {
    return [];
  }
}

export function compactMemoryContent(content: string, maxChars = 700): string {
  const normalized = content.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function buildSyntheticMemoryContext(params: {
  title: string;
  intro: string[];
  sections: Array<{
    heading: string;
    note?: MemoryNoteFile;
    maxChars?: number;
  }>;
  recentNotes: MemoryNoteFile[];
  recentHeading: (note: MemoryNoteFile) => string;
  recentMaxChars?: number;
  outputFilename: string;
}): WorkspaceBootstrapFile {
  const anchorPath =
    params.sections.find((section) => section.note)?.note?.path ??
    params.recentNotes[0]?.path ??
    process.cwd();
  const content = [
    `# ${params.title}`,
    "",
    ...params.intro,
    "",
    ...params.sections.flatMap((section) =>
      section.note
        ? [
            `## ${section.heading}`,
            "",
            `### ${section.note.name}`,
            "",
            compactMemoryContent(section.note.content, section.maxChars ?? 700),
            "",
          ]
        : [],
    ),
    ...params.recentNotes.flatMap((note) => [
      params.recentHeading(note),
      "",
      compactMemoryContent(note.content, params.recentMaxChars ?? 700),
      "",
    ]),
  ].join("\n");

  return {
    name: DEFAULT_MEMORY_ALT_FILENAME,
    path: path.join(path.dirname(anchorPath), params.outputFilename),
    content,
    missing: false,
  };
}
