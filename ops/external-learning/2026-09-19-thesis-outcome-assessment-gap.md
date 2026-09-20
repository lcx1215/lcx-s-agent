# The assessment gap: an owner-declared thesis can never be assessed by the outcome ledger

**Check ID:** `thesis_outcome_assessment_gap_20260919`
**Access date:** `2026-09-19`
**Status:** **open, requires an owner decision.** Nothing in this document was changed.

---

## 1. The question

Gap ① (durable thesis entity) is closed: the system records what the owner believed, the
conditions that would invalidate it, and whether it is still `active` / `invalidated` / `realised`.
The obvious next question is whether **those beliefs ever get assessed** — i.e. whether the
system can learn "my judgement paid off", not merely "here is what I judged".

This document establishes that **it currently cannot**, and locates the break precisely.

## 2. Two disjoint claim worlds

|                                 | thesis book                                                   | outcome book                                                 |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Key                             | `thesisId`                                                    | `packetRef` + `caseId`                                       |
| Where claims come from          | **declared by the owner**                                     | generated inside a **research run's packet**                 |
| Carries a packet/case reference | **no**                                                        | yes (it _is_ the key)                                        |
| Assessment mechanism            | none (state changes only via an explicit operator transition) | scores recorded observations against the packet's own claims |

The decisive line is in `finance-outcome-ledger.ts`:

```
const claims = new Map(packet.packet.claims.map((claim) => [claim.id, claim.text]));
...
throw new Error("unknown or duplicate original claim");
```

An outcome record's `claimId` **must exist in the packet**. A thesis's claim lives in a
different book, under a different key, with no packet to belong to. So the outcome machinery
**structurally cannot assess a thesis** — not because of a missing call, but because there is
no join key to build the call on.

## 3. Two consequences that follow

1. **Thesis state transitions are manual-only.** `state` and `closedAt` are replayed from
   `opened` / `transition` events, and the only writer is the operator entry
   (`--transition`). The `invalidationConditions` recorded on a thesis are **text**; nothing
   evaluates them. A thesis stays `active` until a human says otherwise.
2. **Outcomes, once they flow, will not inform theses.** They will assess packet-generated
   claims and stop there. The assessment stream and the belief stream run in parallel and
   never meet.

## 4. Note on the collection gate (observed, not judged)

The outcome chain is `outcome ← packet ← research run ← collection`. A writer does exist —
`scripts/operator/lcx-finance-research.ts --outcome-file` calls `appendFinanceOutcome` — but it
requires a 64-hex `packet-ref` produced by a prior research run, and research runs go through
collection.

On `2026-09-19` a **separate, uncommitted change** relaxed the collection receipt gate from
"zero failed attempts" to "at least one _selected_ source succeeded, and no out-of-window
records", with a comment recording it as an owner decision. If that lands, packets become
producible and the outcome chain opens up — **which makes §3.2 concrete rather than
theoretical.** This document does not evaluate that change; it only notes that it is what turns
this gap from dormant into live.

## 5. Options (none started)

| #   | Option                                                                                                                       | What it changes                                                                                                        | Cost                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **Leave as is**                                                                                                              | nothing. The thesis book stays the owner's own journal; assessment is a human act, recorded by an explicit transition. | zero                                                                     |
| 2   | **Link outcome → thesis**: add an optional `thesisId` to outcome records and stop requiring `claimId` to exist in the packet | touches the **committed** `finance-outcome-ledger.ts` and its claim-validation contract                                | medium; changes a shared invariant                                       |
| 3   | **Link thesis → outcome**: let the thesis transition event carry an outcome ref as evidence                                  | touches `finance-thesis-ledger.ts` (new, uncommitted) only                                                             | low, but only records a _reference_ — it still does not compute anything |

**Option 3 is cheap but shallow**: it would let a human point a transition at an outcome
without the system ever deciding anything. That is honest, and may be the right trade — the
thesis ledger deliberately does not guess whether "the thesis changed" or "the owner changed
their mind".

**Option 2 is the real fix** and is the one that needs an owner decision, because it loosens an
invariant in a committed ledger: today an outcome can only assess a claim the research run
actually produced.

## 6. Boundary of what is claimed

- Claimed: repository state read from source on `2026-09-19` — the key fields of both books,
  the claim-validation code path in `finance-outcome-ledger.ts`, and the absence of any
  packet/case reference on thesis records.
- **Not** claimed: that the two books _should_ be joined. That is the decision this document
  is asking for. Nor that option 2 is safe — it would need its own before/after injection and
  a control, like any other change to a real gate.
- This document changed no code.
