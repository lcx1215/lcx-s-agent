---
name: finance-data-methodology
description: Investment-research method layer that runs on top of the finance data connector surface — domain-sharded connector routing, three access paths, and evidence gates before any number becomes a visible answer.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Finance Data Methodology

This is the **method** layer. It deliberately contains no data-fetching logic of
its own: atomic data access lives in the connectors, and the method lives here.
Separating the two is what keeps connector drift from rewriting research method,
and keeps method changes from silently changing what data is collected.

## Division of labour

| Concern                                               | Where it lives                                   |
| ----------------------------------------------------- | ------------------------------------------------ |
| Which vendor, which endpoint, which credential        | `finance_data_connector` (declaration + routing) |
| Atomic data retrieval (`tools/call` on one connector) | `finance_data_connector` action `call_tool`      |
| Method, sequencing, output shape                      | **this skill**                                   |
| Evidence gates before a number is shown               | `finance_data_gateway_snapshot`                  |

## Workflow

1. **Name the domain first.** Pick the one business-domain shard you need —
   `a_share`, `a_share_index`, `meta`, `fund`, `futures`, `options`, `macro`,
   `filings`, `news`, `global_equity`, `crypto`. Never load every domain at once;
   tool lists are large and will crowd out the actual question.
2. **Inspect before you call.** Run `finance_data_connector` with
   `action: "inspect"` and read `domainsWithoutCallableRoute`. A domain that is
   not callable is a stated gap — report it, do not paper over it.
3. **Route through the declared path order.** MCP first, then REST, then SDK.
   `browser` is a declared last resort for sources with no API at all, never a
   default. A connector whose endpoint the vendor has not published stays
   unavailable; do not invent a URL.
4. **List tools, then call the smallest one.** `action: "list_tools"` for the
   chosen domain, then call one tool with the narrowest arguments that answer the
   question. Prefer one targeted call over a bulk dump.
5. **Gate every number.** Raw connector output is vendor payload, not evidence.
   Before any figure reaches a visible answer, wrap it in
   `finance_data_gateway_snapshot` with `sourceTimestamp`, `fieldDefinition`, and
   `sourceUrlOrArtifact` for each field, plus a cross-check provider and, unless
   explicitly waived, an official/issuer reference.
6. **Do not resolve conflicts by preference.** When providers disagree, the
   gateway routes to `data_provenance_quality_review`; never pick the value that
   best fits the thesis.
7. **State what was unavailable.** List domains or providers that had no
   callable route, and mark any figure that could not be sourced as unverified
   rather than dropping it silently.

## Deliverable shape

For each question report: instrument and as-of, the domains touched, the
connector ids actually called, the evidence per number (source + timestamp +
definition), conflicts found, gaps, and the next safe check.

## Boundaries

- Research only. No buy/sell instruction, no sizing, no order routing, no
  execution authority.
- Credentials are read from the single finance credential store; an explicitly
  empty value means disabled, not "use the default".
- Egress is explicitly declared. Ambient proxy environment variables must not
  decide the route, so the same run behaves the same on a laptop and in the
  cloud.
- Connector declarations are the single source of truth for endpoints. If a
  vendor publishes a new endpoint, change the registry, not this skill.
