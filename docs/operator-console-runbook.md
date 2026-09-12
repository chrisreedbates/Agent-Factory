# Operator-console runbook

Set `VITE_API_ORIGIN` to the control-plane API origin, start the API/worker from the shared lanes, then run `pnpm --filter @agent-factory/web dev`.

Acceptance evidence: create a hiring request through `/v1`; approve its reviewed manifest; observe `/v1/agents/:id` verification checks; confirm the API (not the UI) transitions the agent to `ACTIVE`. For recursive hiring, execute an authenticated child-agent task through the worker and confirm the resulting request has `requestedBy.kind === "agent"` before approval. If credentials, worker, or API are unavailable, the console displays the failure and no success state.
