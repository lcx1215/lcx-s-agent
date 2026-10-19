# Persistent model duties

The canonical entry is `src/plugins/lcx-model-fleet.ts`. The existing gateway
hosts the tools and startup receipt; no second daemon is needed. The manifest
must declare both startup activation and all four tool contracts on current hosts.

Build an isolated deployment package with:

```sh
node ops/model-fleet/build.mjs /absolute/empty/output-directory
```

The bundle contains its JavaScript dependencies and needs no external
`node_modules` symlink. Install the reviewed local package with the host's
`plugins install --link` command, under the actual gateway configuration.
Back up that configuration before changing it. Configure explicit `slotModels`
(`fast`, `reasoning`, `review`); the reviewer must differ from the author.
Restart only the authorized existing gateway. Restore the saved configuration
and disable this plugin to roll back. Preserve other plugins and authentication.

| Model             | Assignment                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| Qwen3.5 2B 4bit   | Reviewed verbatim extraction and preliminary labels; summaries disabled |
| Qwen3 VL 2B 3bit  | Supplied images and charts                                              |
| Qwen3 VL 4B 4bit  | Manual vision comparison reserve                                        |
| Qwen3 0.6B        | Isolated existing training experiment; no promotion implied             |
| Qwen3.5 0.8B 4bit | Candidate comparison; not automatically routed                          |
| Llama 3.2 1B      | Manual English baseline reserve                                         |

Local text and vision share one inference lock. Text weights load on the first
request and remain in the resident worker for reuse until that worker stops;
vision runs use their existing process lifecycle. A protocol-ready worker may
still have cold weights and no successful inference. Persistent availability
means the host restores registrations on startup, not that every declared
candidate or reserve is installed or occupies memory. Cloud slots remain explicit and
paid when invoked; local preprocessing makes no API calls. Reserve models are
not started automatically. All local outputs require review.

Verify through authenticated loopback `tools/invoke`, passing an explicit
existing agent owner in multi-agent installations. Check `lcx_model_roster`, a
real `local_specialist` call, a synthetic `local_vision` call, and
`finance_research_run` with `live: false`. The startup receipt is
`state/model-fleet-runtime.json` under the configured workspace. Confirm its PID
matches the gateway, then repeat the roster call after a scoped restart.
Installation checks alone do not prove tool registration or inference quality.

The daemon-free `serve` entry starts the same local text worker through the core
service owner. Its `GET /healthz` reports protocol readiness, weight state and
successful-inference evidence without calling a model. It does not expose the
Gateway's `tools/invoke` HTTP endpoint; verify local tool inference separately
without routing an agent request through a paid model merely to test health.
Keep extraction quotes in source order, preserve repeated occurrences and
return the original source to the supervising agent when the contract fails.
Inference completion is not a valid task result. A failed batch must retain its
sources; later batches can still use the original supervised worker. Qualify a
specific workload before expanding duties. For simply preserving supplied text,
use the original text directly; copying it alone does not justify model inference.

Rejected base-model text and invalid parsed values retain a diagnostic in the
original preprocessing receipt: representation, represented-output hash, useful prefix
and explicit omitted bytes. The stored prefix fits a 4 KiB selected JSON field;
the model-facing prefix fits 512 bytes. The existing tool-result recorder indexes
the retained details for exact recall. These are rejected, untrusted diagnostics,
not source evidence or accepted results; no output repair, retry or authority is
added. Missing transport output is never invented from an error message.
