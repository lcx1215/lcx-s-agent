/**
 * In-memory ledger of deterministic calculations performed during one unit of work.
 *
 * The problem this solves: a model can write a number into an answer and call it "derived", and
 * nothing downstream can tell whether a calculation ever happened. The quant functions are correct
 * and already used, but they are stateless — the result exists only in the model's context.
 *
 * Recording `{ action, inputs, output }` makes a derived figure traceable: the grounding gate can
 * then ask whether a declared `derived` number corresponds to a calculation that actually ran,
 * instead of taking the model's word for it.
 *
 * Deliberately in-memory and per-unit-of-work. A calculation is evidence for the answer being
 * composed right now; there is no requirement (and no schema) for cross-turn persistence yet, and
 * inventing one would be a storage decision masquerading as a maths decision.
 */

export type CalculationRecord = Readonly<{
  id: string;
  action: string;
  /** The inputs actually used, not the raw tool params: this is what makes the result checkable. */
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
  at: string;
}>;

export type CalculationLedger = Readonly<{
  record: (entry: {
    action: string;
    inputs: Record<string, unknown>;
    output: Record<string, unknown>;
  }) => CalculationRecord;
  list: () => ReadonlyArray<CalculationRecord>;
  /** All numeric outputs, for matching against declared derived figures. */
  numericOutputs: () => number[];
  clear: () => void;
}>;

/**
 * Process-wide ledger.
 *
 * Injecting a ledger is optional, and every optional thing that matters eventually goes unsupplied:
 * the default has to be "recorded", not "silently dropped". A long-lived process also has to be
 * bounded, so the shared ledger keeps the most recent entries instead of growing without end.
 */
let sharedLedger: CalculationLedger | undefined;

export function getSharedCalculationLedger(): CalculationLedger {
  sharedLedger ??= createCalculationLedger({ maxEntries: 500 });
  return sharedLedger;
}

export function createCalculationLedger(options: { maxEntries?: number } = {}): CalculationLedger {
  const entries: CalculationRecord[] = [];
  const maxEntries = options.maxEntries;
  let counter = 0;

  return {
    record: ({ action, inputs, output }) => {
      counter += 1;
      const entry: CalculationRecord = {
        id: `calc-${counter}`,
        action,
        inputs,
        output,
        at: new Date().toISOString(),
      };
      entries.push(entry);
      if (maxEntries !== undefined && entries.length > maxEntries) {
        entries.splice(0, entries.length - maxEntries);
      }
      return entry;
    },
    list: () => entries.slice(),
    numericOutputs: () => collectNumbers(entries.map((entry) => entry.output)),
    clear: () => {
      entries.length = 0;
    },
  };
}

/**
 * Every finite number in one record's output.
 *
 * Exported so a caller holding records (rather than the ledger) can still ask whether a claimed
 * figure appears among them — the grounding gate needs exactly that when it checks `derived`.
 */
export function calculationNumbers(record: CalculationRecord): number[] {
  return collectNumbers([record.output]);
}

function collectNumbers(values: unknown[]): number[] {
  const out: number[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        walk(item);
      }
    }
  };
  for (const value of values) {
    walk(value);
  }
  return out;
}
