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
| `SOURCE_ROOT` | Read-only directory of approved source briefs. Never the writable volume. |
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
| `provision_agent` / `reconfigure_agent` | Runs real probes for the mandatory checks and returns `steps`, `checks` and `resources`. |
| `run_task` | A bounded model/tool loop over the granted `workspace-files` tools, plus `request_hire` when granted. Produces a published deliverable and a reply. |
| `learn` | The model proposes one grounded lesson; the worker persists an artifact and the agent's own episodic memory with provenance. |
| `retire_agent` | Publishes a retirement record and confirms runtime disablement and knowledge preservation. |

**Budget.** Every non-retirement job reserves before model or tool execution and settles afterwards. Model/tool observations require an outstanding reservation, and completion requires settled usage with no outstanding reservation for the attempt.

**Artifacts.** Files are written to `<agentId>/<jobId>/<attempt>/<name>`, hashed with SHA-256 and published with the current lease. Accepted artifacts are immutable; the API re-reads and verifies the bytes.

**Evidence.** Task, learning and verification outcomes reference persisted artifact and event IDs from the same agent, job and attempt. The worker cannot fabricate that authority because the API resolves every reference.

## Verification checks

Provisioning reports all mandatory check names: `runtime`, `model`, `tools`, `authentication`, `permissions`, `memory`, `communication`, `escalation`, `observability`, `evaluation`, `restart`, `end_to_end`. They are backed by real work where the local deployment allows it — a durable workspace probe, a real model self-check, a real `workspace-files` listing, an agent-scoped memory write with verbatim read-back, and a restart read-back. Checks that depend on external integrations remain explicit blockers: external credentials are refused, and an unavailable model fails the job rather than claiming success.

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

Tests use an in-memory control plane that re-applies the API's fencing, reservation and evidence rules, and a scripted model. They prove orchestration and refusal to fabricate success; they do **not** prove that a real model or employee works. The real model and tool workflow must still be exercised against a running control plane.
