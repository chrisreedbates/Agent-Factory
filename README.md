# Agent Factory

Agent Factory is a governed control plane for persistent AI employees and bounded consultants. The full product vision is in [Spec.md](Spec.md). Issue [#1](https://github.com/chrisreedbates/Agent-Factory/issues/1) implements the API and shared contracts; runtime and console implementations are separate lanes.

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

## Contracts and handoff

The versioned contract, generated OpenAPI, schemas and concrete fixtures live in [packages/contracts](packages/contracts). `/v1` is the API boundary; only the API accesses PostgreSQL. See [bootstrap and integration rules](docs/control-plane/bootstrap.md) and [authentication, worker protocol, governance and recovery](docs/control-plane/operations.md). The first shared bootstrap commit is recorded in issue #1; sibling machines branch from that exact commit. Do not merge this lane or enable auto-merge before the coordinating machine's integration review.

## Demo target

Prepare two real employees and two employees they autonomously recruit through actual execution, human approval and verified provisioning. In the live segment a child requests another recruit; after human approval, the factory compiles/provisions/verifies the fifth employee, which completes a delegated task and replies. Role names in the spec are examples. One configured real model and restricted workspace-file tools are the MVP default; Slack, CRM, social and email integrations are unavailable.

A working control plane and contract tests do not establish that the whole system or any employee is operational. Final evidence requires the integrated worker, browser and real model/tool workflow described in §24.
