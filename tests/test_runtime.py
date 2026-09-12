import tempfile
import unittest
from pathlib import Path

from agent_factory import AgentStatus, OrganizationStore, RequestStatus
from agent_factory.runtime import MetaAgentRuntime


class MetaAgentRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = OrganizationStore(Path(self.temp_dir.name) / "organization.json")
        self.runtime = MetaAgentRuntime(self.store)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_hire_requires_approval_and_provisions_active_agent(self) -> None:
        request = self.runtime.request_hire(
            "Hire a Social Media Manager for the Growth team. Their mission is grow organic social presence.",
        )
        self.assertEqual(request.status, RequestStatus.AWAITING_APPROVAL)
        self.assertEqual(len(self.runtime.pending_hires()), 1)
        self.assertEqual(self.runtime.get_agent(request.manifest_id).status, AgentStatus.AWAITING_APPROVAL)
        with self.assertRaises(PermissionError):
            self.runtime.approve_hire(request.id, approved_by="some-agent")

        agent = self.runtime.approve_hire(request.id)

        self.assertEqual(agent.status, AgentStatus.ACTIVE)
        self.assertTrue(Path(agent.runtime["workspace"]).exists())
        self.assertEqual(self.runtime.get_agent(agent.id).status, AgentStatus.ACTIVE)
        self.assertEqual(
            self.store.state["recruitment_requests"][request.id]["status"],
            RequestStatus.COMPLETED.value,
        )
        transition_events = [e for e in self.store.state["events"] if e["kind"] == "agent.lifecycle.transition"]
        self.assertEqual([e["to_status"] for e in transition_events[-3:]], ["PROVISIONING", "VERIFYING", "ACTIVE"])

    def test_recursive_recruitment_is_agent_initiated_and_approval_gated(self) -> None:
        cmo_request = self.runtime.request_hire("Hire a CMO for the Growth team")
        cmo = self.runtime.approve_hire(cmo_request.id)

        def cmo_handler(context, task):
            return context.request_hire(
                "Hire a Visual Content Agent for the Growth team",
                business_justification="Visual production is consuming too much campaign capacity.",
                expected_benefit="Increase campaign throughput.",
            )

        self.runtime.register_handler(cmo.id, cmo_handler)
        result = self.runtime.run_agent(cmo.id, "Identify the next capability gap.")
        self.assertEqual(result.requested_by, cmo.id)
        self.assertEqual(result.status, RequestStatus.AWAITING_APPROVAL)
        self.assertEqual(result.parent_request_id, cmo_request.id)
        self.assertEqual(result.depth, 1)
        self.assertEqual(len(self.runtime.pending_hires()), 1)

        visual = self.runtime.approve_hire(result.id)
        self.assertEqual(visual.status, AgentStatus.ACTIVE)
        self.assertEqual(visual.manager_id, cmo.id)
        self.assertIn(visual.id, self.runtime.get_agent(cmo.id).reports)

    def test_manager_can_be_resolved_from_compiled_request_text(self) -> None:
        cmo_request = self.runtime.request_hire("Hire a CMO")
        cmo = self.runtime.approve_hire(cmo_request.id)
        request = self.runtime.request_hire("Hire a Social Media Manager for the Growth team; report to CMO")
        self.assertEqual(request.proposed_manager_id, cmo.id)

    def test_invalid_requester_duplicate_and_invalid_transition_are_rejected(self) -> None:
        request = self.runtime.request_hire("Hire an SDR")
        agent = self.runtime.approve_hire(request.id)
        with self.assertRaises(ValueError):
            self.runtime.request_hire("Hire another SDR", requested_by="missing-agent")
        with self.assertRaises(ValueError):
            self.runtime.request_hire("Hire an SDR")
        with self.assertRaises(ValueError):
            self.runtime.approve_hire(request.id)
        self.assertEqual(agent.status, AgentStatus.ACTIVE)

    def test_restart_preserves_manifests_memories_and_events(self) -> None:
        request = self.runtime.request_hire("Hire a Research Analyst")
        agent = self.runtime.approve_hire(request.id)
        self.runtime.remember(agent.id, "semantic", {"finding": "devis messaging"})
        restarted = MetaAgentRuntime(OrganizationStore(self.store.path))
        self.assertEqual(restarted.get_agent(agent.id).status, AgentStatus.ACTIVE)
        self.assertEqual(
            restarted.store.state["memories"][agent.id]["semantic"][0]["finding"],
            "devis messaging",
        )
        self.assertGreater(len(restarted.store.state["events"]), 0)


if __name__ == "__main__":
    unittest.main()
