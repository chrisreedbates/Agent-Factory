# Machine 2 completion and verification boundary

Contract: **1.0.1**. Bootstrap: `0056cc9218d8c1d6274437b8396d11537583f01f`. This
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
completion, publishes immutable scoped artifacts, reports every mandatory
verification check with resolvable evidence, and **fails** a job when the
configured model is unavailable instead of reporting simulated success.

Those tests are orchestration evidence. They are not proof that a real model, a
real integration or an operational employee works. The whole-system workflow
still requires a running API, a real model credential and the integrated console.

## Specification §24 audit

| Definition of Done item | Machine 2 responsibility | Evidence still required |
| --- | --- | --- |
| Manifest and organizational position exist | Compiles the proposal into a schema-validated manifest without changing identity, team or manager | A human approval binding the exact compiled version through the live flow |
| Runtime exists and selected model works | Real model adapter used by compilation, execution and learning; a self-check verifies reachability | An actual model call observed through the running worker and control plane |
| Required tools, authentication and permissions work | Only supported local capabilities are granted; tool observations require a matching grant | Effective permission checks with the live API lease |
| Memory works | Initializes agent-scoped memory with verbatim read-back; agents write their own episodic memory with provenance | Restart the API and worker and recover the persisted memory |
| Communication and escalation work | Replies to the originating message and routes escalation to the approved manager | Real manager/requester messages and terminal escalation resolution |
| Logs and observability exist | Emits scoped, sanitized model, tool and verification events for every attempt | Events rendered from the running control plane |
| Evaluation passes | Evaluates recorded model output against the manifest criteria | An integrated evaluation recorded for a real task |
| Persistence survives restart | Writes immutable artifacts and durable workspace knowledge, then re-reads them | Restart the processes and recover the actual files |
| Real end-to-end workflow exercised | Executes delegated tasks, learning and recruitment requests from real agent execution | Four prepared employees plus the live fifth hire and reply |

No seeded ACTIVE employee, fabricated approval, simulated integration or
fixture verification substitutes for these. A provisioning outcome is admitted
only when every mandatory check passes with persisted evidence; an unavailable
model or credential fails the job and leaves the agent in `REMEDIATING`.

## Integration handoff

Machine 2 owns `apps/worker/**`, `docs/runtime/**`, `compose.worker.yaml` and the
package-local worker configuration. Contract, API, database, shared root files
and CI remain owned by Machine 1; console and integrated/system evidence remain
owned by Machine 3.

The coordinator must integrate core → runtime → console, then run the combined
checks and the live smoke workflow on the final main SHA. This lane does not
merge or enable auto-merge.
