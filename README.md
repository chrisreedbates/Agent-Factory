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

## Manual end-to-end test

The following procedure exercises the control plane, worker, governed approval flow, provisioning, and a delegated task on Windows PowerShell.

### 1. Prepare the environment

Install Node **24.20.0**, pnpm **11.19.0**, Docker Desktop, and PostgreSQL through Docker. From the repository root, install dependencies and create the local environment file:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

Edit `.env` and set two different random tokens, each at least 32 characters long:

```dotenv
OPERATOR_TOKEN=replace-with-a-long-operator-token
WORKER_TOKEN=replace-with-a-different-long-worker-token
```

For a real worker run, also set `MODEL_NAME` and `OPENAI_API_KEY`. Keep model credentials in the worker environment and never in browser code.

### 2. Start PostgreSQL and initialize the database

In Terminal 1:

```powershell
docker compose up -d postgres
docker compose ps
pnpm db:migrate
pnpm db:seed
```

The seed creates the demo organization, teams, operator, worker, factory identity, and canonical standards. It intentionally does not create an active employee or approval.

### 3. Start the API

In Terminal 2, load `.env` into the current PowerShell process and start the API:

```powershell
Get-Content .env | ForEach-Object {
	if ($_ -match '^\s*([^#=]+)=(.*)$') {
		[Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
	}
}
pnpm dev:api
```

The API listens at `http://127.0.0.1:3000`. Leave this terminal running.

### 4. Verify health and operator authentication

In Terminal 3, load `.env` again and test the API:

```powershell
Get-Content .env | ForEach-Object {
	if ($_ -match '^\s*([^#=]+)=(.*)$') {
		[Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
	}
}

Invoke-RestMethod http://127.0.0.1:3000/health

$operatorHeaders = @{
	Authorization = "Bearer $env:OPERATOR_TOKEN"
}

Invoke-RestMethod `
	-Uri http://127.0.0.1:3000/v1/session `
	-Method Get `
	-Headers $operatorHeaders

Invoke-RestMethod `
	-Uri http://127.0.0.1:3000/v1/organization `
	-Method Get `
	-Headers $operatorHeaders
```

The health response should report contract version `1.1.0`. The session response should identify `human-ceo` as a human principal in `org-demo`.

### 5. Create a hiring request

Create a proposal for a research analyst:

```powershell
$hireBody = @{
	justification = "The organization needs a research analyst to produce evidence-backed reports."
	role = "Research Analyst"
	mission = "Research approved topics and produce concise evidence-backed deliverables."
	teamId = "team-research"
	proposedManagerId = "human-ceo"
	proposedManagerKind = "human"
	agentType = "employee"
	responsibilities = @(
		"Read approved research briefs",
		"Analyze source information",
		"Produce written deliverables"
	)
	tools = @("workspace-files")
	grants = @(
		@{
			tool = "workspace-files"
			operations = @("list", "read", "write")
			resource = "agent-scoped"
			credentialRef = $null
		}
	)
	expectedBenefit = "Faster production of reliable research deliverables."
	budget = @{
		modelCallsDaily = 10
		externalSpendDaily = 5
		currency = "USD"
		maxConcurrentTasks = 1
	}
} | ConvertTo-Json -Depth 10

$hireResponse = Invoke-RestMethod `
	-Uri http://127.0.0.1:3000/v1/hiring-requests `
	-Method Post `
	-Headers @{
		Authorization = "Bearer $env:OPERATOR_TOKEN"
		"Content-Type" = "application/json"
		"Idempotency-Key" = "manual-hire-001"
	} `
	-Body $hireBody

$hiringRequestId = $hireResponse.data.id
$agentId = $hireResponse.data.agentId
$hiringRequestId
$agentId
```

### 6. Start the worker

Create the approved source-brief directory and add a test brief:

```powershell
New-Item -ItemType Directory -Force -Path .\sources\$agentId
@"
Research topic: AI agent governance

Produce a short report covering:
1. Why approval boundaries matter.
2. Why evidence should be persisted.
3. Why agents should not invent permissions.
"@ | Set-Content .\sources\$agentId\brief.txt
```

In Terminal 4, load `.env` and start the continuous worker:

```powershell
Get-Content .env | ForEach-Object {
	if ($_ -match '^\s*([^#=]+)=(.*)$') {
		[Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
	}
}
pnpm --filter @agent-factory/worker dev
```

The worker should claim the `compile_manifest` job. Use `pnpm --filter @agent-factory/worker once` instead when a single bounded poll is preferred.

### 7. Review and approve the manifest

Wait until the hiring request has a non-null manifest and status `AWAITING_APPROVAL`:

```powershell
$hireDetails = Invoke-RestMethod `
	-Uri "http://127.0.0.1:3000/v1/hiring-requests/$hiringRequestId" `
	-Method Get `
	-Headers $operatorHeaders

$hireDetails | ConvertTo-Json -Depth 30
```

Approve the exact manifest version returned by the API:

```powershell
$approvalBody = @{
	decision = "approve"
	expectedVersion = $hireDetails.data.version
	manifestVersion = $hireDetails.data.manifestVersion
	reason = "Approved for manual end-to-end testing."
} | ConvertTo-Json

Invoke-RestMethod `
	-Uri "http://127.0.0.1:3000/v1/hiring-requests/$hiringRequestId/decision" `
	-Method Post `
	-Headers @{
		Authorization = "Bearer $env:OPERATOR_TOKEN"
		"Content-Type" = "application/json"
		"Idempotency-Key" = "manual-approval-001"
	} `
	-Body $approvalBody
```

This queues a `provision_agent` job. Keep the worker running and wait for provisioning to finish.

### 8. Verify provisioning

Inspect the agent:

```powershell
Invoke-RestMethod `
	-Uri "http://127.0.0.1:3000/v1/agents/$agentId" `
	-Method Get `
	-Headers $operatorHeaders |
	ConvertTo-Json -Depth 40
```

Success is indicated by `status: "ACTIVE"`. If the model key is missing or a mandatory behavioral check fails, `REMEDIATING` is the expected fail-closed result rather than a successful activation.

### 9. Create and verify a delegated task

After the agent is `ACTIVE`, create a task:

```powershell
$taskBody = @{
	agentId = $agentId
	objective = "Read the approved research brief and summarize the main governance lessons."
	constraints = @(
		"Use only the approved workspace files.",
		"Do not invent facts."
	)
	deliverable = "A Markdown summary saved in the agent workspace."
	deadline = $null
} | ConvertTo-Json -Depth 10

$taskResponse = Invoke-RestMethod `
	-Uri http://127.0.0.1:3000/v1/tasks `
	-Method Post `
	-Headers @{
		Authorization = "Bearer $env:OPERATOR_TOKEN"
		"Content-Type" = "application/json"
		"Idempotency-Key" = "manual-task-001"
	} `
	-Body $taskBody

$taskId = $taskResponse.data.id
$taskId
```

Wait for the worker to complete the task, then inspect the task and supporting evidence:

```powershell
Invoke-RestMethod `
	-Uri "http://127.0.0.1:3000/v1/tasks/$taskId" `
	-Method Get `
	-Headers $operatorHeaders |
	ConvertTo-Json -Depth 40

Invoke-RestMethod http://127.0.0.1:3000/v1/events -Headers $operatorHeaders | ConvertTo-Json -Depth 30
Invoke-RestMethod http://127.0.0.1:3000/v1/usage -Headers $operatorHeaders | ConvertTo-Json -Depth 30
Invoke-RestMethod http://127.0.0.1:3000/v1/resources -Headers $operatorHeaders | ConvertTo-Json -Depth 30
```

The task should reach `COMPLETED` and contain persisted evidence and artifact references. The worker must use approved workspace files and cannot invent permissions.

### 10. Test failure and governance paths

Verify invalid credentials are rejected:

```powershell
Invoke-RestMethod `
	-Uri http://127.0.0.1:3000/v1/organization `
	-Method Get `
	-Headers @{ Authorization = "Bearer invalid-token" }
```

The request should return HTTP `401`. Also create a second hiring request and reject it using `POST /v1/hiring-requests/:id/decision`; verify that its final status is `REJECTED`.

### 11. Run automated checks

```powershell
pnpm check:core
pnpm test:core
pnpm --filter @agent-factory/worker check
pnpm --filter @agent-factory/worker test
```

`pnpm check:combined` intentionally fails until the sibling runtime, web, and E2E lanes are available. The automated tests and this manual flow do not replace final live acceptance with the integrated browser and real-model workflow.

### 12. Stop services without deleting state

Stop the API and worker with `Ctrl+C`, then stop PostgreSQL:

```powershell
docker compose stop
```

Avoid `docker compose down -v` when retaining demo state because it deletes the PostgreSQL volume.

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
