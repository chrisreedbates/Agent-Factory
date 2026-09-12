# Machine 3 operator-console verification

The console consumes the control-plane contract `1.1.0` over same-origin `/v1` routes. It has no mock endpoint and does not fabricate a successful runtime state.

## Local web checks

Run `pnpm --filter @agent-factory/web check`, `pnpm --filter @agent-factory/web test`, and `pnpm --filter @agent-factory/web build`. Start local development with `pnpm --filter @agent-factory/web dev` while the API is reachable at `API_ORIGIN` (default `http://127.0.0.1:3000`). Build the deployable container with `docker build -f apps/web/Dockerfile .` from the repository root.

## Readiness smoke probe (not the combined/live gate)

After the corrected core and runtime heads are assembled, run:

```sh
E2E_API_ORIGIN=http://127.0.0.1:3000 E2E_OPERATOR_TOKEN=... node tests/e2e/operator-console-smoke.mjs
```

The command exits `2` as **BLOCKED** if either input is absent. That is intentional: an unavailable runtime, credentials, agent pool, or live model must not be represented as passing evidence.

This probe authenticates and confirms that the organization and agent list are reachable. It is not acceptance evidence and never prints `PASS`. The root-owned combined `verify:live` command remains required for the final demo: exact manifest approval, descendant recruitment, worker/model/tool provisioning, task reply/artifact, learning reuse, consultant retirement, failure paths, and restart/reconciliation must all be recorded there.
