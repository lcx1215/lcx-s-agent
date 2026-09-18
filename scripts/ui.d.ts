/**
 * Hand-written declarations for `scripts/ui.js`, a plain-JavaScript launcher. It stays JavaScript
 * so `package.json` can invoke it without a build step; these types exist so TypeScript consumers
 * (the `test/scripts` suite) can import the exported helpers with real signatures.
 */
export function shouldUseShellForCommand(cmd: string, platform?: NodeJS.Platform): boolean;

export function assertSafeWindowsShellArgs(args: string[], platform?: NodeJS.Platform): void;

export function main(argv?: string[]): void;
