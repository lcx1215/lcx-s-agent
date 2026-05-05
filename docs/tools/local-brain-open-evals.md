# Local Brain Open Evals

LCX local-brain training can be checked with open-source eval tools without
touching live Lark, live sender, provider config, protected memory, language
corpus, or finance doctrine.

## Local Bridge

Run the repo-native bridge first. It uses the same cases as the Promptfoo and
Inspect configs and fails fast without requiring external packages:

```bash
node --import tsx scripts/dev/local-brain-open-eval.ts --json
```

## Promptfoo

Promptfoo is useful for prompt pressure tests and red-team style assertions.
The config is:

```bash
pnpm dlx promptfoo@latest eval -c evals/local-brain/promptfoo.yaml
```

If Promptfoo fails on `better-sqlite3` native bindings, fix the local Promptfoo
install/cache outside the repo, then rerun the same command. Do not add
Promptfoo or `better-sqlite3` to the OpenClaw runtime dependencies just to make
this dev eval work.

This eval calls:

```bash
node --import tsx scripts/dev/local-brain-open-eval-provider.ts "<user ask>"
```

## Inspect AI

Inspect AI is useful when we want a more formal task/solver/scorer structure:

```bash
python -m inspect_ai eval evals/local-brain/inspect_local_brain.py@local_brain_contracts
```

Install Inspect AI in a separate Python environment if it is not already
available. Do not add it to the runtime package dependencies.

## Current Eval Focus

- cross-market US equities, China A-shares, global indices, and crypto planning
- source-gated finance learning
- quant math missing-input refusal
- Lark context-pollution audit staying ops-first

These evals are dev checks. They are not live Lark proof.
