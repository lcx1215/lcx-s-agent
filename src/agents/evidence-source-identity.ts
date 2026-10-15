/** Declared identity only: URL normalization never proves independent reporting. */
export function evidenceSourceIdentity(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    // Snapshot keys before deleting: URLSearchParams iterators are live.
    const trackingKeys = Array.from(url.searchParams.keys()).filter(
      (key) => /^utm_/iu.test(key) || /^(?:fbclid|gclid|msclkid)$/iu.test(key),
    );
    for (const key of trackingKeys) {
      url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return value.trim();
  }
}

export function inspectEvidenceMultiplicity(
  evidence: readonly { id: string; text: string; source?: string }[],
) {
  const parents = evidence.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      index = parents[index];
    }
    return index;
  };
  const identities = new Map<string, number>();
  evidence.forEach((entry, index) => {
    const keys = [`text:${entry.text.normalize("NFKC").replace(/\s+/gu, " ").trim()}`];
    // A source label such as a collector name is not a document identity.
    if (entry.source && /^https?:\/\//iu.test(entry.source.trim())) {
      keys.push(`url:${evidenceSourceIdentity(entry.source)}`);
    }
    for (const key of keys) {
      const previous = identities.get(key);
      if (previous !== undefined) {
        parents[root(index)] = root(previous);
      } else {
        identities.set(key, index);
      }
    }
  });
  const groups = new Map<number, string[]>();
  evidence.forEach((entry, index) => {
    const group = groups.get(root(index)) ?? [];
    group.push(entry.id);
    groups.set(root(index), group);
  });
  return Object.freeze({
    assessed: "normalized_identical_text_and_declared_document_url" as const,
    inputCount: evidence.length,
    distinctPacketGroups: groups.size,
    duplicateGroups: Object.freeze(
      [...groups.values()].filter((group) => group.length > 1).map((group) => Object.freeze(group)),
    ),
    independentSourceCount: null,
    upstreamLineage: "not_assessed" as const,
    semanticTruth: "not_assessed" as const,
  });
}
