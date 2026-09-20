/** Cross-process inference slot. The OS releases the lock even after timeout or kill. */
export function buildLocalMlxCommand(module: "mlx_lm" | "mlx_vlm", args: string[]): string[] {
  const launcher = [
    "import fcntl, os, runpy, sys, tempfile",
    "slot = open(os.path.join(tempfile.gettempdir(), 'lcx-local-model-' + str(os.getuid()) + '.lock'), 'a')",
    "try:",
    "    fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    "    sys.exit('local_model_busy')",
    "import mlx.core as mx",
    "mx.set_cache_limit(128 * 1024 * 1024)",
    "if sys.argv[1] == 'mlx_lm': mx.set_memory_limit(3 * 1024 * 1024 * 1024)",
    "module = sys.argv[1]",
    "sys.argv = sys.argv[1:]",
    "runpy.run_module(module, run_name='__main__')",
  ].join("\n");
  return ["-c", launcher, module, ...args];
}

/**
 * Runs a repository-owned Python script under the same inference slot lock and
 * memory limit as `mlx_lm`. Scripts live in the repository, never in the shared
 * training environment, and argv is rebuilt so argparse sees only script flags.
 */
export function buildLocalScriptCommand(
  scriptPath: string,
  args: string[],
  memoryLimitMb = 3072,
): string[] {
  const launcher = [
    "import fcntl, os, runpy, sys, tempfile",
    "slot = open(os.path.join(tempfile.gettempdir(), 'lcx-local-model-' + str(os.getuid()) + '.lock'), 'a')",
    "try:",
    "    fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    "    sys.exit('local_model_busy')",
    "import mlx.core as mx",
    "mx.set_cache_limit(128 * 1024 * 1024)",
    `mx.set_memory_limit(${Math.max(256, Math.trunc(memoryLimitMb))} * 1024 * 1024)`,
    `sys.argv = ${JSON.stringify([scriptPath, ...args])}`,
    `runpy.run_path(${JSON.stringify(scriptPath)}, run_name='__main__')`,
  ].join("\n");
  return ["-c", launcher];
}
