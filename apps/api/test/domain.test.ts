import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DomainError, agentTransitions, assertAgentTransition, assertTaskTransition,
  assertWorkAdmission, assertGraphPosition, assertRetirementAllowed,
  assertCommunicationScope, assertMemoryAccess, assertSupportedGrants, assertVerificationEvidence,
  assertTaskCompletionEvidence, REQUIRED_VERIFICATION_CHECKS,
  type GraphAgent, type OrganizationGraph, type ScopedActor, type ScopedMemory,
} from '../src/domain.js';

const lead: GraphAgent = { id: 'lead', organizationId: 'org', teamId: 'team', managerId: 'ceo', status: 'ACTIVE' };
const child: GraphAgent = { ...lead, id: 'child', managerId: lead.id };
const grandchild: GraphAgent = { ...lead, id: 'grandchild', managerId: child.id };
const graph = (agents: GraphAgent[] = [lead, child]): OrganizationGraph => ({
  agents, teams: [{ id: 'team', organizationId: 'org' }],
  humans: [{ id: 'ceo', organizationId: 'org' }], maxDepth: 3,
});
const throwsCode = (run: () => void, code: string) => assert.throws(run, (error: unknown) => error instanceof DomainError && error.code === code);

test('agent transition topology rejects activation shortcuts and terminal resurrection', () => {
  for (const [from, targets] of Object.entries(agentTransitions)) {
    for (const to of targets) assert.doesNotThrow(() => assertAgentTransition(from, to));
  }
  for (const from of ['REQUESTED', 'AWAITING_APPROVAL', 'PROVISIONING', 'REJECTED', 'ARCHIVED']) {
    throwsCode(() => assertAgentTransition(from, 'ACTIVE'), 'INVALID_TRANSITION');
  }
  throwsCode(() => assertAgentTransition('ACTIVE', 'ACTIVE'), 'INVALID_TRANSITION');
  throwsCode(() => assertAgentTransition('toString', 'ACTIVE'), 'INVALID_TRANSITION');
});

test('tasks require verification and terminal escalations create new work instead of resuming', () => {
  for (const [from, to] of [['CREATED', 'PLANNING'], ['PLANNING', 'EXECUTING'], ['EXECUTING', 'VERIFYING'], ['VERIFYING', 'COMPLETED'], ['VERIFYING', 'RETRYING'], ['RETRYING', 'EXECUTING']]) {
    assertTaskTransition(from!, to!);
  }
  throwsCode(() => assertTaskTransition('EXECUTING', 'COMPLETED'), 'INVALID_TRANSITION');
  throwsCode(() => assertTaskTransition('ESCALATED', 'EXECUTING'), 'INVALID_TRANSITION');
  throwsCode(() => assertTaskTransition('toString', 'FAILED'), 'INVALID_TRANSITION');
  for (const terminal of ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED']) {
    throwsCode(() => assertTaskTransition(terminal, 'CANCELLED'), 'INVALID_TRANSITION');
  }
});

test('only ACTIVE agents admit new execution', () => {
  assertWorkAdmission({ status: 'ACTIVE' });
  for (const status of Object.keys(agentTransitions).filter(s => s !== 'ACTIVE')) {
    throwsCode(() => assertWorkAdmission({ status }), 'AGENT_INACTIVE');
  }
});

test('the three-generation demo resolves to a real human root', () => {
  assertGraphPosition(grandchild, graph());
  throwsCode(() => assertGraphPosition({ ...lead, managerId: 'nonexistent' }, graph()), 'INVALID_MANAGER');
  throwsCode(() => assertGraphPosition(lead, { ...graph(), humans: [] }), 'INVALID_MANAGER');
  throwsCode(() => assertGraphPosition(lead, { ...graph(), humans: [{ id: 'ceo', organizationId: 'other' }] }), 'CROSS_ORGANIZATION');
});

test('graph rejects cross-tenant managers, teams, cycles and fourth-generation recruitment', () => {
  throwsCode(() => assertGraphPosition({ ...lead, managerId: 'child' }, graph()), 'REPORTING_CYCLE');
  throwsCode(() => assertGraphPosition({ ...lead, managerId: 'lead' }, graph()), 'REPORTING_CYCLE');
  throwsCode(() => assertGraphPosition({ ...child, managerId: 'outsider' }, graph([lead, { ...lead, id: 'outsider', organizationId: 'other' }])), 'CROSS_ORGANIZATION');
  throwsCode(() => assertGraphPosition({ ...child, teamId: 'missing' }, graph()), 'INVALID_TEAM');
  throwsCode(() => assertGraphPosition(child, { ...graph(), teams: [{ id: 'team', organizationId: 'other' }] }), 'INVALID_TEAM');
  throwsCode(() => assertGraphPosition({ ...grandchild, id: 'fourth', managerId: grandchild.id }, graph([lead, child, grandchild])), 'RECRUITMENT_DEPTH');
});

test('reparenting checks depth of all existing descendants', () => {
  const secondRoot = { ...lead, id: 'secondRoot' };
  throwsCode(() => assertGraphPosition({ ...lead, managerId: secondRoot.id }, graph([lead, child, grandchild, secondRoot])), 'RECRUITMENT_DEPTH');
});

test('retirement cannot silently orphan reports, including reports still retiring', () => {
  for (const status of ['REQUESTED', 'ACTIVE', 'PAUSED', 'TERMINATING']) {
    throwsCode(() => assertRetirementAllowed(lead.id, [{ ...child, status }]), 'REPORTS_REQUIRE_REASSIGNMENT');
  }
  assertRetirementAllowed(lead.id, [{ ...child, status: 'ARCHIVED' }, { ...child, status: 'REJECTED' }]);
  throwsCode(() => assertGraphPosition(child, graph([{ ...lead, status: 'TERMINATING' }])), 'INVALID_MANAGER');
});

const actor: ScopedActor = { id: 'child', kind: 'agent', organizationId: 'org', teamId: 'team', managerId: 'lead' };
test('communication scope permits direct reporting, team peers, and humans only inside the tenant', () => {
  for (const recipient of [
    { ...actor, id: 'peer' }, { ...actor, id: 'lead', teamId: 'other-team' },
    { ...actor, id: 'report', teamId: 'other-team', managerId: actor.id },
    { ...actor, id: 'human', kind: 'human' as const },
  ]) assertCommunicationScope(actor, recipient);
  throwsCode(() => assertCommunicationScope(actor, { ...actor, id: 'stranger', teamId: 'other-team', managerId: 'other-manager' }), 'COMMUNICATION_FORBIDDEN');
  throwsCode(() => assertCommunicationScope(actor, { ...actor, kind: 'human', organizationId: 'other' }), 'CROSS_ORGANIZATION');
  throwsCode(() => assertCommunicationScope({ ...actor, teamId: undefined }, { ...actor, id: 'stranger', teamId: undefined, managerId: 'other-manager' }), 'COMMUNICATION_FORBIDDEN');
});

const memory: ScopedMemory = { organizationId: 'org', ownerAgentId: actor.id, scope: { visibility: 'private', teamId: 'team', agentIds: [] }, category: 'episodic' };
test('memory retrieval is scoped; shared visibility never grants write authority', () => {
  assertMemoryAccess(actor, memory, 'read');
  assertMemoryAccess(actor, memory, 'write');
  throwsCode(() => assertMemoryAccess({ ...actor, id: 'peer' }, memory, 'read'), 'MEMORY_FORBIDDEN');
  assertMemoryAccess({ ...actor, id: 'peer' }, { ...memory, scope: { ...memory.scope, visibility: 'team' } }, 'read');
  throwsCode(() => assertMemoryAccess({ ...actor, id: 'peer', teamId: 'other' }, { ...memory, scope: { ...memory.scope, visibility: 'team' } }, 'read'), 'MEMORY_FORBIDDEN');
  assertMemoryAccess({ ...actor, id: 'other', teamId: 'other' }, { ...memory, scope: { ...memory.scope, visibility: 'organization' } }, 'read');
  throwsCode(() => assertMemoryAccess({ ...actor, id: 'peer' }, { ...memory, scope: { ...memory.scope, visibility: 'organization' } }, 'write'), 'MEMORY_FORBIDDEN');
  throwsCode(() => assertMemoryAccess({ ...actor, organizationId: 'other' }, { ...memory, scope: { ...memory.scope, visibility: 'organization' } }, 'read'), 'CROSS_ORGANIZATION');
  throwsCode(() => assertMemoryAccess(actor, { ...memory, category: 'canonical' }, 'write'), 'APPROVAL_REQUIRED');
});

test('explicit communication policy constrains team peers and human contact', () => {
  const restricted = { ...actor, communication: { allowedAgentIds: ['approved-peer'], canContactManager: true, canContactHuman: false } };
  throwsCode(() => assertCommunicationScope(restricted, { ...actor, id: 'peer' }), 'COMMUNICATION_FORBIDDEN');
  throwsCode(() => assertCommunicationScope(restricted, { ...actor, id: 'human', kind: 'human' }), 'COMMUNICATION_FORBIDDEN');
  assertCommunicationScope(restricted, { ...actor, id: 'approved-peer', teamId: 'other-team' });
  assertCommunicationScope(restricted, { ...actor, id: 'lead', teamId: 'other-team' });
});

const grant = { tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null };
test('tool grants reject unavailable integrations, arbitrary authority and incomplete declarations', () => {
  assertSupportedGrants({ tools: ['workspace-files', 'request_hire'], permissions: [grant, { ...grant, tool: 'request_hire', operations: ['request'] }] });
  for (const tool of ['slack', 'github', 'shell', '*', 'toString']) {
    throwsCode(() => assertSupportedGrants({ tools: [tool], permissions: [{ ...grant, tool }] }), 'TOOL_UNAVAILABLE');
  }
  for (const badGrant of [
    { ...grant, operations: ['delete'] }, { ...grant, operations: ['*'] },
    { ...grant, operations: [] }, { ...grant, operations: ['read', 'read'] },
    { ...grant, credentialRef: 'secret' }, { ...grant, resource: '/' },
  ]) throwsCode(() => assertSupportedGrants({ tools: ['workspace-files'], permissions: [badGrant] }), 'INVALID_GRANT');
  throwsCode(() => assertSupportedGrants({ tools: ['workspace-files'], permissions: [] }), 'MISSING_GRANT');
  throwsCode(() => assertSupportedGrants({ tools: ['request_hire'], permissions: [{ ...grant, tool: 'request_hire', operations: ['approve'] }] }), 'INVALID_GRANT');
  throwsCode(() => assertSupportedGrants({ tools: ['workspace-files'], permissions: [grant, grant] }), 'DUPLICATE_GRANT');
});

const evidence = { artifactIds: ['artifact_1'], eventIds: ['event_1'], taskId: null, jobId: 'job_1', summary: 'Persisted observations for this check' };
const checks = REQUIRED_VERIFICATION_CHECKS.map(name => ({ name, passed: true, evidence, error: null }));
test('verification cannot lower mandatory checks, reuse stale approval or claim success without references', () => {
  // These values exercise policy validation only, not actual runtime verification.
  assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks });
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 2, approvedManifestVersion: 1, checks }), 'MANIFEST_NOT_APPROVED');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: null, checks }), 'MANIFEST_NOT_APPROVED');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: [], requiredChecks: [] }), 'VERIFICATION_REQUIRED');
  for (const check of REQUIRED_VERIFICATION_CHECKS) {
    throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: checks.filter(c => c.name !== check) }), 'VERIFICATION_REQUIRED');
  }
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: [...checks, checks[0]!] }), 'DUPLICATE_VERIFICATION');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks, requiredChecks: ['custom_required'] }), 'VERIFICATION_REQUIRED');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: checks.map(c => ({ ...c, passed: false })) }), 'VERIFICATION_FAILED');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: checks.map(c => ({ ...c, error: 'It failed' })) }), 'VERIFICATION_FAILED');
  throwsCode(() => assertVerificationEvidence({ manifestVersion: 1, approvedManifestVersion: 1, checks: checks.map(c => ({ ...c, evidence: { ...evidence, artifactIds: [], eventIds: [] } })) }), 'EVIDENCE_REQUIRED');
});

test('task completion needs substantive referenced evidence', () => {
  assertTaskCompletionEvidence(evidence);
  for (const bad of [
    { ...evidence, summary: '   ' }, { ...evidence, artifactIds: [], eventIds: [] },
    { ...evidence, eventIds: ['', 'event_1'] }, { ...evidence, artifactIds: ['artifact_1', 'artifact_1'] },
  ]) throwsCode(() => assertTaskCompletionEvidence(bad), 'EVIDENCE_REQUIRED');
});

test('governed message tool admits only the bounded send operation', () => {
  assertSupportedGrants({ tools: ['send_message'], permissions: [{ tool: 'send_message', operations: ['send'], resource: null, credentialRef: null }] });
  assert.throws(() => assertSupportedGrants({ tools: ['send_message'], permissions: [{ tool: 'send_message', operations: ['approve'], resource: null, credentialRef: null }] }));
});
