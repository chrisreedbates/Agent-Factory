from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class CompiledRole:
    role_title: str
    team: str
    manager_id: str | None
    mission: str
    responsibilities: list[str]
    success_metrics: list[str]
    tools: list[str]
    permissions: dict[str, dict[str, bool]]
    expected_operating_cost: float
    expected_benefit: str


ROLE_DEFAULTS: dict[str, dict[str, object]] = {
    "social media": {
        "tools": ["linkedin", "x", "facebook", "instagram", "analytics"],
        "responsibilities": [
            "create platform-specific content",
            "publish approved content",
            "engage with relevant accounts",
            "report performance",
        ],
        "metrics": ["qualified engagement", "audience growth", "inbound conversations"],
        "team": "growth",
    },
    "visual": {
        "tools": ["image_generation", "brand_library"],
        "responsibilities": [
            "produce visual assets",
            "adapt assets to channel requirements",
            "maintain brand consistency",
        ],
        "metrics": ["asset turnaround time", "approval rate", "campaign performance"],
        "team": "growth",
    },
    "sdr": {
        "tools": ["crm", "email", "linkedin", "company_database"],
        "responsibilities": ["research prospects", "send approved outreach", "update lead status"],
        "metrics": ["qualified conversations", "reply rate", "pipeline contribution"],
        "team": "sales",
    },
    "research": {
        "tools": ["browser", "web_search", "documents"],
        "responsibilities": ["research the assigned question", "cite evidence", "deliver findings"],
        "metrics": ["research quality", "decision usefulness", "delivery time"],
        "team": "strategy",
    },
}


def _clean_role(value: str) -> str:
    value = re.sub(r"^[\s,.:;-]+|[\s,.:;-]+$", "", value)
    value = re.sub(r"\s+", " ", value)
    return value[:1].upper() + value[1:] if value else "Generalist Agent"


class RoleCompiler:
    """Deterministic compiler for the natural-language MVP hiring UX."""

    def compile(
        self,
        request_text: str,
        *,
        team: str | None = None,
        manager_id: str | None = None,
        role: str | None = None,
        mission: str | None = None,
        responsibilities: list[str] | None = None,
        tools: list[str] | None = None,
        permissions: dict[str, dict[str, bool]] | None = None,
        expected_operating_cost: float | None = None,
        expected_benefit: str | None = None,
    ) -> CompiledRole:
        lower = request_text.lower()
        if role:
            role_title = _clean_role(role)
        else:
            match = re.search(r"hire(?: me)?\s+(?:a|an|the)?\s*(.+?)(?=\s+for\s+the?\s+|\s+who\s+|\s+to\s+|\.|$)", request_text, re.I)
            role_title = _clean_role(match.group(1) if match else request_text)

        defaults: dict[str, object] = {}
        for key, candidate in ROLE_DEFAULTS.items():
            if key in lower or key.replace(" ", "") in lower.replace(" ", ""):
                defaults = candidate
                break

        if team is None:
            team_match = re.search(r"\bfor\s+(?:the\s+)?([A-Za-z][\w -]*?)\s+team\b", request_text, re.I)
            team = team_match.group(1).strip().lower() if team_match else str(defaults.get("team", "general"))

        if manager_id is None:
            manager_match = re.search(r"report(?:s|ing)?\s+to\s+([A-Za-z][\w-]*)", request_text, re.I)
            manager_id = manager_match.group(1) if manager_match else None

        if mission is None:
            mission_match = re.search(r"mission\s*(?:is|:)\s*(.+?)(?:\.|$)", request_text, re.I)
            mission = mission_match.group(1).strip() if mission_match else f"Deliver the mission of the {role_title} role."

        final_responsibilities = responsibilities or list(defaults.get("responsibilities", [f"perform {role_title} duties"]))
        final_tools = tools or list(defaults.get("tools", []))
        final_metrics = list(defaults.get("metrics", ["reliability", "mission progress"]))
        final_permissions = permissions or {tool: {"read": True, "write": True} for tool in final_tools}
        cost = float(expected_operating_cost if expected_operating_cost is not None else max(1.0, len(final_tools) * 0.5))
        benefit = expected_benefit or f"Increase organizational capacity for {role_title}."
        return CompiledRole(
            role_title=role_title,
            team=team,
            manager_id=manager_id,
            mission=mission,
            responsibilities=final_responsibilities,
            success_metrics=final_metrics,
            tools=final_tools,
            permissions=final_permissions,
            expected_operating_cost=cost,
            expected_benefit=benefit,
        )
