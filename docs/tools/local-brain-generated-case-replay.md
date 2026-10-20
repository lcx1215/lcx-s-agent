---
summary: "Generated holdout case replay format and migration"
read_when:
  - Evaluating generated holdout case files
  - Migrating older generated case files
---

# Generated holdout replay

Case schema `lcx_generalization_case_v2` uses generator version
`feature-signature-v2-replay`. Target rows include full `features` and a per-case
unsigned 32-bit `renderSeed`. The evaluator replays the original feature signature,
ask renderer and label derivation before any model call. It also checks the declared
holdout partition. Valid subsets and arbitrary nonreserved case IDs remain supported.

The receipt records `generatedHoldoutVerificationBasis: generator_rule_replay` and
`generatedHoldoutSamplingSeedVerified: false`. This verifies rule consistency;
it does not authenticate file origin, the declared sampling seed, or model learning.
The file SHA-256 identifies evaluated bytes and is not authentication.

Older v1 rows lack replay inputs and fail closed. Recreate them offline with the
current emitter, then select a subset if needed:

```sh
node --import tsx scripts/operator/local-brain-generalization-harness.ts --emit-holdout 300 --seed 20260830 > holdout-v2.jsonl
```

The version change also changes seeded sample wording and subsequent RNG draws.
Do not relabel v1 files as v2 or infer replay inputs from their signatures: the
signature omits `oldContextPollution`. This migration does not require training or
model inference and does not modify existing files automatically.
