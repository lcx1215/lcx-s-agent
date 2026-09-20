# Gap ③ precondition check: does the factor-evolution interface exist?

**Check ID:** `gap3_precondition_check_20260919`
**Access date:** `2026-09-19`
**Supersedes status:** `2026-09-18-trading-agent-ecosystem-intake.md` line 188 —
"depends on an unchecked `finance-strategy-method-catalog.ts` interface; do not start before that check"

**Verdict: the interface does not exist.** The precondition is no longer "unchecked"; it is
checked and **absent**. Gap ③ stays blocked. This document records what was checked so the
same question is not re-opened from memory.

---

## 1. What the intake actually gated on

The intake downranked ③ for one stated reason only:

> "Highest cost of the three, and it depends on an interface to
> `finance-strategy-method-catalog.ts` that has **not** been checked."

So the gate is about the **interface**, not about the file's existence. The file exists; the
question is whether it exposes anything an evolution loop could drive.

## 2. What was checked

| Probe                                                                 | Result                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finance-strategy-method-catalog.ts` export surface                   | `STRATEGY_METHOD_IDS`, `StrategyMethodDefinition`, `StrategyMethodOperationalContract`, `StrategyDirectionDefinition`, `FINANCE_STRATEGY_METHODS`, `FINANCE_STRATEGY_METHOD_CONTRACTS`, `FINANCE_STRATEGY_DIRECTIONS`, `FINANCE_STRATEGY_METHOD_CATALOG`, `buildFinanceStrategyCatalogPrompt()` |
| Mutation / lifecycle vocabulary in that file                          | **zero hits**: `sqlite`, `DatabaseSync`, `INSERT`, `append`, `persist`, `promote`, `demote`, `score`, `ranking`, `evaluate`, `mutation`, `propose`, `evolution`, `generation`, `lineage`                                                                                                        |
| `finance-strategy-method-kit.ts` export surface                       | `selectFinanceStrategyMethodIds(ask: string)`, `buildFinanceStrategyMethodKit(ask: string)`                                                                                                                                                                                                     |
| Consumers of the catalog                                              | `scripts/operator/finance-strategy-all-methods.ts` (a dump), the kit, and tests only                                                                                                                                                                                                            |
| Any persistent table holding strategy / factor / method / alpha state | **none**                                                                                                                                                                                                                                                                                        |

## 3. Reading of the result

The catalog is a **frozen declaration surface**: `Object.freeze` over fixed arrays plus a
prompt builder. `buildFinanceStrategyCatalogPrompt()` makes it injected text, i.e. the same
kind of thing skills are — declarative input to a model, not a component with state.

The kit is **stateless selection**: `selectFinanceStrategyMethodIds(ask)` picks method ids by
matching a question string. It keeps no memory of what was selected before, receives no
outcome back, and cannot be scored. Every run re-selects from zero.

Consumers close no loop: one dumps the catalog for display, the rest are tests.

A factor/alpha evolution loop needs at least three things, and **none of the three exists**:

1. **A candidate registry with lifecycle** — proposed → evaluated → promoted/demoted. There is
   no table and no entity; the catalog is immutable.
2. **An evaluation hook over registered candidates** — `scripts/operator/finance-strategy-method-benchmark.ts`
   does evaluate (`runBenchmark`, `evaluateStressMatrix`), but it takes a price series **plus a
   hypothetical strategy supplied by the caller**. It cannot enumerate and iterate over
   registered factors, because there are none to enumerate.
3. **A proposal mechanism** — absent entirely.

## 4. Consequence for the absorption plan

③ is not "downranked pending a check". It is **blocked at a missing foundation**, and building
that foundation is itself the expensive part: a new durable ledger with promotion/demotion
lifecycle, plus a loop that drives it. That is consistent with the intake's own "Highest cost
of the three" — the check **confirms** the ranking rather than lifting it.

| Gap                                  | Status after this check                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| ① persistent thesis entity           | **closed** (ledger + operator entry + agent read surface)           |
| ② behaviour profile from own fills   | **closed** (pure projection + operator entry + agent read surface)  |
| ③ factor/alpha evolution loop        | **blocked** — needs a candidate-registry ledger that does not exist |
| ④ agent-native platform registration | **discard** (per intake: external-sender + copy-trading authority)  |

**Do not start ③** on the strength of this document. Start it only after an owner decides to
fund the missing registry, which is a separate durable-ledger addition with its own lifecycle
design and its own gate review.

## 5. Boundary of what is claimed

- Claimed: repository state — export surfaces, keyword presence/absence, consumer sets, and
  the set of `CREATE TABLE` statements matching `strategy|factor|method|alpha`. Read from
  source on `2026-09-19`.
- **Not** claimed: that no factor work exists anywhere outside `src/` and `scripts/`; that the
  benchmark could not be repurposed; or that building the registry would be unwise. Only that
  the interface the intake named is absent, and that ③ therefore cannot start as scoped.
- This document changed no code.
