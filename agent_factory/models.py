from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentStatus(str, Enum):
    REQUESTED = "REQUESTED"
    SPECIFYING = "SPECIFYING"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    PROVISIONING = "PROVISIONING"
    VERIFYING = "VERIFYING"
    REMEDIATING = "REMEDIATING"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    RECONFIGURING = "RECONFIGURING"
    TERMINATING = "TERMINATING"
    ARCHIVED = "ARCHIVED"


class RequestStatus(str, Enum):
    REQUESTED = "REQUESTED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    PROVISIONING = "PROVISIONING"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"


AGENT_TRANSITIONS: dict[AgentStatus, set[AgentStatus]] = {
    AgentStatus.REQUESTED: {AgentStatus.SPECIFYING, AgentStatus.TERMINATING},
    AgentStatus.SPECIFYING: {
        AgentStatus.AWAITING_APPROVAL,
        AgentStatus.PROVISIONING,
        AgentStatus.TERMINATING,
    },
    AgentStatus.AWAITING_APPROVAL: {
        AgentStatus.PROVISIONING,
        AgentStatus.TERMINATING,
    },
    AgentStatus.PROVISIONING: {
        AgentStatus.VERIFYING,
        AgentStatus.REMEDIATING,
        AgentStatus.TERMINATING,
    },
    AgentStatus.VERIFYING: {
        AgentStatus.ACTIVE,
        AgentStatus.REMEDIATING,
        AgentStatus.TERMINATING,
    },
    AgentStatus.REMEDIATING: {AgentStatus.VERIFYING, AgentStatus.TERMINATING},
    AgentStatus.ACTIVE: {
        AgentStatus.PAUSED,
        AgentStatus.RECONFIGURING,
        AgentStatus.TERMINATING,
    },
    AgentStatus.PAUSED: {AgentStatus.ACTIVE, AgentStatus.TERMINATING},
    AgentStatus.RECONFIGURING: {AgentStatus.VERIFYING, AgentStatus.TERMINATING},
    AgentStatus.TERMINATING: {AgentStatus.ARCHIVED},
    AgentStatus.ARCHIVED: set(),
}


@dataclass
class AgentManifest:
    id: str
    name: str
    role_title: str
    mission: str
    type: str = "employee"
    status: AgentStatus = AgentStatus.REQUESTED
    team: str = "general"
    manager_id: str | None = None
    reports: list[str] = field(default_factory=list)
    responsibilities: list[str] = field(default_factory=list)
    success_metrics: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    permissions: dict[str, Any] = field(default_factory=dict)
    runtime: dict[str, Any] = field(default_factory=dict)
    memory: dict[str, Any] = field(
        default_factory=lambda: {
            "working": "enabled",
            "episodic": "enabled",
            "semantic": "enabled",
            "canonical": "enabled",
        }
    )
    learning: dict[str, Any] = field(
        default_factory=lambda: {"enabled": True, "cadence": "daily"}
    )
    escalation: dict[str, Any] = field(default_factory=dict)
    budget: dict[str, Any] = field(default_factory=dict)
    observability: dict[str, Any] = field(
        default_factory=lambda: {"logs": True, "traces": True, "metrics": True}
    )
    parent_request_id: str | None = None
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentManifest":
        return cls(**{**value, "status": AgentStatus(value["status"])})


@dataclass
class RecruitmentRequest:
    id: str
    requested_by: str
    request_text: str
    business_justification: str
    proposed_role: str
    proposed_team: str
    proposed_manager_id: str | None
    expected_responsibilities: list[str]
    required_tools: list[str]
    expected_operating_cost: float
    expected_benefit: str
    requested_permissions: dict[str, Any]
    status: RequestStatus = RequestStatus.REQUESTED
    manifest_id: str | None = None
    parent_request_id: str | None = None
    depth: int = 0
    decision_by: str | None = None
    decision_reason: str | None = None
    failure_reason: str | None = None
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RecruitmentRequest":
        return cls(**{**value, "status": RequestStatus(value["status"])})
