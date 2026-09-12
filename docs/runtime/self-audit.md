# Machine 2 completion and verification boundary

Contract: **1.1.0**. Bootstrap: `0056cc9218d8c1d6274437b8396d11537583f01f`. This
pull request is the runtime lane for issue [#2](https://github.com/chrisreedbates/Agent-Factory/issues/2).
It provides real model compilation, execution, learning and retirement against
the Machine 1 control plane. It does **not** fabricate approvals, ACTIVE
employees, integrations or evidence, and it does not open PostgreSQL.

## Reproducible runtime checks

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-factory/worker check
pnpm --filter @agent-factory/worker test
```

The worker suite runs an in-memory control plane that re-applies the API's
fencing, reservation and evidence-resolution rules, plus a scripted model. The
tests establish that the worker reserves before execution, settles before
completion, publishes immutable scoped artifacts, revalidates every model tool
call against the offered set and current grants, requires a named deliverable
that verifies on read-back, replaces mutable agent state atomically under an
attempt fence with the lease asserted around it, aborts the attempt immediately on
an authority refusal or lost lease renewal, fails closed above the retirement
knowledge cap, and **fails** a job when the configured model is unavailable or
when required memory retrieval is refused instead of reporting simulated success.

Those tests are orchestration evidence. They are not proof that a real model, a
real integration or an operational employee works. The whole-system workflow
still requires a running API, a real model credential and the integrated console.

## Specification §24 audit

| Definition of Done item | Machine 2 responsibility | Evidence still required |
| --- | --- | --- |
| Manifest and organizational position exist | Compiles the proposal into a schema-validated manifest without changing identity, team or manager | A human approval binding the exact compiled version through the live flow |
| Runtime exists and selected model works | Real model adapter used by compilation, execution and learning; a strict nonce self-check verifies reachability | An actual model call observed through the running worker and control plane |
| Required tools, authentication and permissions work | Only supported local capabilities are granted; tool observations require a matching grant, and cross-agent reads are refused against a real sibling agent on the volume | Effective permission checks with the live API lease |
| Memory works | Initializes agent-scoped memory with verbatim read-back under a lease-fenced atomic replacement; a refused retrieval fails the job instead of proceeding with empty context; agents write their own episodic memory with provenance | Restart the API and worker and recover the persisted memory |
| Communication and escalation work | Replies to the originating message and routes escalation to the approved manager; provisioning exercises the durable paths through the fenced `verify-communication` capability (contract 1.1.0) and fails closed on refusal | A live provisioning run that reaches `ACTIVE` through that capability |
| Logs and observability exist | Emits scoped, sanitized model, tool and verification events for every attempt | Events rendered from the running control plane |
| Evaluation passes | Evaluates recorded model output against the manifest criteria | An integrated evaluation recorded for a real task |
| Persistence survives restart | Writes immutable artifacts and durable workspace knowledge, then a separate process re-initializes the storage layout and recovers both the artifact and the working memory | Restart the processes and recover the actual files |
| Real end-to-end workflow exercised | Executes delegated tasks, learning and recruitment requests from real agent execution | Four prepared employees plus the live fifth hire and reply |

No seeded ACTIVE employee, fabricated approval, simulated integration or
fixture verification substitutes for these. A provisioning outcome is admitted
only when every mandatory check passes with persisted evidence; an unavailable
model or credential fails the job and leaves the agent in `REMEDIATING`.

Ordinary worker delegation stays forbidden during provisioning
(`apps/api/src/app.ts` admits it only for `run_task`/`learn`, for `ACTIVE`
agents), so the worker never acts as a not-yet-active agent. Additive contract
1.1.0 provides the narrowly scoped `POST /v1/worker/jobs/:id/verify-communication`
operation instead: the worker sends only its lease token and attempt, and the API
binds the agent, approved manifest, recipients and content server-side. The
worker records evidence referencing both returned IDs.

A refusal is never reported as success: the affected check is recorded as
blocked, a blocked diagnostic is published, and the job fails with
`VERIFICATION_BLOCKED` rather than claiming activation. The server-generated
probe proves the durable communication and escalation paths were exercised; it is
not model-written content and does not stand in for the reply and escalation
intent the run must still draft. Real Fastify/PostgreSQL coverage for the
operation's authority lives in Machine 1's lane (PR #4), which owns `apps/api/**`.

## Integration handoff

Machine 2 owns `apps/worker/**`, `docs/runtime/**`, `compose.worker.yaml` and the
package-local worker configuration. Contract, API, database, shared root files
and CI remain owned by Machine 1; console and integrated/system evidence remain
owned by Machine 3.

The coordinator must integrate core → runtime → console, then run the combined
checks and the live smoke workflow on the final main SHA. This lane does not
merge or enable auto-merge.
