# Operating the control plane

Contract: **1.1.0**. Bootstrap: `0056cc9218d8c1d6274437b8396d11537583f01f`.

## Start and authenticate

1. Install Node 24.20.0 and pnpm 11.19.0; run `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to `.env` and replace both authentication tokens with distinct random strings of at least 32 characters. Configure the real model key only in the worker environment.
3. Start PostgreSQL with `docker compose up -d postgres`.
4. Export your local `.env` settings, run `pnpm db:migrate`, then `pnpm db:seed`.
5. Run `pnpm dev:api`, or `docker compose up --build api` for the containerized API.

The API listens on loopback by default. The Docker port is also bound to loopback. `PUBLIC_ORIGIN` defaults to `http://localhost:3000`; set it to the browser's actual origin when using a proxy. Browser development should proxy `/v1` to the API and configure that origin. No wildcard CORS is enabled.

The operator exchanges `POST /v1/session` `{ "token": "<operator token>" }` for an opaque HttpOnly SameSite=Strict cookie. The session is stored as a hash in PostgreSQL, expires after eight hours, and logout revokes it. HTTPS origins set Secure cookies. CLI/test callers may use an operator Bearer token. Worker Bearer credentials are distinct and cannot approve governance or impersonate humans. There is no default production password.

Agent-capable public routes require the worker credential plus `x-job-id`, `x-lease-token`, and `x-job-attempt`. The current task/learning lease determines the actor. A model cannot specify `requestedBy` or override the tenant. Bare worker credentials do not permit browsing agent-private state.

## Worker integration

Poll `POST /v1/worker/jobs/claim`; `{data:null}` means no work. Claim also materializes due schedule ticks and blocked actionable messages once their recipient is ACTIVE. Renew before lease expiry. Every mutation except claim/renew/login/logout requires a unique `Idempotency-Key`; retries use the same key and content. Expired and superseded attempts cannot write.

Before model execution, reserve usage against the current job/attempt. Settle actual calls/tokens/cost; use `null` when cost is unknown. Unknown cost retains the reservation against the daily limit. Compilation uses the proposed hire's budget; provisioning uses its reviewed manifest budget. Model-driven completion requires settled usage with no outstanding reservation for that attempt. Retirement may be tool-only. Never treat a zero reservation as permission for unbounded execution.

Use `append event` for sanitized model/tool observations. Completion references persisted evidence from the same job, agent and attempt. Compiling a manifest does not grant permissions. Approval queues provisioning against the exact immutable version. Activation requires all named verification checks from the contract, approved grants, workspace/runtime resources and evidence. The API validates references and artifact bytes; Machine 2 performs the actual behavioral checks. Tests use explicitly synthetic observations and do not prove a real model or employee works.

A `run_task` for an actionable input message carries `inputMessageId` and the full message payload. Complete with a reply; the API persists a message referencing the original message and marks delivery `replied`. Factory approval/provisioning notifications to agents are actionable and become linked work. Notifications to humans only populate the inbox.

## Persistent files

The volume `agent-factory-workspaces` is retained independently of containers and mounted read-only by the API. Worker containers must mount that same volume read/write. The worker writes immutable artifacts as `agentId/jobId/attempt/filename`, computes the SHA-256 and size, and publishes via its current lease. Sources for the demo are a separate read-only directory supplied by Machine 3. The source directory is never the writable artifact volume.

The API refuses traversal, symlinks, mismatched hashes, missing bytes and files over 10 MiB. Retrieval repeats integrity checks. The API does not rewrite file bytes; an external worker changing an accepted file causes retrieval to fail rather than silently serving modified content. Browser responses are downloads with `nosniff`; filesystem roots are never exposed.

## Governance and recovery

Only humans approve final manifests, canonical revisions, reconfiguration and retirement. Local grant/budget changes require the complete replacement manifest so the reviewed authority is concrete. External credentials, unsupported integrations and organization-policy administration fail explicitly as unavailable.

Pausing cancels existing work and fences its leases. Resume restores admission after retained verification; cancelled tasks remain terminal and schedules remain disabled. Create fresh tasks/schedules explicitly. Reconfiguration pauses admission, records a new immutable approved manifest, queues `reconfigure_agent` and requires renewed verification. Failure remains REMEDIATING, with explicit remediation available. Retryable worker failure is bounded to three attempts; lease expiry allows recovery with a new fencing token.

Escalating a task makes it terminal and fences the run. Resolving it may create linked follow-up work; it never resurrects the original task. Retirement requires approval and refuses live reports: reconfigure their reporting relationships first. Retirement cancels work, disables schedules, requires cleanup evidence, revokes resource/grant state and retains all memory, messages, tasks and events. A consultant completing its bounded task is paused and receives a pending retirement review.

If retirement cleanup fails permanently or exhausts its worker retries, the agent remains `TERMINATING`. After correcting the cause, the human operator can submit the `remediate` lifecycle action with the current agent version. This queues one new cleanup job using the original approved retirement scope and preserves cancellation of ordinary work. Remediation is rejected while cleanup is queued or running; it does not create a new approval or reactivate the agent.

All state, jobs and audit events commit in one PostgreSQL transaction. An organization row lock serializes authority-changing operations across API processes. The local deployment has one configured tenant/operator/worker credential. Horizontal multi-tenant administration and high-throughput scheduling remain later work.

## Tests

`pnpm check:core` and `pnpm test:core` cover contracts, pure governance, storage and HTTP/database integration. Local storage tests use PGlite (PostgreSQL compiled to WASM), including an on-disk restart test. CI repeats API integration against PostgreSQL 17.6 via `TEST_DATABASE_URL=... pnpm --filter @agent-factory/api test:postgres`.

`pnpm check:combined` intentionally fails without the sibling implementations. Machine 3 supplies real browser/system evidence in an integrated checkout before merge, then repeats the live smoke workflow on final main. Do not count the fixtures or scaffold checks as proof of the recursive recruitment demo.

## Provisioning communication verification (contract 1.1.0)

A provisioning or reconfiguration worker calls `POST /v1/worker/jobs/:id/verify-communication` with its worker bearer credential, an `Idempotency-Key`, and `{leaseToken, attempt}`. The API validates the current lease, lifecycle, cancellation state, exact approved manifest version, manager identity and communication policy. It derives all record identities and content; arbitrary request fields are rejected.

The response contains `data.message` and `data.escalation`. These are durable, manager-visible probes: a non-actionable queued message and a low-severity OPEN escalation categorized `provisioning_verification`. They create no task, do not activate the agent, and do not establish a manager reply or model execution. The manager may resolve the probe normally. The API records a job/attempt-scoped audit event with both IDs. One pair is created per attempt even if the client changes its retry key. Cached responses still require a live, uncancelled, approved attempt.

Machine 2 must replace its provisioning calls to ordinary `/v1/messages` and `/v1/escalations` with this dedicated operation, then persist worker evidence referencing the returned record IDs. Ordinary pre-ACTIVE delegation stays forbidden. All remaining provisioning verification and usage requirements still apply.

## Combined local deployment

Use `docker compose -f compose.yaml -f compose.full.yaml up -d --build` from the repository root. Set distinct random operator/worker tokens, a real `OPENAI_API_KEY`, `MODEL_NAME`, and `PUBLIC_ORIGIN=http://localhost:8080` in the ignored `.env` before startup. Open `http://localhost:8080`; nginx proxies `/v1` to the API on the same origin. PostgreSQL persists in the Compose volume, the API mounts the shared agent workspace read-only, and the worker mounts it read/write with `sources/` mounted read-only. Source briefs contain input facts only, never employees, approvals or verification outcomes.

The supported `send_message` tool has only the `send` operation. The runtime revalidates its current grant and uses the authenticated `/v1/messages` operation; the API still enforces communication scope and derives sender identity. An actionable message schedules durable work and a correlated reply. It cannot approve a hire or expand permissions.

Run `pnpm check:combined` for deterministic integration and browser behavior gates. Run `pnpm verify:live` in an interactive terminal following `docs/verification/live-acceptance.md` for real model execution and exact human approvals. Missing credentials or unfinished stages block live acceptance; a reachable empty deployment is only a smoke result. Preserve final live evidence for the actual reviewed Git SHA and repeat after the final merge.
