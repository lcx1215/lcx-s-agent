# Security Policy

This policy covers the LCX Agent repository and the code, tests, Skills,
plugins, local operators, communication adapters, CI workflows, release
automation, and documentation shipped from it.

The package may retain compatibility names or code inherited from an upstream
project. Those names describe implementation lineage; they do not change this
repository's reporting scope or security ownership. The current repository is
[lcx1215/lcx-s-agent](https://github.com/lcx1215/lcx-s-agent). Its upstream
lineage is tracked separately and is not a reporting destination for issues in
this repository.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use a
[private GitHub Security Advisory](https://github.com/lcx1215/lcx-s-agent/security/advisories/new)
for this repository. If that channel is unavailable, contact the repository
maintainers through the repository's private GitHub channels and do not include
secrets or personal data in the message.

Include, when available:

1. the affected revision, release, or runtime profile;
2. the exact file, function, workflow, Skill, adapter, or configuration seam;
3. a minimal reproducible example or proof of concept;
4. the trust boundary crossed and the demonstrated impact;
5. required permissions, credentials, network access, or operator actions;
6. logs or screenshots with tokens, keys, personal data, and message content
   redacted; and
7. a suggested mitigation or a safe temporary workaround.

Reports that lack a reproducible path may still be useful, but triage may need
additional evidence before classifying severity or assigning a fix.

## Security model and trust boundaries

Treat these as distinct boundaries and state which one a report crosses:

- Model output, prompts, retrieved documents, external-channel messages, issue
  bodies, pull requests, and imported repositories are untrusted content.
- Skills, plugins, scripts, workflow actions, and generated code are executable
  implementation. Installing, enabling, or running one is an authority change,
  not proof that its instructions are safe.
- The local operator, configured credentials, protected runtime state, and OS
  account are trusted according to the current deployment profile. A report
  must not assume a stronger boundary than that profile declares.
- CI jobs processing pull requests must treat repository changes as untrusted.
  A job must not execute pull-request code with privileged tokens merely because
  the event name is convenient.
- External communication is a transport boundary. A routed message, receipt,
  or synthetic replay is not proof that a person saw the intended answer.
- A compatibility Skill copy is not primary authority until its source,
  registration, owner, and behavior are verified.

## Security invariants

Changes and reports should preserve these invariants:

- Authenticate and authorize before mutation, publication, message sending,
  credential use, or privileged execution.
- Keep permissions, tokens, filesystem scope, network scope, and subprocess
  authority as narrow as the task permits.
- Do not put secrets, private keys, access tokens, personal data, live service
  configuration, or unredacted user messages in Git, fixtures, artifacts,
  screenshots, prompts, or public logs.
- Treat a model answer, local test, receipt, or HTTP success as evidence at its
  own layer only; do not promote it into learned, deployed, externally bound,
  or user-visible proof without the corresponding evidence.
- Preserve one declared source of truth when adapters or agents coexist.
  Shadow and compatibility paths must identify their owner, direction, and
  retirement condition.
- Keep destructive, external, and irreversible operations explicit, scoped,
  reviewable, and recoverable where practical.
- Pin or otherwise integrity-check third-party CI actions and downloaded tools
  when the workflow's risk and maintenance model support it. Do not silently
  grant write permission to a job that only needs read access.

## Reportable issues

Examples include:

- authentication, authorization, approval, sandbox, path-safety, or secret
  handling bypasses;
- untrusted content reaching a privileged tool, subprocess, workflow, Skill,
  plugin, or external sender without the intended gate;
- CI or release automation executing untrusted changes with unnecessary write
  tokens or publishing artifacts without the required authorization;
- credential, personal-data, or message-content disclosure caused by the
  repository's code or automation;
- adapter, worktree, promotion, or rollback behavior that can silently replace
  the declared runtime/result authority; and
- reproducible dependency, packaging, update, or supply-chain compromise
  affecting consumers of this repository.

## Hardening and non-boundary findings

Prompt injection, heuristic disagreement, stale documentation, unsafe operator
configuration, or a malicious Skill/plugin may still deserve hardening. They
are security vulnerabilities only when the report demonstrates a bypass of an
applicable authentication, authorization, approval, sandbox, integrity, or
data-protection boundary. If no boundary is crossed, report it as hardening or
reliability work rather than relying on a severity claim alone.

Do not dismiss an issue solely because it involves an Agent, Multi-Agent
worker, model, tool, external channel, or future replacement implementation.
First identify the actual current owner and the concrete boundary involved.

## Out of scope

The following are normally not security vulnerabilities by themselves:

- an attacker who already controls the trusted OS account, protected runtime
  state, credentials, or repository maintainer account;
- an operator intentionally enabling a documented break-glass option without a
  separate bypass of the option's authorization boundary;
- a finding that depends only on a synthetic replay, stale receipt, or a
  manually backdated timestamp;
- a compatibility copy or historical artifact that is not registered as the
  current authority, unless it can be reached through an unintended execution
  or trust path; and
- generic availability, spam, or rate-limit concerns without a demonstrated
  security impact.

These exclusions do not cover a vulnerability that creates the trusted state,
changes the declared authority, bypasses a required gate, or exposes protected
data. When uncertain, report privately with the evidence you have.

## CI, release, and external automation

`.github` workflows and local actions are part of the security scope. Reviewers
should verify, for every change:

- the event type is appropriate for the code it runs;
- pull-request code is not checked out into a privileged `pull_request_target`
  job unless the workflow has an explicit, reviewed reason;
- `permissions` are least-privilege at workflow and job level;
- secrets and generated output are not echoed into logs or exposed to forks;
- write, publish, tag, comment, label, close, lock, and deployment actions are
  explicit and reviewable; and
- third-party actions, downloaded binaries, containers, and package sources
  have a maintained integrity/provenance strategy.

Manual workflows that can commit, publish, deploy, or send messages should
default to inspection or artifact generation. A separate explicit input or
reviewed job should be required for the external write.

## Local state and recovery

Runtime state, receipts, queues, logs, Skills, adapters, and worktrees may
contain sensitive or operational data. Keep them outside Git unless a redacted
fixture is intentionally required. Do not recover missing applications,
credentials, or external services by deleting or overwriting unrelated local
state. Record the source, revision, timestamp, command, and result for security
claims, and preserve evidence needed to reproduce a failure.

## Maintainer ownership

The repository's [CODEOWNERS](.github/CODEOWNERS) file identifies the current
review owner for security policy, CI, release automation, and the rest of the
tree. Update that file when ownership changes; do not encode a personal email
or external service address in this policy without verifying that it is current
and intended for security reports.
