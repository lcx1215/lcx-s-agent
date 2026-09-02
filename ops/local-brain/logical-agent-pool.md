# Local logical-agent pool

This is the local orchestration layer for the 10-role design. It is deliberately
not ten model processes:

- ten logical roles share one model binding;
- the default local concurrency is `1` and the tested ceiling is `2`;
- the pool owns FIFO scheduling, dependency ordering, failure propagation, and
  a one-model-slot guard;
- the model executor is injected, so an orchestration test cannot be mistaken
  for proof that Qwen, MLX, or another local inference backend is installed;
- the pool has no provider, external-channel, protected-memory, or trading
  authority.

The default DAG is:

```text
data_cleaning
  ├─ financial_extraction ─┐
  ├─ news_classification ───┼─ risk_check ─────────┐
  └─ evidence_integrity ───┴─ portfolio_exposure ─┼─ research_draft
                                                  └─ adversarial_challenge
                                                       └─ formatting
                                                            └─ final_precheck
```

Inspect the plan without running inference:

```bash
node --import tsx scripts/operator/lcx-logical-agent-pool.ts --json
```

Run the deterministic, no-network demo:

```bash
node --import tsx scripts/operator/lcx-logical-agent-pool.ts --demo --json
```

The demo only proves role wiring, dependency ordering, and resource limits. It
does not prove model quality, training absorption, promotion, external-channel
binding, or user-visible delivery.
