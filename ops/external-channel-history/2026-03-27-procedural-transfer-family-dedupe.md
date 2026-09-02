# Procedural Transfer Family Dedupe

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `procedural_transfer` top-1 selection was already correct for several real operator questions
- but the result surface still returned multiple near-identical cards from the same method family
- the clearest case was the `IWM` procedural cluster:
  - `iwm_rotation_exhaustion_risk`
  - `iwm_rotation_reversal_risk`
  - `small_cap_rotation_and_refinancing_risk`
- these cards shared almost the same:
  - symbol
  - default method
  - transfer surface
- so method-transfer queries looked noisy, even when the first answer was right

## Why this was dangerous

- it made recall feel like a pile of similar notes instead of one reusable method memory
- that weakens the whole "brain-like" reuse path:
  - the system looks like it found the right family
  - but still behaves like a noisy notebook instead of a clean method caller

## Smallest safe patch

- keep the current ranking model
- keep the current:
  - lane dedupe
  - topic dedupe
  - intent routing
- add one bounded post-rank dedupe for `procedural_transfer`:
  - compute a procedural method-family key from:
    - `symbol`
    - `default_method`
    - `transfer_surface`
  - keep only the highest-ranked item per procedural method family
- do not apply this family dedupe to:
  - semantic recall
  - episodic recall
  - runtime market retrieval

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到财报阅读'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到策略审计'`
- `python3 scripts/local_corpus_search.py '回测是不是过拟合'`

## Live evidence

- `这个方法怎么复用到财报阅读`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
  - no longer followed by two more near-identical `IWM` procedural cards
- `这个方法怎么复用到策略审计`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
  - same-family `IWM` procedural duplicates are suppressed
- `回测是不是过拟合`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
  - same-family `IWM` procedural duplicates are suppressed

## What is now prevented

- method-transfer recall surfacing multiple near-identical procedural cards from the same family
- the "brain-like" transfer path looking noisier than it really is

## Residual

- this is family-level dedupe, not a full semantic clusterer
- distinct procedural families can still appear below the winner, which is intentional
