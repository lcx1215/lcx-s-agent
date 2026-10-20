import path from "node:path";

export type LinuxMountInfoEntry = Readonly<{
  mountPoint: string;
  root: string;
  device: string;
  fsType: string;
  source: string;
}>;

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseLinuxMountInfo(rawMountInfo: string): LinuxMountInfoEntry[] {
  const entries: LinuxMountInfoEntry[] = [];
  for (const line of rawMountInfo.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(" - ");
    if (separatorIndex === -1) {
      continue;
    }

    const left = trimmed.slice(0, separatorIndex);
    const right = trimmed.slice(separatorIndex + 3);
    const leftFields = left.split(" ");
    const rightFields = right.split(" ");
    if (
      leftFields.length < 5 ||
      rightFields.length < 2 ||
      !/^\d+:\d+$/u.test(leftFields[2]) ||
      !path.posix.isAbsolute(decodeMountInfoPath(leftFields[3])) ||
      !path.posix.isAbsolute(decodeMountInfoPath(leftFields[4]))
    ) {
      continue;
    }

    entries.push({
      mountPoint: decodeMountInfoPath(leftFields[4]),
      root: decodeMountInfoPath(leftFields[3]),
      device: leftFields[2],
      fsType: rightFields[0],
      source: decodeMountInfoPath(rightFields[1]),
    });
  }
  return entries;
}

function isPathUnderRootWithPathOps(
  targetPath: string,
  rootPath: string,
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse">,
): boolean {
  const normalizedTarget = pathOps.resolve(targetPath);
  const normalizedRoot = pathOps.resolve(rootPath);
  const rootToken = pathOps.parse(normalizedRoot).root;
  if (normalizedRoot === rootToken) {
    return normalizedTarget.startsWith(rootToken);
  }
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${pathOps.sep}`)
  );
}

export function findLinuxMountInfoEntryForPath(
  targetPath: string,
  entries: readonly LinuxMountInfoEntry[],
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse"> = path.posix,
): LinuxMountInfoEntry | null {
  const normalizedTarget = pathOps.resolve(targetPath);
  let bestMatch: LinuxMountInfoEntry | null = null;
  let ambiguous = false;
  for (const entry of entries) {
    if (!isPathUnderRootWithPathOps(normalizedTarget, entry.mountPoint, pathOps)) {
      continue;
    }
    if (
      !bestMatch ||
      pathOps.resolve(entry.mountPoint).length > pathOps.resolve(bestMatch.mountPoint).length
    ) {
      bestMatch = entry;
      ambiguous = false;
    } else if (pathOps.resolve(entry.mountPoint) === pathOps.resolve(bestMatch.mountPoint)) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : bestMatch;
}
