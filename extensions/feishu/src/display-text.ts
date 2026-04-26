function normalizeMarkdownTableBlock(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return block;
  }

  const rows = lines
    .filter((line, index) => {
      if (index === 1 && /^\|?[-:\s|]+\|?$/.test(line)) {
        return false;
      }
      return true;
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((cells) => cells.length > 0);

  if (rows.length < 2) {
    return block;
  }

  const headers = rows[0];
  const bodyRows = rows.slice(1);
  return bodyRows
    .map((cells) => {
      const pairs = cells.map((cell, index) => {
        const header = headers[index] ?? `Column ${index + 1}`;
        return `${header}: ${cell}`;
      });
      return `- ${pairs.join("; ")}`;
    })
    .join("\n");
}

export function normalizeFeishuDisplayText(text: string): string {
  const normalizedTables = text.replace(
    /(^|\n)(\|.+\|[\r\n]+\|[-:| ]+\|(?:[\r\n]+\|.*\|)+)/g,
    (_match, prefix: string, table: string) => `${prefix}${normalizeMarkdownTableBlock(table)}`,
  );

  const withoutCodeFences = normalizedTables.replace(
    /```(?:[\w+-]+)?\n?([\s\S]*?)```/g,
    (_match, codeBody: string) => {
      const body = codeBody
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      return body ? `\n${body}\n` : "\n";
    },
  );

  return withoutCodeFences
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
