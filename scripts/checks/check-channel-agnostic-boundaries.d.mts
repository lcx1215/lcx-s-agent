/**
 * Hand-written declarations for the plain-`.mjs` channel-boundary checker. The script stays
 * JavaScript so it can run straight from `package.json` without a build step; these types exist
 * only so TypeScript consumers (the `test/scripts` suites) can import it with real signatures.
 */
export type ChannelBoundaryViolation = {
  line: number;
  reason: string;
};

export type ChannelBoundaryCheckOptions = {
  checkModuleSpecifiers?: boolean;
  checkConfigPaths?: boolean;
  checkChannelComparisons?: boolean;
  checkChannelAssignments?: boolean;
  moduleSpecifierMatcher?: (specifier: string) => boolean;
};

export function findChannelAgnosticBoundaryViolations(
  content: string,
  fileName?: string,
  options?: ChannelBoundaryCheckOptions,
): ChannelBoundaryViolation[];

export function findChannelCoreReverseDependencyViolations(
  content: string,
  fileName?: string,
): ChannelBoundaryViolation[];

export function findAcpUserFacingChannelNameViolations(
  content: string,
  fileName?: string,
): ChannelBoundaryViolation[];

export function findSystemMarkLiteralViolations(
  content: string,
  fileName?: string,
): ChannelBoundaryViolation[];

export function main(): Promise<void>;
