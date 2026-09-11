const LOCAL_MODEL_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "HF_HOME",
  "HF_HUB_CACHE",
  "HUGGINGFACE_HUB_CACHE",
  "TRANSFORMERS_CACHE",
  "XDG_CACHE_HOME",
] as const;

/**
 * Local model runtimes get only host/cache settings required by Python and
 * Hugging Face. Provider, channel, proxy, and shell-injection credentials are
 * intentionally excluded even when the gateway has them in its environment.
 */
export function buildLocalModelProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_MODEL_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}
