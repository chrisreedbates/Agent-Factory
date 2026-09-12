from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .compiler import RoleCompiler
from .models import (
    AGENT_TRANSITIONS,
    AgentManifest,
    AgentStatus,
    RecruitmentRequest,
    RequestStatus,
    utc_now,
)
from .store import OrganizationStore


class RuntimeExecutionError(RuntimeError):
    pass


class ExecutionAdapter(Protocol):
    def verify(self, agent: AgentManifest, workspace: Path) -> None: ...

    def execute(self, agent: AgentManifest, task: str, context: "AgentContext") -> Any: ...


class LocalExecutionAdapter:
    """A real local runtime adapter used for the offline MVP.

    It verifies an isolated workspace and gives callers a deterministic
    execution surface. External tools can be attached by implementing the
    same adapter protocol without changing organizational state handling.
    """

    def verify(self, agent: AgentManifest, workspace: Path) -> None:
        workspace.mkdir(parents=True, exist_ok=True)
        probe = workspace / ".runtime-probe"
        probe.write_text(agent.id, encoding="utf-8")
        if probe.read_text(encoding="utf-8") != agent.id:
            raise RuntimeExecutionError("local runtime probe failed")
        probe.unlink()

    def execute(self, agent: AgentManifest, task: str, context: "AgentContext") -> dict[str, Any]:
        if not task.strip():
            raise RuntimeExecutionError("task cannot be empty")
        return {
            "agent_id": agent.id,
            "status": "completed",
            "task": task,
            "note": "Executed by the configured local runtime adapter.",
        }


@dataclass
class AgentContext:
    runtime: "MetaAgentRuntime"
    agent: AgentManifest

    def request_hire(self, request_text: str, **kwargs: Any) -> RecruitmentRequest:
        kwargs.setdefault("parent_request_id", self.agent.parent_request_id)
        return self.runtime.request_hire(
            request_text,
            requested_by=self.agent.id,
            **kwargs,
        )

    def remember(self, category: str, value: Any) -> None:
        self.runtime.remember(self.agent.id, category, value)

    def message_manager(self, message: str) -> None:
        if not self.agent.manager_id:
            raise RuntimeExecutionError(f"{self.agent.id} has no manager")
        self.runtime.send_message(self.agent.id, self.agent.manager_id, message)


Handler = Callable[[AgentContext, str], Any]


class MetaAgentRuntime:
    """Persistence-first runtime for hiring and recursively growing agents."""

    def __init__(
        self,
        store: OrganizationStore | None = None,
        *,
        compiler: RoleCompiler | None = None,
        adapter: ExecutionAdapter | None = None,
        max_recruitment_depth: int = 8,
        allow_agent_approval: bool = False,
    ) -> None:
        self.store = store or OrganizationStore()
        self.compiler = compiler or RoleCompiler()
        self.adapter = adapter or LocalExecutionAdapter()
        self.max_recruitment_depth = max_recruitment_depth
        self.allow_agent_approval = allow_agent_approval
        self.handlers: dict[str, Handler] = {}

    def _event(self, kind: str, **details: Any) -> None:
        self.store.append_event(
            {
                "id": f"evt_{uuid.uuid4().hex[:12]}",
                "kind": kind,
                "at": utc_now(),
                **details,
            }
        )

    def _agents(self) -> dict[str, AgentManifest]:
        return {key: AgentManifest.from_dict(value) for key, value in self.store.state["agents"].items()}

    def _requests(self) -> dict[str, RecruitmentRequest]:
        return {key: RecruitmentRequest.from_dict(value) for key, value in self.store.state["recruitment_requests"].items()}

    def _save_agent(self, agent: AgentManifest) -> None:
        agent.updated_at = utc_now()
        self.store.state["agents"][agent.id] = agent.to_dict()
        self.store.save()

    def _save_request(self, request: RecruitmentRequest) -> None:
        request.updated_at = utc_now()
        self.store.state["recruitment_requests"][request.id] = request.to_dict()
        self.store.save()

    def _transition_agent(self, agent: AgentManifest, target: AgentStatus, *, reason: str) -> None:
        if target not in AGENT_TRANSITIONS[agent.status]:
            raise ValueError(f"invalid agent transition {agent.status.value} -> {target.value}")
        previous = agent.status
        agent.status = target
        self._save_agent(agent)
        self._event(
            "agent.lifecycle.transition",
            agent_id=agent.id,
            from_status=previous.value,
            to_status=target.value,
            reason=reason,
        )

    def _check_requester(self, requested_by: str) -> AgentManifest | None:
        if requested_by == "human":
            return None
        requester = self._agents().get(requested_by)
        if requester is None:
            raise ValueError(f"requesting agent does not exist: {requested_by}")
        if requester.status != AgentStatus.ACTIVE:
            raise ValueError(f"only ACTIVE agents may recruit; {requested_by} is {requester.status.value}")
        return requester

    def _request_depth(self, parent_request_id: str | None) -> int:
        if not parent_request_id:
            return 0
        parent = self._requests().get(parent_request_id)
        if parent is None:
            raise ValueError(f"parent recruitment request does not exist: {parent_request_id}")
        return parent.depth + 1

    def _find_duplicate(self, role: str, team: str, manager_id: str | None) -> str | None:
        role_key = re.sub(r"\W+", "", role.lower())
        for agent in self._agents().values():
            if agent.status in {AgentStatus.TERMINATING, AgentStatus.ARCHIVED}:
                continue
            if re.sub(r"\W+", "", agent.role_title.lower()) == role_key and agent.team == team and agent.manager_id == manager_id:
                return agent.id
        for request in self._requests().values():
            if request.status in {RequestStatus.REJECTED, RequestStatus.FAILED, RequestStatus.COMPLETED}:
                continue
            if re.sub(r"\W+", "", request.proposed_role.lower()) == role_key and request.proposed_team == team and request.proposed_manager_id == manager_id:
                return request.id
        return None

    def _resolve_manager(self, manager_id_or_name: str | None) -> str | None:
        if not manager_id_or_name:
            return None
        agents = self._agents()
        if manager_id_or_name in agents:
            manager = agents[manager_id_or_name]
        else:
            candidate = re.sub(r"\W+", "", manager_id_or_name.lower())
            manager = next(
                (
                    item
                    for item in agents.values()
                    if re.sub(r"\W+", "", item.name.lower()) == candidate
                    or re.sub(r"\W+", "", item.role_title.lower()) == candidate
                ),
                None,
            )
            if manager is None:
                raise ValueError(f"manager does not exist: {manager_id_or_name}")
        if manager.status != AgentStatus.ACTIVE:
            raise ValueError(f"manager must be ACTIVE: {manager.id} is {manager.status.value}")
        return manager.id

    def request_hire(
        self,
        request_text: str,
        *,
        requested_by: str = "human",
        business_justification: str | None = None,
        team: str | None = None,
        manager_id: str | None = None,
        role: str | None = None,
        mission: str | None = None,
        responsibilities: list[str] | None = None,
        tools: list[str] | None = None,
        expected_operating_cost: float | None = None,
        expected_benefit: str | None = None,
        permissions: dict[str, dict[str, bool]] | None = None,
        parent_request_id: str | None = None,
    ) -> RecruitmentRequest:
        requester = self._check_requester(requested_by)
        compiled = self.compiler.compile(
            request_text,
            team=team,
            manager_id=manager_id or (requester.id if requester else None),
            role=role,
            mission=mission,
            responsibilities=responsibilities,
            tools=tools,
            permissions=permissions,
            expected_operating_cost=expected_operating_cost,
            expected_benefit=expected_benefit,
        )
        compiled.manager_id = self._resolve_manager(compiled.manager_id)
        depth = self._request_depth(parent_request_id)
        if depth > self.max_recruitment_depth:
            raise ValueError("maximum recursive recruitment depth exceeded")
        duplicate = self._find_duplicate(compiled.role_title, compiled.team, compiled.manager_id)
        if duplicate:
            raise ValueError(f"duplicate agent or hire request already exists: {duplicate}")

        request_id = f"hire_{uuid.uuid4().hex[:12]}"
        manifest_id = f"agent_{uuid.uuid4().hex[:12]}"
        manifest = AgentManifest(
            id=manifest_id,
            name=compiled.role_title,
            role_title=compiled.role_title,
            mission=compiled.mission,
            status=AgentStatus.REQUESTED,
            team=compiled.team,
            manager_id=compiled.manager_id,
            responsibilities=compiled.responsibilities,
            success_metrics=compiled.success_metrics,
            tools=compiled.tools,
            permissions=compiled.permissions,
            runtime={"model": "configurable", "execution_environment": "local-sandbox"},
            escalation={"manager": compiled.manager_id},
            budget={"model_calls_daily": 10, "external_spend_daily": compiled.expected_operating_cost},
            # The manifest keeps the request that created it so an agent can
            # attribute its own child hires to the recursive recruitment chain.
            parent_request_id=request_id,
        )
        self._save_agent(manifest)
        self._transition_agent(manifest, AgentStatus.SPECIFYING, reason="hire request created")
        self._transition_agent(manifest, AgentStatus.AWAITING_APPROVAL, reason="role compiled")
        request = RecruitmentRequest(
            id=request_id,
            requested_by=requested_by,
            request_text=request_text,
            business_justification=business_justification or f"Capability request from {requested_by}.",
            proposed_role=compiled.role_title,
            proposed_team=compiled.team,
            proposed_manager_id=compiled.manager_id,
            expected_responsibilities=compiled.responsibilities,
            required_tools=compiled.tools,
            expected_operating_cost=compiled.expected_operating_cost,
            expected_benefit=compiled.expected_benefit,
            requested_permissions=compiled.permissions,
            status=RequestStatus.AWAITING_APPROVAL,
            manifest_id=manifest_id,
            parent_request_id=parent_request_id,
            depth=depth,
        )
        self._save_request(request)
        self._event(
            "recruitment.requested",
            request_id=request.id,
            requested_by=requested_by,
            manifest_id=manifest.id,
            role=request.proposed_role,
            team=request.proposed_team,
            manager_id=request.proposed_manager_id,
            depth=depth,
        )
        return request

    submit_hire_request = request_hire

    def approve_hire(self, request_id: str, *, approved_by: str = "human") -> AgentManifest:
        if approved_by != "human" and not self.allow_agent_approval:
            raise PermissionError("persistent hires require human approval")
        request = self._requests().get(request_id)
        if request is None:
            raise KeyError(request_id)
        if request.status != RequestStatus.AWAITING_APPROVAL:
            raise ValueError(f"request {request_id} is not awaiting approval")
        request.status = RequestStatus.APPROVED
        request.decision_by = approved_by
        self._save_request(request)
        self._event("recruitment.approved", request_id=request_id, approved_by=approved_by)
        return self._provision(request)

    def reject_hire(self, request_id: str, *, rejected_by: str = "human", reason: str = "rejected") -> None:
        request = self._requests().get(request_id)
        if request is None:
            raise KeyError(request_id)
        if request.status != RequestStatus.AWAITING_APPROVAL:
            raise ValueError(f"request {request_id} is not awaiting approval")
        request.status = RequestStatus.REJECTED
        request.decision_by = rejected_by
        request.decision_reason = reason
        self._save_request(request)
        if request.manifest_id and request.manifest_id in self.store.state["agents"]:
            agent = AgentManifest.from_dict(self.store.state["agents"][request.manifest_id])
            self._transition_agent(agent, AgentStatus.TERMINATING, reason="hire rejected")
            self._transition_agent(agent, AgentStatus.ARCHIVED, reason="hire rejected")
        self._event("recruitment.rejected", request_id=request_id, rejected_by=rejected_by, reason=reason)

    def _provision(self, request: RecruitmentRequest) -> AgentManifest:
        if not request.manifest_id:
            raise RuntimeExecutionError("approved request has no manifest")
        agent = AgentManifest.from_dict(self.store.state["agents"][request.manifest_id])
        request.status = RequestStatus.PROVISIONING
        self._save_request(request)
        self._transition_agent(agent, AgentStatus.PROVISIONING, reason="hire approved")
        workspace = Path(self.store.path.parent) / "workspaces" / agent.id
        agent.runtime["workspace"] = str(workspace)
        self._save_agent(agent)
        self.store.state["memories"][agent.id] = {
            "working": [],
            "episodic": [],
            "semantic": [],
            "canonical": [],
        }
        self.store.save()
        self._event("agent.provisioned", agent_id=agent.id, workspace=str(workspace))
        self._transition_agent(agent, AgentStatus.VERIFYING, reason="configuration initialized")
        try:
            self.adapter.verify(agent, workspace)
            self._verify_persistence(agent)
        except Exception as exc:
            agent = AgentManifest.from_dict(self.store.state["agents"][agent.id])
            self._transition_agent(agent, AgentStatus.REMEDIATING, reason=str(exc))
            request = RecruitmentRequest.from_dict(self.store.state["recruitment_requests"][request.id])
            request.status = RequestStatus.FAILED
            request.failure_reason = str(exc)
            self._save_request(request)
            self._event("agent.verification.failed", agent_id=agent.id, error=str(exc))
            raise RuntimeExecutionError(f"verification failed for {agent.id}: {exc}") from exc
        agent = AgentManifest.from_dict(self.store.state["agents"][agent.id])
        self._transition_agent(agent, AgentStatus.ACTIVE, reason="behavioral verification passed")
        if agent.manager_id:
            manager = AgentManifest.from_dict(self.store.state["agents"][agent.manager_id])
            if agent.id not in manager.reports:
                manager.reports.append(agent.id)
                self._save_agent(manager)
        request = RecruitmentRequest.from_dict(self.store.state["recruitment_requests"][request.id])
        request.status = RequestStatus.COMPLETED
        self._save_request(request)
        self._event("recruitment.completed", request_id=request.id, agent_id=agent.id)
        return agent

    def _verify_persistence(self, agent: AgentManifest) -> None:
        self.remember(agent.id, "episodic", {"event": "verification", "at": utc_now()})
        self.store.load()
        memories = self.store.state["memories"].get(agent.id, {})
        if not memories.get("episodic"):
            raise RuntimeExecutionError("persistent episodic memory probe failed")

    def register_handler(self, agent_id: str, handler: Handler) -> None:
        if agent_id not in self._agents():
            raise KeyError(agent_id)
        self.handlers[agent_id] = handler

    def run_agent(self, agent_id: str, task: str) -> Any:
        agent = self._agents().get(agent_id)
        if agent is None:
            raise KeyError(agent_id)
        if agent.status != AgentStatus.ACTIVE:
            raise RuntimeExecutionError(f"agent {agent_id} is not active")
        context = AgentContext(self, agent)
        self._event("task.started", agent_id=agent_id, task=task)
        try:
            handler = self.handlers.get(agent_id)
            result = handler(context, task) if handler else self.adapter.execute(agent, task, context)
        except Exception as exc:
            self._event("task.failed", agent_id=agent_id, error=str(exc))
            raise
        self._event("task.completed", agent_id=agent_id)
        return result

    def remember(self, agent_id: str, category: str, value: Any) -> None:
        allowed = {"working", "episodic", "semantic", "canonical"}
        if category not in allowed:
            raise ValueError(f"unknown memory category: {category}")
        if agent_id not in self._agents():
            raise KeyError(agent_id)
        self.store.state.setdefault("memories", {}).setdefault(agent_id, {}).setdefault(category, []).append(value)
        self.store.save()
        self._event("memory.updated", agent_id=agent_id, category=category)

    def send_message(self, sender_id: str, recipient_id: str, message: str) -> None:
        agents = self._agents()
        if sender_id not in agents or recipient_id not in agents:
            raise ValueError("sender and recipient must be known agents")
        self._event("communication.message", sender_id=sender_id, recipient_id=recipient_id, message=message)

    def get_agent(self, agent_id: str) -> AgentManifest:
        try:
            return AgentManifest.from_dict(self.store.state["agents"][agent_id])
        except KeyError as exc:
            raise KeyError(agent_id) from exc

    def pending_hires(self) -> list[RecruitmentRequest]:
        return [request for request in self._requests().values() if request.status == RequestStatus.AWAITING_APPROVAL]

    def organization_chart(self) -> dict[str, Any]:
        agents = self._agents()
        roots = [agent for agent in agents.values() if not agent.manager_id and agent.status != AgentStatus.ARCHIVED]

        def node(agent: AgentManifest) -> dict[str, Any]:
            return {
                "id": agent.id,
                "name": agent.name,
                "role": agent.role_title,
                "status": agent.status.value,
                "reports": [node(agents[child]) for child in agent.reports if child in agents],
            }

        return {"roots": [node(root) for root in roots]}
