# 7. Recruitment Workflow

The primary workflow is:

`Need → Role Specification → Approval → Provision → Verify → Deploy → Operate → Evaluate → Improve`

Example:

The CMO determines:

> "I need a Social Media Manager."

The CMO submits a hiring request.

The system generates a proposed Agent Manifest.

The human sees:

### Requested Hire

**Role:** Social Media Manager  
**Team:** Growth  
**Manager:** CMO

**Mission:**  
Grow organic social acquisition.

**Required tools:**
- LinkedIn
- X
- Facebook
- Instagram

**Estimated operating cost:**  
$X/day

**Permissions:**
- Read analytics
- Draft posts
- Publish posts
- Engage with users

The human chooses:

`Approve Hire`

The system then provisions the agent.

---

# 8. Recursive Recruitment

Agents may identify organizational capability gaps themselves.

Example:

The Social Media Manager determines:

> "Producing platform-specific visual assets is consuming 37% of my execution capacity. I recommend hiring a Visual Content Agent."

The system creates a recruitment request.

The request should include:

- requesting agent
- business justification
- proposed role
- proposed team
- proposed manager
- expected responsibilities
- required tools
- expected operating cost
- expected benefit
- requested permissions

A human approval gate remains the default for creating persistent agents.

After approval, the meta-agent provisions the new agent automatically.

This creates recursive organizational growth:

```text
Human
  ↓
Meta-Agent
  ↓
CMO
  ↓
Social Media Manager
  ↓
"I need a Visual Content Agent"
  ↓
Recruitment Request
  ↓
Human Approval
  ↓
Meta-Agent provisions Visual Content Agent
```

Agents therefore do not merely execute work.

They can reason about the organizational capabilities required to accomplish their missions.

---

# 9. Provisioning Pipeline

Once a hire is approved, the meta-agent owns provisioning end-to-end.

Provisioning follows:

`Compile → Provision → Configure → Connect → Verify → Deploy`

## 9.1 Role Compilation

Convert the natural-language request into a structured Agent Manifest.

The system should infer reasonable defaults rather than asking the human to specify every implementation detail.

The human should only be interrupted when:

- a consequential decision cannot safely be inferred
- credentials are required
- authorization is required
- significant spending is required
- two materially different interpretations exist

---

## 9.2 Environment Provisioning

Create or assign:

- runtime
- workspace
- secrets
- credentials
- storage
- queues
- schedules
- execution boundaries
- relevant repositories or working directories

The agent should receive an isolated operational environment appropriate to its responsibilities.

---

## 9.3 Model Selection

Select an appropriate model based on:

- task complexity
- reasoning requirements
- latency
- cost
- context requirements
- tool-use reliability
- multimodal requirements
- structured-output reliability

Model selection should be configurable and ideally routable dynamically.

The identity of the agent should NOT be tightly coupled to a particular model.

For example:

`Maya, Social Media Manager`

is the persistent organizational entity.

The model powering Maya may change over time.

---

## 9.4 Tool Provisioning

Determine which tools the role requires.

Examples:

- browser
- web search
- GitHub
- Slack
- CRM
- email
- social APIs
- analytics
- databases
- internal services
- filesystem
- code execution

The system should provision only the tools required for the mission.

---

## 9.5 API and Authentication Provisioning

Where tools require external authentication, the system should:

1. identify the integration
2. determine required scopes
3. request human authorization where necessary
4. complete OAuth or credential setup
5. securely store credentials
6. test authentication
7. test the required API operation

An integration is NOT considered configured merely because credentials exist.

The actual required operation must work.

---

## 9.6 Permissions

Apply least-privilege access.

For example, a Social Media Manager might have:

```yaml
facebook:
  read_posts: true
  create_posts: true
  delete_posts: false
  manage_billing: false

github:
  access: false

crm:
  read_contacts: true
  modify_contacts: false
```

Permission changes should be observable and auditable.

---

## 9.7 Memory Provisioning

Create the appropriate memory architecture for the role.

Persistent agents receive long-lived memory.

Consultants may receive temporary working memory plus access to relevant organizational knowledge.

---

## 9.8 Organizational Context

Provide the agent with:

- company mission
- company strategy relevant to the role
- team mission
- individual mission
- manager
- direct reports
- relevant peers
- organizational standards
- relevant historical knowledge

Agents should understand not merely what task they are performing, but why their role exists.

---

## 9.9 Operating Standards

Attach role-specific standards and playbooks.

Examples:

A Social Media Manager might receive:

- brand guidelines
- tone guidelines
- prohibited content
- engagement standards
- platform-specific playbooks
- publishing standards
- escalation policies

---

## 9.10 Learning Loop

Configure how the agent learns from its own operation.

The learning mechanism should define:

- observations
- metrics
- review cadence
- experimentation rules
- what can be learned autonomously
- what requires approval
- where learned knowledge is stored

---

## 9.11 Escalation

Configure:

- escalation triggers
- escalation destination
- urgency levels
- required context
- expected response behavior

---

## 9.12 Communication

Connect the agent to appropriate communication channels.

The agent should be addressable by:

- humans
- its manager
- authorized teammates
- system services

---

## 9.13 Verification

Before deployment, exercise the real system.

Do not simply verify configuration.

Verify behavior.

---

## 9.14 Deployment

Only after successful verification should the agent transition to:

`ACTIVE`

---

# 10. Memory Architecture

Memory should NOT be implemented as one giant vector database.

Different information has different semantics and lifecycle requirements.

The system should separate at least four categories.

## 10.1 Operational State

Structured database storage.

Examples:

- current tasks
- task states
- schedules
- budgets
- approvals
- agent status
- organizational relationships
- tool configuration
- permissions

This information should generally live in structured relational storage.

---

## 10.2 Working Memory

Temporary context required for current execution.

Working memory may contain:

- current objective
- intermediate reasoning artifacts
- temporary research
- current conversation context
- active tool outputs

Working memory should not automatically become permanent organizational knowledge.

---

## 10.3 Episodic Memory

Records of what happened.

Example:

> "On September 10, we tested founder-story posts against product posts. Founder stories generated 2.4x engagement."

Episodic memory allows an agent to learn from previous actions.

---

## 10.4 Semantic / Retrieval Memory

Knowledge that may need to be retrieved based on relevance.

Examples:

- research
- customer insights
- historical decisions
- market knowledge
- previous experiments

Vector retrieval may be appropriate here.

---

## 10.5 Canonical Memory

Stable organizational truth.

Examples:

- company mission
- brand guidelines
- policies
- operating procedures
- role definitions
- architecture decisions
- approved playbooks

Canonical knowledge should preferably be structured and/or version controlled.

Agents should not silently overwrite canonical organizational truth.

---

# 11. Knowledge Sharing

Knowledge must be routed intentionally.

Not every agent should automatically receive every piece of organizational knowledge.

When an agent or consultant generates useful knowledge, determine:

1. Is this worth preserving?
2. Who needs access to it?
3. Is it temporary, episodic, semantic, or canonical?
4. Does it supersede existing knowledge?
5. Should another agent be notified?
6. Does incorporation require approval?

Example:

A research consultant discovers:

> "French tradespeople respond significantly better to messaging around `devis` than generic `contact us` messaging."

This may be relevant to:

- CMO
- SDR
- Social Media Manager
- Website Optimization Agent

The system should route that learning to the appropriate shared knowledge domain.

---

# 12. Communication Architecture

Agents need explicit communication channels.

## 12.1 Human → Agent

The user should be able to contact any agent directly.

Example:

> "Maya, what are you working on today?"

The system resolves `Maya` to the persistent Social Media Manager agent and provides the appropriate context.

---

## 12.2 Agent → Human

Agents can:

- report progress
- escalate problems
- request approval
- request resources
- request hiring
- surface opportunities

---

## 12.3 Agent → Agent

Agents can communicate with authorized organizational peers.

Examples:

```text
SMM → CMO
"Here are the content themes performing best this week."

SDR → SMM
"I'm seeing repeated objections around price. Could we test content addressing this?"

SMM → Visual Content Agent
"I need three visual variants for tomorrow's campaign."
```

---

## 12.4 Manager → Report

Managers can:

- assign objectives
- delegate work
- review performance
- request changes
- resolve escalations
- approve decisions within their authority

Communication should be persisted and observable.

---

# 13. Escalation System

Every operational agent requires an explicit escalation policy.

Core principle:

> **Act autonomously when confidence and authority are sufficient. Escalate when they are not.**

Potential escalation triggers include:

- uncertainty
- missing permissions
- missing tools
- contradictory instructions
- policy risk
- spending above authority
- irreversible action
- unusual customer situation
- repeated execution failure
- security concern
- strategy decision outside role authority

An escalation should contain:

```yaml
escalation:
  agent: smm_001
  severity: medium
  category: policy_uncertainty

  situation: >
    A customer posted a politically sensitive comment
    on the company Facebook page.

  attempted_actions:
    - reviewed social engagement policy
    - searched previous examples

  reason:
    No existing policy clearly covers this situation.

  recommendation:
    Do not respond publicly until reviewed.

  requested_from:
    cmo_001
```

Resolved escalations should become potential learning events.

---

# 14. Learning Loop

Persistent agents require an explicit improvement loop.

Recommended loop:

`Observe → Measure → Diagnose → Hypothesize → Experiment → Evaluate → Learn → Update`

Example:

The Social Media Manager:

1. publishes content
2. observes performance
3. detects underperformance
4. diagnoses potential causes
5. proposes a hypothesis
6. runs an experiment
7. measures results
8. determines whether the hypothesis was supported
9. stores the result
10. changes future behavior

The system must distinguish between:

**learning from evidence**

and

**silently rewriting one's own instructions**

Agents may autonomously update tactical memory.

Material changes to canonical playbooks, mission, permissions, or standards may require approval.

---

# 15. Performance Management

Each persistent agent should have measurable objectives.

Example:

## Maya
**Social Media Manager**

Status: Active  
Manager: CMO  
Health: Good  
Cost today: $1.73  
Tasks completed: 14  
Escalations: 1  
Failures: 0

### Objectives

- increase qualified engagement
- generate inbound conversations
- maintain publishing cadence
- improve content effectiveness

Performance should combine:

- business outcomes
- execution reliability
- cost efficiency
- policy compliance
- task-level evaluations
- manager evaluation

Agents should not optimize a narrow metric at the expense of the organization's broader mission.

---

# 16. Observability

Humans must be able to understand what the organization is doing.

Every agent should expose:

- status
- current task
- task history
- recent actions
- model calls
- tool calls
- costs
- errors
- escalations
- important decisions
- outputs
- performance metrics
- memory updates
- configuration changes

The system should provide organization-level observability.

Example:

```text
AI ORGANIZATION

CEO
 |
 +-- CMO                         ACTIVE
 |    |
 |    +-- Social Media Manager   WORKING
 |    +-- Content Agent          IDLE
 |
 +-- CTO                         ACTIVE
      |
      +-- QA Agent               ESCALATED
```

Clicking an agent should open its operational console.

---

# 17. Agent Lifecycle State Machine

Agent lifecycle must be explicit.

```text
REQUESTED
    |
    v
SPECIFYING
    |
    v
AWAITING_APPROVAL
    |
    v
PROVISIONING
    |
    v
VERIFYING
    |
    +------ failure ------> REMEDIATING
    |                           |
    |                           v
    +---------------------- VERIFYING
    |
    v
ACTIVE
    |
    +----> PAUSED
    |
    +----> RECONFIGURING
    |
    +----> TERMINATING
                  |
                  v
               ARCHIVED
```

Invalid transitions should be rejected.

Current state must be persisted.

Transitions must be logged.

---

# 18. Task State Machine

Agent work should also use explicit states.

```text
CREATED
   |
   v
PLANNING
   |
   v
EXECUTING
   |
   v
VERIFYING
   |
   +---- failure ---> RETRYING
   |                     |
   |                     v
   +---------------- EXECUTING
   |
   v
COMPLETED
```

Possible terminal states:

- COMPLETED
- FAILED
- ESCALATED
- CANCELLED

Task state should never depend purely on what the model claims happened.

Where possible, external effects should be independently verified.

---

# 19. Failure Modes and Pre-Mortem

Before implementation, perform an adversarial pre-mortem.

The system should explicitly consider material failure modes.

## 19.1 Provisioning

- runtime creation fails
- model unavailable
- malformed configuration
- duplicate agent creation
- partial provisioning succeeds

---

## 19.2 Authentication

- OAuth fails
- OAuth expires
- refresh token revoked
- credentials missing
- permission scope insufficient

---

## 19.3 Tools

- API unavailable
- API rate limited
- API schema changes
- external service returns malformed data
- operation times out
- API reports success but action does not occur

---

## 19.4 Memory

- incorrect memory retrieved
- conflicting canonical knowledge
- stale information
- unauthorized knowledge access
- duplicated memories
- false conclusions become persistent

---

## 19.5 Organization

- manager removed
- circular reporting relationship
- agent requests duplicate employee
- conflicting objectives
- orphaned agent
- inappropriate information sharing between teams

---

## 19.6 Execution

- agent loops indefinitely
- repeated tool failure
- excessive model spend
- duplicate external action
- partial execution
- task succeeds externally but internal state says failed
- task fails externally but internal state says succeeded

External actions should therefore use idempotency mechanisms where possible.

---

## 19.7 Learning

- agent learns from noisy data
- incorrect conclusion becomes canonical
- optimization violates standards
- self-modification causes regression
- short-term performance causes harmful long-term behavior

---

## 19.8 Security

- credential leakage
- prompt injection
- unauthorized API call
- privilege escalation
- malicious external content
- compromised agent requests additional permissions

Material failure modes should have explicit mitigation or escalation behavior.

---

# 20. Human Governance

Humans should retain control over high-impact organizational decisions.

Default approval gates should include:

- hiring persistent agents
- firing agents
- significant permission increases
- new external credentials
- significant spending authority
- modifications to critical organizational policy
- access to sensitive information

The architecture should support progressively delegating these decisions later.

Governance should therefore be configurable rather than permanently hard-coded around human approval.

---

# 21. Hiring UX

Hiring should feel extremely simple.

User:

> "Hire me an SDR."

The system asks only questions it cannot reasonably determine itself.

It then produces:

```text
PROPOSED HIRE

Role: SDR
Team: Sales
Manager: Head of Sales

Mission:
Generate qualified conversations with French SMB owners.

Tools:
✓ CRM
✓ Email
✓ LinkedIn
✓ Company database

Memory:
✓ Sales playbook
✓ ICP
✓ Previous outreach experiments

Estimated Cost:
€2.10/day

Permissions:
✓ Read CRM contacts
✓ Send outbound email
✓ Update lead status
✗ Delete contacts

[Approve Hire]
```

After approval:

```text
Provisioning SDR...

✓ Identity created
✓ Runtime configured
✓ Model selected
✓ Memory initialized
✓ CRM connected
✓ Email connected
✓ Sales playbook loaded
✓ Manager connected
✓ Escalation policy installed
✓ Evaluation suite passed

SDR is now ACTIVE.
```

---

# 22. Firing / Retirement

Removing an agent should also be managed as a lifecycle operation.

When firing an agent:

1. stop new work
2. inspect active work
3. complete, cancel, or transfer active tasks
4. extract useful knowledge
5. transfer ownership of resources
6. archive communication/history
7. revoke credentials
8. disable runtime
9. update organizational graph
10. mark agent ARCHIVED

The organization's knowledge must survive the individual agent.

Firing an agent must not mean deleting organizational memory.

---

# 23. Verification Philosophy

Provisioning is NOT complete because code exists.

Provisioning is complete when the agent actually works.

Every deployment should include behavioral verification.

If an agent supposedly has GitHub access:

> Perform a real, safe GitHub operation.

If it supposedly has Slack access:

> Send a real test communication.

If it supposedly has persistent memory:

> Write information, restart/reinitialize the agent, and verify retrieval.

If it supposedly communicates with its manager:

> Send a test message through the actual communication path.

If it supposedly performs a business operation:

> Exercise the actual operation in a safe environment.

Mocks do not constitute successful end-to-end verification.

---

# 24. Definition of Done

A new agent is NOT considered operational until:

- Agent Manifest exists
- organizational position exists
- manager relationship exists
- runtime exists
- selected model works
- required tools work
- authentication works
- required permissions work
- memory works
- communication works
- escalation works
- logs exist
- observability exists
- evaluation passes
- persistence survives restart
- real end-to-end workflow has been exercised

No TODOs, placeholders, simulated integrations, fake success states, or mocked functionality may be represented as complete.

Before declaring completion, the implementation agent must perform a final self-audit against this Definition of Done.

---

# 25. Hackathon MVP

Do NOT attempt to implement the entire vision during the hackathon.

The goal is one convincing vertical slice demonstrating the architecture.

## Recommended Demo
