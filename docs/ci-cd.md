# CI and container delivery

`CI` runs for pull requests, pushes to `main`, and manual requests. `Merge gate` succeeds only after every selected job succeeds. The admission script uses changed files and actual workspace structure to select core, worker, console and combined checks. The selection itself is not runtime verification.

## What is checked

- Pipeline rules run with Node 24.20.0 and built-in Node tests, even before the application workspace exists.
- A core workspace uses pnpm 11.19.0, a frozen lockfile, core typechecks/tests and native PostgreSQL 17.6 API integration.
- Runtime and console implementations run their package-local checks/tests. The console also builds with Vite.
- A complete system runs `check:combined`, installs Chromium for the acceptance harness, and builds all three container images.
- A standalone Python control plane or root-level mock console fails architecture admission. Shared bootstrap package placeholders are allowed alongside core work but are never counted as implemented lanes.
- Missing lanes are listed explicitly. A pipeline-only change can pass without claiming that an application exists. Delivery remains unavailable in that state.

Run the admission checks locally:

```sh
node --test scripts/ci/*.test.mjs
node scripts/ci/inspect.mjs --base-ref origin/main
node scripts/ci/inspect.mjs --require-system
```

The `--require-system` mode fails until the real API, worker, console, combined harness, `verify:live` entry point and Dockerfiles exist. This prevents bootstrap tests from being treated as an integrated application. The tests in a component lane do not substitute for the spec's real model/tool and four-to-five-agent demonstration.

## Container delivery

The default delivery destination is GitHub Container Registry. This pipeline does not deploy a running service to an unspecified host. After successful CI for the current `main` commit, delivery assesses full-system readiness and, when eligible, builds and publishes:

- `ghcr.io/<owner>/<repo>-api:sha-<full-commit-sha>` using the root `Dockerfile`.
- `ghcr.io/<owner>/<repo>-worker:sha-<full-commit-sha>` using `apps/worker/Dockerfile`.
- `ghcr.io/<owner>/<repo>-web:sha-<full-commit-sha>` using `apps/web/Dockerfile`.

Image digests, provenance and SBOMs are recorded. No mutable `latest` tag is written. Package write access exists only on the publish job. Build context contains only the checked-out revision; use `.dockerignore` to exclude credentials and runtime data. Model or operator credentials must never be baked into images.

Automatic delivery skips publication with an explicit summary when integration is incomplete. Manually requesting delivery in that state fails. A manual request must also find successful `CI` for the exact current main SHA. A stale successful run cannot publish a newer or unrelated commit.

## Merge and release policy

Configure `Merge gate` as a required status check in branch protection if enforcement is desired. This workflow does not silently alter repository administration settings. Merges are still subject to review against each issue and Spec.md. Required changes, missing live evidence and failed integration are not waived by a green component check.

For this three-lane build, combine the branches and verify their shared contracts before application merges; then integrate core, runtime and console in that order. Rerun CI and the real live harness on final main. The `verify:live` harness must preserve real approvals/provenance and report missing credentials as a blocker. CI currently performs repeatable code/database checks; it does not fabricate human approvals or claim a model was exercised.

A registry push is delivery of a versioned artifact, not evidence that the full §24 Definition of Done passed. Production deployment and model credentials remain environment-specific configuration. No external social/email/Slack actions are part of the pipeline.
