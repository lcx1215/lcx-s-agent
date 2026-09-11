---
summary: "Move the complete LCX runtime to a stateful cloud host"
read_when:
  - Moving LCX Agent from a Mac to a cloud host
  - Choosing Alibaba Cloud, Google Cloud, or Cloudflare for deployment
  - Preparing persistent state, model routing, and cutover
title: "Cloud deployment"
---

# Cloud deployment

This is the runbook for moving the complete LCX Agent runtime to the cloud.
It covers the gateway, canonical state root, automations, checkpoints, data
adapters, model routing, and external-channel binding. It is not a second LCX
system: the cloud host becomes the one active runtime and the Mac becomes a
controlled migration source or standby.

## Recommended first target

Start with one stateful Linux VM or managed container host, one persistent block
volume, and one gateway replica:

```text
Cloudflare edge/tunnel (optional)
          |
          v
LCX gateway container on Alibaba ECS or Google Compute Engine
          |
          +--> one mounted canonical state volume
          |    /home/node/.openclaw
          |
          +--> hosted vision/model endpoint
          |    Alibaba Model Studio, Vertex/vLLM, or another configured adapter
          |
          +--> encrypted object-storage backups
               OSS or GCS; backup only, not a second live state authority
```

The current product uses file-backed state, checkpoints, sessions, queues, and
automation receipts. Do not begin with multiple replicas or an ephemeral
serverless filesystem: that would create duplicate schedulers or split the
canonical state root. High availability is a later migration after the state
owner has an explicit database/object-store adapter and a distributed
single-writer/lease proof.

## Provider roles

| Provider      | Best role in this migration                                             | Boundary                                                                                           |
| ------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Alibaba Cloud | ECS/ACK host, OSS backup, and Model Studio Qwen visual reasoning        | Qwen/model API and cloud storage are adapters; LCX remains the control owner                       |
| Google Cloud  | Compute Engine/GKE, Vertex Model Garden or vLLM GPU serving, GCS backup | Vertex/GCS do not replace the LCX state root or workflow authority                                 |
| Cloudflare    | Tunnel/Zero Trust ingress, DNS, WAF, rate limits, edge cache            | Workers AI can be a lightweight image/text adapter, not the canonical state store or strongest VLM |

Alibaba Model Studio currently documents Qwen3-VL visual-reasoning profiles with
image input, and also newer Qwen visual families. Google Model Garden supports
managed open-model serving and vLLM containers for multimodal GPU workloads.
Cloudflare's Workers AI catalog is useful for edge inference and routing, but
the deployment should not assume it contains the best chart-reasoning model.
Keep the chosen provider/model in configuration and receipts; never commit a
key or silently change the finance source authority.

## State and configuration contract

The cloud runtime must satisfy all of these predicates:

1. `OPENCLAW_STATE_DIR` is one absolute path inside the container.
2. `OPENCLAW_CONFIG_PATH` is inside that state root.
3. The config, workspace, sessions, queues, cron/heartbeat state, checkpoint
   files, receipts, and credentials are on the same persistent volume or on
   explicitly owned adapters.
4. Only one gateway replica owns scheduler/automation writes during the first
   migration.
5. Secrets arrive through the cloud secret manager or protected environment,
   never through Git, Docker image layers, or committed `.env` files.

The Compose profile passes the container paths explicitly. For a single VM,
point both host mounts at the same protected directory so the host also has one
state owner:

```bash
cp deploy/cloud/.env.example deploy/cloud/.env
mkdir -p /var/lib/lcx/state
chmod 700 /var/lib/lcx/state
# Edit deploy/cloud/.env and keep it outside source control.
docker compose --env-file deploy/cloud/.env up -d
docker compose --env-file deploy/cloud/.env run --rm openclaw-cli doctor
docker compose --env-file deploy/cloud/.env run --rm openclaw-cli gateway probe
```

Run the read-only cloud gate inside the gateway/CLI container:

```bash
pnpm lcx:cloud:preflight --json
```

It must not report `blocked`. `needs_review` is not a deployment proof; it
means a non-fatal boundary still needs an operator decision.

## Model routing after migration

Apple MLX is a local Mac implementation and is not the cloud visual runtime.
Set `LCX_LOCAL_VISION_ENABLED=0` in the cloud profile and configure the
existing `agents.defaults.imageModel` route to a hosted or GPU-served
image-capable model. The image tool already preserves provider/fallback
boundaries, so Alibaba, Vertex, or an OpenAI-compatible vLLM endpoint can be
introduced without making one provider the permanent brain.

Use two quality lanes:

- fast/default: the cloud provider's non-thinking visual model for ordinary
  screenshots and chart descriptions;
- escalation: a larger visual reasoning model for unreadable OCR, dense
  multi-panel charts, long documents, or disagreement with deterministic
  OHLCV/source analysis.

Every visual result should retain the provider, model, source timestamp, image
hash/path, prompt contract, latency, and uncertainty. Finance chart pixels
remain research context; timestamped OHLCV and source receipts remain the
numeric authority, and no cloud model gains trading execution authority.

## Migration gates

1. **Inventory** — record the active state root, config path, running
   automations, checkpoint receipts, source adapters, credentials locations,
   external-channel binding, and current Git commit.
2. **Snapshot** — stop overlapping writers, take an encrypted state snapshot,
   and record its hash. Do not copy a live SQLite/JSON state tree while its
   writer is active.
3. **Restore** — restore into the cloud block volume with preserved ownership
   and permissions; run `lcx:cloud:preflight` before starting the gateway.
4. **Shadow** — keep external sending disabled and replay representative
   requests, finance source cross-checks, chart analysis, checkpoints/resume,
   and hourly automation once.
5. **Bind** — only after the cloud runtime is locally ready, apply the existing
   external-channel binding owner and obtain fresh user-visible evidence.
6. **Cut over** — disable the Mac writer/automation, start the cloud writer,
   then verify health, state-root identity, automation receipt freshness, and
   external inbound/outbound observation.
7. **Rollback** — stop cloud writes, preserve its receipt/snapshot, restore the
   last known-good state snapshot to the Mac or a replacement VM, and rebind
   only after the same gates pass.

## What is not claimed by this document

- A cloud provider account, project, region, GPU, quota, domain, or secret has
  not been provisioned by this repository change.
- A Docker image build proves container readiness, not cloud deployment,
  external binding, or user-visible success.
- A larger hosted model is not automatically better for every chart; it must
  pass the same local/remote fixture and source-provenance gates.
