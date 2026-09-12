# Machine 2 worker runtime

`apps/worker` is the runtime lane of issue [#2](https://github.com/chrisreedbates/Agent-Factory/issues/2). It turns an approved role into an operational employee: it compiles a role with the configured model, provisions and verifies the agent, executes delegated work and learning, and retires agents cleanly.

The worker **never** opens PostgreSQL and never manages its own job store. Every read and write goes through the versioned `/v1` control plane using the distinct `WORKER_TOKEN` credential and the current job lease. There is exactly one control plane.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entrypoint: loads configuration, wires the runner and polls. |
| `src/config.ts` | Environment parsing and validation. |
| `src/client.ts` | Typed `/v1` client with fencing headers and deterministic `Idempotency-Key`. |
| `src/model.ts` | The single configurable model adapter plus a bounded model/tool loop. |
| `src/workspace.ts` | Safe, agent-scoped filesystem access and immutable artifact writes. |
| `src/handlers.ts` | The six job handlers, the reserve/settle ledger and verification checks. |
| `src/runtime.ts` | Lease-aware claim loop, renewal and failure reporting. |

## Configuration

Copy `apps/worker/.env.example` and set values; the worker shares `.env` with the API in Docker.

| Variable | Purpose |
| --- | --- |
| `WORKER_TOKEN` | Distinct worker credential (≥ 32 characters). Never the operator token. |
| `API_BASE_URL` | Control-plane base URL, e.g. `http://127.0.0.1:3000`. |
| `ARTIFACT_ROOT` | Read/write root for immutable artifacts. Must be the shared workspace volume. |
| `SOURCE_ROOT` | Read-only root of per-agent brief directories (`<SOURCE_ROOT>/<agentId>`). Never the writable volume. |
| `MODEL_NAME` | The configured runtime model. Agent identity is independent of the provider. |
| `OPENAI_API_KEY` | Model credential. The worker keeps it out of agent manifests. |
| `OPENAI_BASE_URL` | Optional provider-compatible base URL. |
| `WORKER_LEASE_SECONDS` | Claimed lease length (10–300). |
| `WORKER_POLL_MS` | Idle poll interval. |
| `WORKER_JOB_KINDS` | Optional subset of job kinds to claim. |
| `WORKER_ESTIMATED_COST_PER_CALL` | Reservation amount per model call; settlement records the real cost or `null`. |
| `WORKER_MAX_TOOL_ROUNDS` | Upper bound on model/tool round trips per task. |

## Job protocol

The worker claims with `POST /v1/worker/jobs/claim`, then uses the attempt and lease token on every fenced call. It renews before expiry and abandons the attempt (without failing the job) if the lease is lost.

| Kind | Behaviour |
| --- | --- |
| `compile_manifest` | The real model drafts the narrative role; structural fields (team, manager, tools, grants, budget) come from the governance proposal. The assembled manifest is validated against the shared `AgentManifest` schema. |
| `provision_agent` / `reconfigure_agent` | Runs the real mandatory checks and returns `steps`, `checks` and `resources`. Communication and escalation are exercised through the dedicated fenced `POST /v1/worker/jobs/:id/verify-communication` capability (see below). If the control plane refuses any check, the worker publishes a blocked diagnostic and fails closed instead of activating the agent. |
| `run_task` | A bounded model/tool loop over the granted `workspace-files` tools, plus `request_hire` when granted. The agent's scoped memory is retrieved and given to the model (a refused or failed retrieval fails the job rather than proceeding with empty context), and completion requires a grounded evaluation gate over the persisted deliverable. |
| `learn` | The model proposes one grounded lesson from prior persisted evidence; the worker persists an artifact and the agent's own episodic memory whose provenance is the prior evidence, not itself. |
| `retire_agent` | Verifies the **whole** durable knowledge set by reading every item back (failing closed above the supported cap rather than dropping any), atomically replaces a runtime-disable marker, copies the authorized knowledge bytes (with provenance and scope) into each `knowledgeRecipientIds` workspace and verifies retrieval as that recipient, then publishes a retirement record. Every reported count and boolean is derived from the verified set. |

**Budget.** Every non-retirement job reserves before model or tool execution and settles afterwards. Model/tool observations require an outstanding reservation, and completion requires settled usage with no outstanding reservation for the attempt.

**Artifacts.** Files are written to `<agentId>/<jobId>/<attempt>/<name>`, hashed with SHA-256 and published with the current lease. Accepted artifacts are immutable; the API re-reads and verifies the bytes.

**Mutable agent state.** Working memory, the retirement marker and consultant transfers are *not* attempt artifacts, so they are replaced through `replaceAttemptFile`: bytes go to a sibling temp file, are fsynced and are renamed over the destination, the lease is asserted before and after, and an attempt fence (kept outside the workspace roots) stops a stale attempt from clobbering state owned by a newer attempt. A partial or interleaved shared-state write is therefore impossible, and no work continues once the lease is gone.

**Enforcement.** The model's tool calls are never trusted. Every call must name a tool that was offered for this attempt, pass argument validation, happen under a live lease, and still be granted by the control plane (`getAgent` is re-read immediately before the operation for `run_task`/`learn`). Undeclared, revoked or cancelled operations abort or are refused, never executed. The lease `AbortSignal` is threaded through the tool loop into the provider request, so a lost lease cancels an in-flight model call instead of billing it.

**Evidence.** Task, learning and verification outcomes reference persisted artifact and event IDs from the same agent, job and attempt. The worker cannot fabricate that authority because the API resolves every reference. Task completion requires the model to name a deliverable it actually wrote, that deliverable to verify on read-back, any approved briefs to have been read, **and** a grounded evaluation gate that judges the persisted deliverable bytes against the task objective, constraints, deliverable and every `manifest.evaluation.criteria` entry. The gate is given the verified evidence contents and each criterion must be judged exactly once; duplicated, renamed, uncited or failed criteria fail the job with `TASK_EVALUATION_FAILED`.

## Verification checks

Provisioning reports all mandatory check names: `runtime`, `model`, `tools`, `authentication`, `permissions`, `memory`, `communication`, `escalation`, `observability`, `evaluation`, `restart`, `end_to_end`. They are behavioural, not structural:

- `runtime` / `memory` — durable write, read-back and hash comparison, with symlink-safe, exclusively created files and atomic lease-fenced replacement of shared state.
- `model` — the model must echo a fresh nonce exactly, so partial or negated replies fail.
- `tools` / `permissions` — real reads of the agent's scoped briefs (`<sourceRoot>/<agentId>`), symlink-safe directory listing, and a cross-agent read refused against a **real sibling agent** on the volume (never a fabricated missing path), plus allowlist validation.
- `authentication` — the control plane must reject a forged worker credential (401) while accepting the current lease.
- `communication` / `escalation` — the run must draft a manager reply and a policy-approved escalation, then exercise the durable paths through the fenced `POST /v1/worker/jobs/:id/verify-communication` capability. The API binds the agent, approved manifest, recipients and persisted content server-side, so the worker sends only its lease token and attempt. The check passes only when the control plane returned both persisted records, and the evidence cites both returned IDs.
- `evaluation` — a real model judgement over the persisted evidence. The evaluator is given the verified deliverable bytes and every recorded observation, must judge each `manifest.evaluation.criteria` entry **exactly once** (copied verbatim), and must cite persisted evidence from the attempt; duplicated, renamed, uncited or failed criteria fail the job.
- `restart` — a **separate process** re-initializes the storage layout from the configured root and recovers both the published artifact and the agent's working memory, reproducing their SHA-256 hashes.
- `end_to_end` — one real model run that reads an approved brief, writes a deliverable and verifies the read-back hash.

Checks that depend on unavailable integrations fail instead of passing: external credentials are refused, an unavailable model or a non-compliant provisioning run blocks activation, and the agent stays in `REMEDIATING`. An authority, lifecycle or transport refusal of the fenced verification aborts the attempt immediately — no diagnostic is published under a lease the control plane has already withdrawn — and only a genuinely unimplemented capability is deferred to the blocked diagnostic.

### Provisioning communication verification (contract 1.1.0, fail closed)

Ordinary worker delegation is admitted only for `run_task` and `learn` jobs, and only for `ACTIVE` agents (`apps/api/src/app.ts`, `apps/api/src/domain.ts`), so a not-yet-`ACTIVE` provisioning agent cannot act as itself and must not fake it. Additive contract 1.1.0 provides the narrowly scoped `POST /v1/worker/jobs/:id/verify-communication` operation for exactly this: the worker authenticates with its bearer credential and an `Idempotency-Key`, sends only `{leaseToken, attempt}`, and the API derives the agent, approved manifest, recipients and content from the fenced `provision_agent`/`reconfigure_agent` lease. It grants no general agent delegation and permits nothing before activation.

The worker sends no delegated agent headers, actors, recipients or content, and it records worker evidence referencing both returned IDs. A refusal is never reported as success: the check is recorded as **blocked** (never `passed`), a `provisioning-verification.json` diagnostic lists every check and the blocked ones, and the job fails with `VERIFICATION_BLOCKED` so the agent stays `REMEDIATING`. The server-generated probe proves the durable paths were exercised; it is not model-written content and does not stand in for the model's draft reply and escalation intent, which the run must still produce.

## Running

```sh
# from the repository root, after `pnpm install --frozen-lockfile`
export $(grep -v '^#' .env | xargs)
pnpm --filter @agent-factory/worker dev     # continuous poll loop
pnpm --filter @agent-factory/worker once    # one bounded pass
```

With Docker, `docker compose -f compose.yaml -f compose.worker.yaml up -d --build` starts PostgreSQL, the API and the worker. The worker mounts the named `agent-factory-workspaces` volume read/write and the source briefs read-only.

## Tests

```sh
pnpm --filter @agent-factory/worker check
pnpm --filter @agent-factory/worker test
```

Tests use an in-memory control plane that mirrors the API's fencing, reservation, evidence **and delegation** rules, plus a scripted model. The double refuses ordinary delegated provisioning sends exactly as the real API does and exposes the dedicated 1.1.0 capability with a refusal switch, so no test can pass a forbidden path and the fail-closed path is covered too. Coverage includes enforced tool dispatch, the grounded task and provisioning evaluation gates (rejecting duplicated, renamed and uncited criteria), provisioning activation through the fenced capability, fail-closed deferral of an unimplemented capability, immediate abort on an authority refusal, cross-agent denial against a real sibling agent, restart reinitialization with memory recovery, the retirement knowledge cap, atomic attempt-fenced state replacement, real recipient-readable consultant knowledge transfer, memory-retrieval failure failing closed, lease-loss abort, grounded learning, the client's exact verification wire shape, and refusal to fabricate success.

Real Fastify/PostgreSQL coverage for the `verify-communication` authority lives in Machine 1's lane (PR #4), which owns `apps/api/**`; the runtime lane keeps the fail-closed side and its orchestration tests.

These tests are orchestration evidence and do **not** prove that a real model or employee works; the real model and tool workflow must still be exercised against a running control plane.
