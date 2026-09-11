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

| Model             | Assignment                                                  |
| ----------------- | ----------------------------------------------------------- |
| Qwen3.5 2B 4bit   | Short summaries, verbatim extraction, preliminary labels    |
| Qwen3 VL 2B 3bit  | Supplied images and charts                                  |
| Qwen3 VL 4B 4bit  | Manual vision comparison reserve                            |
| Qwen3 0.6B        | Isolated existing training experiment; no promotion implied |
| Qwen3.5 0.8B 4bit | Candidate comparison; not automatically routed              |
| Llama 3.2 1B      | Manual English baseline reserve                             |

Local text and vision share one process lock. Weights unload after each call.
Persistent availability means the host restores registrations on startup, not
that every model occupies memory continuously. Cloud slots remain explicit and
paid when invoked; local preprocessing makes no API calls. Reserve models are
not started automatically. All local outputs require review.

Verify through authenticated loopback `tools/invoke`, passing an explicit
existing agent owner in multi-agent installations. Check `lcx_model_roster`, a
real `local_specialist` call, a synthetic `local_vision` call, and
`finance_research_run` with `live: false`. The startup receipt is
`state/model-fleet-runtime.json` under the configured workspace. Confirm its PID
matches the gateway, then repeat the roster call after a scoped restart.
Installation checks alone do not prove tool registration or inference quality.
