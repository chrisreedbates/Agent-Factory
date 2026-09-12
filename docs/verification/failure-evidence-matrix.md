# Failure and evidence matrix

Component and deterministic integration tests establish the listed failure behavior. They do not establish real-model acceptance. `live-acceptance.md` defines the separate required live run and its revision-bound evidence.

| Spec failure group | Owner and mitigation | Automated evidence | Live or deferred boundary |
| --- | --- | --- | --- |
| §19.1 Provisioning | API binds the exact approved manifest; runtime requires named behavioral checks and remains remediating after failure. | `apps/api/test/integration.test.ts`; `apps/worker/test/handlers.test.ts`; `tests/integration/runtime-api.test.ts` | Real provider provisioning and approved reconfiguration must pass the live runner. |
| §19.2 Authentication | API separates human/worker identity, rejects forged credentials and stale leases; UI uses HttpOnly same-origin sessions and clears tokens. | `apps/api/test/auth.test.ts`; `apps/web/tests/operator.spec.ts`; runtime authentication probe | OAuth and external credential integrations are unavailable in this MVP and cannot be certified operational. |
| §19.3 Tools | Runtime validates offered tools, arguments, current grants and lease; immutable files are read back and hashed. Unsupported integrations fail. | `apps/worker/test/handlers.test.ts`; `apps/worker/test/workspace.test.ts`; `apps/api/test/artifacts.test.ts` | Live workspace operations required; public social/email/CRM operations are out of scope. |
| §19.4 Memory | API filters scope/status/expiry and binds canonical proposals; runtime persists grounded observations and fails on retrieval errors. | `apps/api/test/service-security.test.ts`; `apps/api/test/worker.test.ts`; `tests/integration/runtime-api.test.ts` | Live learning must demonstrably change later work and survive process replacement. |
| §19.5 Organization | API bounds depth/count/budget, deduplicates requests, validates reporting graphs and rejects orphaning retirement. | `apps/api/test/domain.test.ts`; `apps/api/test/integration.test.ts` | Genuine two→four→fifth recruitment and provenance remain a live gate. |
| §19.6 Execution | API fences attempts and reservations; runtime aborts provider/tool work after known lease loss; UI retains unresolved command identities across reload. | `apps/api/test/worker.test.ts`; `apps/worker/test/handlers.test.ts`; `apps/web/tests/operator.spec.ts` | Live runner interrupts an EXECUTING task, requires recovery of the same job at a later attempt and verifies final artifacts/reply. |
| §19.7 Learning | Evidence-backed tactical memory is scoped; canonical changes stay PROPOSED until exact human governance; unrelated run proposals cannot be claimed. | `apps/api/test/worker.test.ts`; `apps/api/test/service-security.test.ts`; `tests/integration/runtime-api.test.ts` | Operator reviews whether a real lesson improved the subsequent deliverable; synthetic tests cannot establish that judgment. |
| §19.8 Security | Strict schemas bind identity; allowlisted scoped tools reject traversal and symlinks; lease/grant checks constrain model requests; UI renders untrusted data as text. | `apps/api/test/auth.test.ts`; `apps/api/test/artifacts.test.ts`; `apps/worker/test/workspace.test.ts`; `apps/web/tests/operator.spec.ts` | The MVP is a scoped worker capability boundary, not a general hostile-code sandbox. No unrestricted shell/tool execution is offered. |

## §24 operational evidence map

| Required criterion | Owning lane and evidence |
| --- | --- |
| Manifest, position and manager | Core exact approval/graph tests; runtime compilation; console full manifest/tree; live prepared and fifth-agent records |
| Runtime and selected model | Worker provisioning checks and real provider/model events in live evidence; missing key blocks this criterion |
| Tools, authentication and permissions | Scoped workspace and forged-auth probes; core/worker negative tests; live artifact bytes and read-back hashes |
| Memory and persistence | Real API/runtime integration for grounded memory/canonical approval; live learning reuse and abrupt process restart |
| Communication and escalation | Actual API/runtime integration proves manager receipt, unrelated-scope denial and human resolution; live delegated task and requester reply |
| Logs and observability | Durable job/attempt/event/usage records exposed by console; live evidence records model and recovery events |
| Evaluation | Runtime validates criteria and persisted references; real live artifact output still requires operator inspection |
| Real end-to-end workflow | `pnpm verify:live`, all stages at the reviewed commit, plus behavioral browser gates and final-main rerun |

Unknown POST outcomes retain their idempotency key across retries and reloads; only SHA-256 fingerprints and UUIDs are stored, never tokens or request contents. Definitive conflicts require refreshing authoritative state and making a new reviewed decision. Mutations carry the displayed record version wherever the contract requires it. A missing live prerequisite remains BLOCKED regardless of green automated checks.
