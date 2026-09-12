# Agent-Factory

Machine 2/3 is implemented as a small persistence-first meta-agent runtime.

It provides:

- natural-language role compilation into an Agent Manifest;
- explicit, validated agent lifecycle transitions with audit events;
- local runtime/workspace and memory verification before activation;
- approval-gated persistent hiring;
- human approval by default, with governance explicitly configurable;
- recursive agent-initiated recruitment through `AgentContext.request_hire`;
- duplicate, inactive-requester, missing-manager, and recruitment-depth safeguards.

Run the tests with:

```text
python -m unittest discover -s tests -v
```

Minimal usage:

```python
from agent_factory import MetaAgentRuntime, OrganizationStore

runtime = MetaAgentRuntime(OrganizationStore("data/organization.json"))
request = runtime.request_hire("Hire a Social Media Manager for the Growth team")
agent = runtime.approve_hire(request.id)
print(agent.id, agent.status)
```

The default adapter is an actual isolated local runtime. External tools and
models can be connected by implementing the `ExecutionAdapter` protocol.
