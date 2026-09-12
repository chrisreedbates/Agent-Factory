# Agent Factory

Agent Factory is a governed control plane for persistent AI employees and bounded consultants. The full product vision is in [Spec.md](Spec.md). Issue [#1](https://github.com/chrisreedbates/Agent-Factory/issues/1) implements the API and shared contracts; runtime and console implementations are separate lanes. Issue [#2](https://github.com/chrisreedbates/Agent-Factory/issues/2) implements the worker runtime in `apps/worker`.

## Environment

Use Node **24.20.0**, pnpm **11.19.0**, and PostgreSQL **17.6**. Direct dependencies are pinned. Install with `pnpm install --frozen-lockfile`.

```sh
cp .env.example .env
# Set distinct random OPERATOR_TOKEN and WORKER_TOKEN values (at least 32 characters).
docker compose up -d postgres
# Export .env values in your shell before local commands.
pnpm db:migrate
pnpm db:seed
pnpm dev:api
```

The seed creates one organization, two teams, operator/worker/factory identities and canonical standards. It never creates ACTIVE employees, approvals, recruitment history or verification records. Migrations and seed are repeatable. PostgreSQL and workspace volumes persist across restarts; do not use `docker compose down -v` when retaining demo state.

```sh
pnpm check:core
pnpm test:core
pnpm check:combined
```

Core checks are independent. The combined check fails explicitly until sibling runtime, UI and E2E implementations exist. The worker/web bootstrap tests validate package wiring only.

## Use the web console

To test the product through the webpage, run the integrated deployment:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

In `.env`, set distinct `OPERATOR_TOKEN` and `WORKER_TOKEN` values of at least 32 characters. Set `MODEL_NAME` and `OPENAI_API_KEY` for real model execution. Then start the API, worker, database, and web console:

```powershell
docker compose -f compose.yaml -f compose.full.yaml up -d --build
```

Open [http://localhost:8080](http://localhost:8080) in a browser.

### Browser test flow

1. Enter the `OPERATOR_TOKEN` in **Operator session** and select **Start session**.
2. Confirm that the organization graph and seeded teams are visible.
3. In **Hire an agent or consultant**, enter a role, mission, team ID, manager ID, responsibilities, expected benefit, and justification.
4. Select the required tools and submit **Create governed proposal**.
5. Wait for the proposal to appear under **Exact manifest decisions** with a compiled manifest.
6. Expand and review the complete manifest. Select **Approve reviewed version** only if the role, manager, tools, permissions, budget, and evaluation criteria are correct. Otherwise select **Reject**.
7. Select the new agent in the organization graph and watch its verification checks. A successful provisioning flow ends with status `ACTIVE`.
8. After activation, use **Tasks and messages** to create a task for the agent. Confirm that the task completes and that its evidence, events, resources, evaluations, usage, and artifacts appear in the inspection sections.
9. Use **Escalations and governance** to exercise escalation handling. Use the agent detail actions to pause, resume, remediate, or retire an agent when appropriate.
10. For recursive recruitment, select an agent that has the `request_hire` capability, create or run its task, and confirm that the resulting hire is shown under **Recursive recruitment** with `requestedBy` identified as an agent. Human approval is still required.
11. Use **End session** when finished.

If the API, worker, model credential, or required verification check is unavailable, the console should show an error or a non-active status. It must not display a false success state.

To stop the deployment without deleting persisted state:

```powershell
docker compose -f compose.yaml -f compose.full.yaml down
```

Avoid `docker compose down -v` unless the database and demo state should be deleted.

## Worker runtime

`apps/worker` is the Machine 2 runtime. It polls the control plane at `POST /v1/worker/jobs/claim` and executes the six fenced job kinds (`compile_manifest`, `provision_agent`, `reconfigure_agent`, `run_task`, `learn`, `retire_agent`). It never opens PostgreSQL; every mutation goes through `/v1` with the worker credential and the current lease. Mutating calls use a deterministic `Idempotency-Key`, budget is reserved before model calls and settled afterwards, and artifacts are written to the shared workspace volume and published by hash. See [docs/runtime/README.md](docs/runtime/README.md) for configuration and the job protocol, and [docs/runtime/self-audit.md](docs/runtime/self-audit.md) for the Machine 2 verification boundary.

```sh
pnpm --filter @agent-factory/worker dev    # poll and execute jobs in a loop
pnpm --filter @agent-factory/worker once   # run a single bounded pass (useful for smoke checks)
```

## Contracts and handoff

The versioned contract, generated OpenAPI, schemas and concrete fixtures live in [packages/contracts](packages/contracts). `/v1` is the API boundary; only the API accesses PostgreSQL. See [bootstrap and integration rules](docs/control-plane/bootstrap.md) and [authentication, worker protocol, governance and recovery](docs/control-plane/operations.md). The first shared bootstrap commit is recorded in issue #1; sibling machines branch from that exact commit. Do not merge this lane or enable auto-merge before the coordinating machine's integration review.

## Demo target

Prepare two real employees and two employees they autonomously recruit through actual execution, human approval and verified provisioning. In the live segment a child requests another recruit; after human approval, the factory compiles/provisions/verifies the fifth employee, which completes a delegated task and replies. Role names in the spec are examples. One configured real model and restricted workspace-file tools are the MVP default; Slack, CRM, social and email integrations are unavailable.

A working control plane and contract tests do not establish that the whole system or any employee is operational. Final evidence requires the integrated worker, browser and real model/tool workflow described in §24.
