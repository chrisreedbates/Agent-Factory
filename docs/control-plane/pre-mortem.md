# Control-plane adversarial pre-mortem

The control plane treats model and worker outputs as observations. Authority
comes from authenticated context, persisted approved versions, current leases,
current grants and transactional state. This review identifies failures before
implementation; tests below are policy or integration tests, not evidence that
a model-backed employee is operational.

| Failure | Required control | Verification boundary |
| --- | --- | --- |
| A model or worker invents `requestedBy`, approves itself, or claims ACTIVE | Derive identity from authentication and delegated job; human-only approval; bind exact reviewed version; use server lifecycle transitions | Reject caller authority fields and unauthorized decision requests; model text is never approval |
| A manifest changes tools, mission or budget after review | Immutable versions; approval must match the queued manifest version; approved reconfiguration suspends admission and requires renewed verification | Exercise stale approvals, repeated decisions and changed manifests |
| Equivalent autonomous proposals create duplicate employees | Deduplicate equivalent open proposals and idempotency keys transactionally; bound pending hires, active agents and depth | Concurrent submissions must resolve to one request/provisioning job |
| A manager points into another organization, creates a cycle, or shifts descendants beyond the depth limit | Resolve every manager/team in tenant; terminate ancestry at an actual human; validate prospective descendants as well as the changed node | Pure graph tests include cross-tenant humans, reparenting, a fourth generation and missing roots |
| Firing a manager leaves reports without authority | Reject retirement while live reports remain; reassign explicitly; preserve historical records | Requested and TERMINATING reports also block retirement |
| A stale worker completes after its lease expires | Fencing token plus attempt and expiration checked for every write under the job transaction | Two claimants; expiry/reclaim; late event, completion, failure and artifact publication |
| API reports success although model, authentication, memory or tools failed | Fixed mandatory verification set plus manifest-specific checks; evidence references must resolve to the current job and attempt; fail closed | Pure tests prove evidence shape and required checks; Machine 2/3 must exercise actual operations |
| A worker cites arbitrary events or an old artifact as successful verification | Require persisted, authorized evidence provenance; reject missing, cross-agent, foreign-tenant or stale-attempt references | Structural policy validation alone does not establish referential validity or truth of observations |
| A worker takes authority from a bootstrap secret or model instruction | Separate worker/operator credentials; delegated actor bound to a current run; only approved grants; MVP tools limited to workspace-files and request_hire | request_hire may request, never approve or provision; no shell, Slack or external credential grants |
| Concurrent tasks exceed budget or claim unknown cost is zero | Atomic reservations before execution, settle actual usage and preserve unknown cost as null | Concurrent reservations and retry settlement; unknown cost must remain visible |
| Peer communication or shared memory discloses information | Tenant check first; explicit communication policy; owner/team/organization memory scope; visibility does not grant write access | Cross-team peers, absent teams, canonical mutation, foreign tenant, non-owner writes |
| Learning silently rewrites organizational policy | Canonical revisions need human governance, keep previous versions and evidence provenance | Tactical memory is separate from canonical approval; a summary alone is insufficient evidence |
| Pause, cancellation or escalation is bypassed by a retry | ACTIVE-only work admission and persisted intent; terminal task states remain terminal; resolved escalations create follow-up tasks | Reject terminal resurrection; reject late success after cancellation and new work while paused |
| Artifact publication exposes arbitrary local files or replaces accepted output | Per-agent/job/attempt immutable path; reject escapes and symlinks; authenticate content retrieval; verify hash and size | Real filesystem tests, not a path regex alone; stale attempts cannot replace accepted artifacts |
| Restart loses files while database records appear healthy | Persistent artifact/workspace volume; API read-only, worker read/write; source directory separate and read-only | Machine 3 must restart/recreate processes and recover actual content and memory |
| Credentials appear in manifests, events or errors | References only; sanitize external errors and events; secrets stay in server configuration | Inspect API responses and audit records; production redaction and credential lifecycle remain a separate hardening concern |

Any unresolved material failure prevents the associated capability being called
operational. Unsupported integrations fail explicitly. Core-only checks remain
useful before worker and console implementations exist; combined-system checks
must refuse to report their absence as a working application.
