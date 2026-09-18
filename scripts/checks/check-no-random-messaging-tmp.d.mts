/**
 * Hand-written declarations for the plain-`.mjs` checker so the `test/scripts` suite can import
 * it with real signatures without forcing the script through a build step.
 */
export function findMessagingTmpdirCallLines(content: string, fileName?: string): number[];

export function main(): Promise<void>;
