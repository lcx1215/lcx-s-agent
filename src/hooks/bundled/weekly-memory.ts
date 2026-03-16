import { writeFileWithinRoot } from "../../infra/fs-safe.js";

export type MemoryNote = {
  filename: string;
  content: string;
};

export function toUtcDateOnly(input: Date): Date {
  return new Date(`${input.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export function formatIsoWeek(date: Date): { weekKey: string; rangeLabel: string } {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const monday = new Date(utc);
  monday.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() || 7) - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    weekKey: `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    rangeLabel: `${monday.toISOString().slice(0, 10)} to ${sunday.toISOString().slice(0, 10)}`,
  };
}

export function countTop(values: string[], limit = 3): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

export async function writeMemoryNotes(rootDir: string, notes: MemoryNote[]): Promise<void> {
  await Promise.all(
    notes.map((note) =>
      writeFileWithinRoot({
        rootDir,
        relativePath: note.filename,
        data: note.content,
        encoding: "utf-8",
      }),
    ),
  );
}
