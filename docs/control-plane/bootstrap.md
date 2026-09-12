# Shared bootstrap

This repository uses Node 24.20.0 and pnpm 11.19.0. All direct dependencies are exact pins; install with `pnpm install --frozen-lockfile` after checking out the shared bootstrap SHA recorded in issue #1. Each lane branches from that SHA. Machine 1 owns dependency and lockfile amendments across packages.

- Machine 1: apps/api, packages/contracts, db, root configuration and docs/control-plane.
- Machine 2: apps/worker and docs/runtime.
- Machine 3: apps/web, tests/e2e and docs/verification.

The worker and web bootstrap tests validate package wiring only. They are not implementations. `pnpm check:core` and `pnpm test:core` run without sibling implementations. `pnpm check:combined` fails explicitly until all lanes are present.

## Integration boundary

The API alone connects to PostgreSQL. The worker uses `/v1/worker/jobs` and delegated execution calls defined by the shared route contract. Browser requests use an operator session; worker requests use a different credential. Never expose either credential or model API keys in browser builds.

The named Docker volume `agent-factory-workspaces` is persistent. API mounts `/workspaces` read-only; the worker must mount the same named volume at its configured artifact root read/write. Demo input sources are a different read-only bind mount owned by Machine 3's harness. Neither a container filesystem nor a database artifact record preserves file bytes on its own.

The example worker compose override must be supplied by Machine 2 when its startup command exists. This bootstrap intentionally does not start a placeholder worker or UI.

## Verification boundaries

Contract fixtures exercise shapes. They do not prove model calls, tool behavior, recruitment, operational employees, or the final four-to-five-agent demo. Real runtime evidence is produced by Machine 2; final browser and system evidence is recorded by Machine 3 against the integrated commit. Integration happens in a temporary checkout before the coordinating machine merges the lanes, and again on final main.
