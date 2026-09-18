/**
 * Standalone `serve` entrypoint.
 *
 * `lcx.mjs` loads `dist/entry.js`, so the normal `lcx serve` path needs a full
 * tsdown build first. That build requires far more heap than an 8 GB host can
 * provide, so this entrypoint wires the same `serve` command directly and can be
 * run straight from source with tsx:
 *
 *   node --import tsx src/cli/serve-standalone.ts --bind loopback --port 8788
 *
 * It reuses `registerServeCli`, so options, defaults, and the fail-closed
 * bind/token contract are identical to the built-in CLI command. It deliberately
 * skips `runCli` (config guard, plugin registration, preaction hooks) so the
 * service can start without the full CLI bootstrap.
 */
import { Command } from "commander";
import { registerServeCli } from "./serve-cli.js";

const program = new Command();
program
  .name("lcx-serve")
  .description("Standalone in-process HTTP agent service (no Gateway daemon)")
  .helpOption("-h, --help", "Display help for command");

registerServeCli(program);

// `registerServeCli` declares `serve` as a subcommand, so the argv must route
// through it for its options (`--bind`, `--port`, ...) to be recognized.
await program.parseAsync(["node", "lcx-serve", "serve", ...process.argv.slice(2)]);
