# Machine 1 completion and verification boundary

Contract version: **1.1.0**. This pull request is the control-plane lane for
issue #1. It provides shared contracts and authoritative durable governance;
Machine 2 supplies actual model/runtime execution and Machine 3 supplies the
operator console and final system evidence.

## Reproducible core checks

From the repository root, use the pinned Node/pnpm environment and PostgreSQL
configuration documented in README.md:

```sh
pnpm install --frozen-lockfile
pnpm check:core
pnpm test:core
```

The governance suite in `apps/api/test/domain.test.ts` verifies lifecycle
admission, terminal task states, reporting cycles and depth, human-root and
tenant boundaries, retirement orphan checks, communication policy, scoped
memory, unavailable grants, exact manifest approval and mandatory evidence.
These tests exercise real pure policy code with test data. Their evidence
fixtures do **not** claim that a model, integration or employee has run.

Database and API tests must run against PostgreSQL to establish durable
transactional behavior. A skipped integration test or unavailable database does
not establish that behavior. Root core commands cover the control-plane lane;
the separate combined command additionally requires worker and console code.

## Specification §24 audit

| Definition of Done item | Machine 1 responsibility | Whole-system evidence still required |
| --- | --- | --- |
| Manifest and organizational position exist | Versioned schema, durable identity, team/manager validation and human-root graph | Model-compiled manifest approved and provisioned through the actual workflow |
| Runtime exists and selected model works | Job protocol, current-lease authority, persisted resources and mandatory runtime/model verification | Machine 2 must create the real runtime and invoke the configured model |
| Required tools, authentication and permissions work | Restricted grant allowlist, approved scope, mandatory named checks, authenticated API boundaries | Exercise actual safe operations with effective scoped permissions |
| Memory works | Durable typed/scoped memory, provenance and canonical revision governance | Actual write, reinitialize and retrieve under permitted and forbidden scopes |
| Communication and escalation work | Persisted messages, delivery state, escalation and follow-up work APIs | Real manager/requester messages and terminal escalation resolution |
| Logs and observability exist | Durable events, jobs, usage, resource and evidence query contract | Worker events with accurate observed values, rendered in the console |
| Evaluation passes | Required evaluation evidence and storage | Actual evaluation of model-backed output with recorded criteria |
| Persistence survives restart | PostgreSQL migrations and persistent artifact-volume configuration | Restart API/worker and recover actual manifests, messages, costs, memory and files |
| Real end-to-end workflow exercised | Approval, recruitment, lease and evidence authority boundaries | Four real employees prepared through recruitment; live fifth employee hire, delegated task and reply |

No seeded ACTIVE employees, fabricated approvals, simulated integrations or
fixture verification can substitute for the rightmost column. Approval binds
the exact manifest version. Structural evidence validation ensures required
references exist in the submitted shape; the service also has to resolve their
ownership and attempt. Even valid references cannot by themselves prove that
an external operation succeeded. Runtime behavioral checks remain necessary.

## Integration handoff

The issue records the immutable bootstrap SHA used by all lanes. Consumers
branch from that boundary and share the versioned contracts, OpenAPI and
fixtures. Dependency changes require a matched package/lockfile update; frozen
installation must remain reproducible.

The coordinating machine must combine all three branches in a temporary
checkout before merging core, then merge core → runtime → console/verification,
rebasing remaining lanes between merges. Run affected checks after each merge,
and run the final combined checks and live smoke workflow on the actual final
main SHA. This PR does not merge or enable auto-merge.

The local operator/worker credential model is an MVP configuration, not
production identity administration. Distributed scaling, production tenant
administration, delegated high-impact governance and unimplemented external
integrations remain outside this lane's hackathon completion claim.
