export const CANONICAL_PRODUCT_NAME = "LCX Agent";
export const CANONICAL_PACKAGE_NAME = "lcx-agent";
export const CANONICAL_CLI_NAME = "lcx";
export const CANONICAL_CONFIG_FILENAME = "lcx.json";
export const CANONICAL_STATE_DIRNAME = ".lcx";

export const LEGACY_PACKAGE_NAME = "openclaw";
export const LEGACY_CLI_NAME = "openclaw";

export const PACKAGE_NAME_ALIASES = [CANONICAL_PACKAGE_NAME, LEGACY_PACKAGE_NAME] as const;
export const CORE_PACKAGE_NAMES: ReadonlySet<string> = new Set(PACKAGE_NAME_ALIASES);
export const CLI_NAME_ALIASES = [CANONICAL_CLI_NAME, LEGACY_CLI_NAME] as const;
export const KNOWN_CLI_NAMES: ReadonlySet<string> = new Set(CLI_NAME_ALIASES);
