# Failure and evidence matrix

| Capability | Required evidence | Failure handling | Passing substitute? |
| --- | --- | --- | --- |
| Hire compilation and approval | manifest version, reviewed manifest, approval event | disable approval without an exact manifest/version; surface `409` stale state | No |
| Provisioning | agent detail verification checks and resources | show failed check/error and retain lifecycle state | No |
| Task and artifact | task evidence, job event, artifact metadata/content | show failed/escalated status; do not claim delivery | No |
| Messages | delivery status and blocked reason | present blocked/failed delivery as an operator action item | No |
| Governance/lifecycle | versioned proposal/decision and lifecycle event | require expected version; refresh after conflict | No |
| Memory/evaluations/usage | authoritative pages from API | render empty/blocked state, never local fixtures | No |
| Live model/restart | combined harness output plus worker logs and recovery event | mark the gate **BLOCKED** until the live runtime is available | No |

Repeated POST actions include a new idempotency key; responses with `409` are explicitly presented as stale state requiring a refresh and a fresh operator decision. Operator writes always carry the displayed record version as `expectedVersion` where the contract requires it.
