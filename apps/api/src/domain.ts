/** Pure policy checks. Callers must load current state and commit under the same transaction. */
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'DomainError';
  }
}

export const agentTransitions: Readonly<Record<string, readonly string[]>> = {
  REQUESTED: ['SPECIFYING'],
  SPECIFYING: ['AWAITING_APPROVAL', 'REMEDIATING'],
  AWAITING_APPROVAL: ['PROVISIONING', 'REJECTED'],
  PROVISIONING: ['VERIFYING', 'REMEDIATING', 'TERMINATING'],
  VERIFYING: ['ACTIVE', 'REMEDIATING', 'TERMINATING'],
  REMEDIATING: ['SPECIFYING', 'PROVISIONING', 'VERIFYING', 'RECONFIGURING', 'TERMINATING'],
  ACTIVE: ['PAUSED', 'RECONFIGURING', 'TERMINATING'],
  PAUSED: ['ACTIVE', 'RECONFIGURING', 'TERMINATING'],
  RECONFIGURING: ['VERIFYING', 'REMEDIATING', 'TERMINATING'],
  TERMINATING: ['ARCHIVED'],
  ARCHIVED: [],
  REJECTED: [],
};

export function assertAgentTransition(from: string, to: string): void {
  if (!Object.hasOwn(agentTransitions, from) || !agentTransitions[from]!.includes(to)) {
    throw new DomainError('INVALID_TRANSITION', `Agent cannot transition from ${from} to ${to}`);
  }
}

const taskTransitions: Readonly<Record<string, readonly string[]>> = {
  CREATED: ['PLANNING'], PLANNING: ['EXECUTING'], EXECUTING: ['VERIFYING'],
  VERIFYING: ['COMPLETED', 'RETRYING'], RETRYING: ['EXECUTING'],
  COMPLETED: [], FAILED: [], ESCALATED: [], CANCELLED: [],
};
const terminalTasks = new Set(['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED']);
export function assertTaskTransition(from: string, to: string): void {
  if (!Object.hasOwn(taskTransitions, from) || terminalTasks.has(from) ||
      (!taskTransitions[from]!.includes(to) && !['FAILED', 'ESCALATED', 'CANCELLED'].includes(to))) {
    throw new DomainError('INVALID_TRANSITION', `Task cannot transition from ${from} to ${to}`);
  }
}

export function assertWorkAdmission(agent: { status: string }): void {
  if (agent.status !== 'ACTIVE') throw new DomainError('AGENT_INACTIVE', 'Only ACTIVE agents may start work');
}

export interface GraphAgent {
  id: string;
  organizationId: string;
  teamId: string;
  managerId: string;
  status: string;
}
export interface GraphTeam { id: string; organizationId: string }
export interface GraphHuman { id: string; organizationId: string }
export interface OrganizationGraph {
  agents: readonly GraphAgent[];
  teams: readonly GraphTeam[];
  humans: readonly GraphHuman[];
  /** Maximum number of agents between the human root and a leaf; three supports the demo. */
  maxDepth: number;
}
const inactiveManagers = new Set(['ARCHIVED', 'REJECTED', 'TERMINATING']);

/** Validate the prospective graph, including descendants whose depth changes after reparenting. */
export function assertGraphPosition(candidate: GraphAgent, graph: OrganizationGraph): void {
  if (!Number.isInteger(graph.maxDepth) || graph.maxDepth < 1) {
    throw new DomainError('INVALID_LIMIT', 'Recruitment depth must be a positive integer', 400);
  }
  const nodes = graph.agents.filter(a => a.id !== candidate.id).concat(candidate);
  const agents = new Map<string, GraphAgent>();
  for (const node of nodes) {
    if (agents.has(node.id)) throw new DomainError('INVALID_GRAPH', 'Duplicate agent identity');
    agents.set(node.id, node);
  }
  const teams = new Map(graph.teams.map(t => [t.id, t]));
  const humans = new Map(graph.humans.map(h => [h.id, h]));
  for (const node of nodes) {
    if (node.organizationId !== candidate.organizationId || inactiveManagers.has(node.status)) continue;
    if (humans.has(node.id)) throw new DomainError('INVALID_GRAPH', 'Human and agent identities must be distinct');
    if (teams.get(node.teamId)?.organizationId !== node.organizationId) {
      throw new DomainError('INVALID_TEAM', 'Team must exist in the same organization', 400);
    }
    let current = node;
    let depth = 0;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(current.id)) throw new DomainError('REPORTING_CYCLE', 'Reporting relationships must not contain a cycle');
      seen.add(current.id);
      depth++;
      if (depth > graph.maxDepth) throw new DomainError('RECRUITMENT_DEPTH', 'Recruitment depth limit exceeded');
      const human = humans.get(current.managerId);
      if (human) {
        if (human.organizationId !== node.organizationId) {
          throw new DomainError('CROSS_ORGANIZATION', 'Manager must belong to the same organization', 403);
        }
        break;
      }
      const manager = agents.get(current.managerId);
      if (!manager || inactiveManagers.has(manager.status)) {
        throw new DomainError('INVALID_MANAGER', 'Manager must exist and must not be retiring, archived, or rejected', 400);
      }
      if (manager.organizationId !== node.organizationId) {
        throw new DomainError('CROSS_ORGANIZATION', 'Manager must belong to the same organization', 403);
      }
      current = manager;
    }
  }
}

export function assertRetirementAllowed(agentId: string, agents: readonly GraphAgent[]): void {
  if (agents.some(agent => agent.managerId === agentId && !['ARCHIVED', 'REJECTED'].includes(agent.status))) {
    throw new DomainError('REPORTS_REQUIRE_REASSIGNMENT', 'Reassign or archive all reports before retiring their manager');
  }
}

export interface ScopedActor {
  id: string;
  organizationId: string;
  kind: 'human' | 'agent';
  teamId?: string;
  managerId?: string;
  communication?: { allowedAgentIds: readonly string[]; canContactManager: boolean; canContactHuman: boolean };
}

/** Same-team peers and direct reporting relationships are authorized communication paths. */
export function assertCommunicationScope(sender: ScopedActor, recipient: ScopedActor): void {
  if (sender.organizationId !== recipient.organizationId) {
    throw new DomainError('CROSS_ORGANIZATION', 'Communication cannot cross organizations', 403);
  }
  if (sender.kind === 'human' || sender.id === recipient.id) return;
  if (sender.communication) {
    if (recipient.kind === 'human' ? sender.communication.canContactHuman :
        sender.communication.allowedAgentIds.includes(recipient.id) ||
        (sender.managerId === recipient.id && sender.communication.canContactManager) ||
        recipient.managerId === sender.id) return;
  } else if (recipient.kind === 'human' ||
      (sender.teamId !== undefined && sender.teamId === recipient.teamId) ||
      sender.managerId === recipient.id || recipient.managerId === sender.id) return;
  throw new DomainError('COMMUNICATION_FORBIDDEN', 'Agents may contact only their manager, direct reports, or team peers', 403);
}

export interface ScopedMemory {
  organizationId: string;
  ownerAgentId: string | null;
  scope: { visibility: 'private' | 'team' | 'organization'; teamId: string | null; agentIds: readonly string[] };
  category: 'working' | 'episodic' | 'semantic' | 'canonical';
}

export function assertMemoryAccess(actor: ScopedActor, memory: ScopedMemory, action: 'read' | 'write'): void {
  if (actor.organizationId !== memory.organizationId) {
    throw new DomainError('CROSS_ORGANIZATION', 'Memory cannot cross organizations', 403);
  }
  if (actor.kind === 'human') return;
  // Canonical mutations go through a separately approved proposal, even for the owner.
  if (action === 'write') {
    if (memory.category === 'canonical') throw new DomainError('APPROVAL_REQUIRED', 'Canonical revisions require human approval', 403);
    if (actor.id === memory.ownerAgentId) return;
  } else if (actor.id === memory.ownerAgentId || memory.scope.agentIds.includes(actor.id) || memory.scope.visibility === 'organization' ||
      (memory.scope.visibility === 'team' && memory.scope.teamId !== null && actor.teamId === memory.scope.teamId)) return;
  throw new DomainError('MEMORY_FORBIDDEN', 'Memory scope does not authorize this operation', 403);
}

export interface ToolGrant {
  tool: string;
  operations: readonly string[];
  resource: string | null;
  credentialRef: string | null;
}
const supportedOperations: Readonly<Record<string, readonly string[]>> = {
  'workspace-files': ['read', 'write', 'list'],
  request_hire: ['request'],
  send_message: ['send'],
};

/** Local MVP capabilities only. null resource means the owning agent's isolated workspace. */
export function assertSupportedGrants(manifest: { tools: readonly string[]; permissions: readonly ToolGrant[] }): void {
  if (new Set(manifest.tools).size !== manifest.tools.length) {
    throw new DomainError('DUPLICATE_TOOL', 'Tool declarations must be unique', 400);
  }
  for (const tool of manifest.tools) {
    if (!Object.hasOwn(supportedOperations, tool)) throw new DomainError('TOOL_UNAVAILABLE', `Tool ${tool} is unavailable in this deployment`, 422);
  }
  const grants = new Set<string>();
  for (const grant of manifest.permissions) {
    if (!Object.hasOwn(supportedOperations, grant.tool) || !manifest.tools.includes(grant.tool)) {
      throw new DomainError('TOOL_UNAVAILABLE', 'Every grant must name an available declared tool', 422);
    }
    if (grants.has(grant.tool)) throw new DomainError('DUPLICATE_GRANT', 'Only one grant per tool is allowed', 400);
    grants.add(grant.tool);
    if (grant.operations.length === 0 || new Set(grant.operations).size !== grant.operations.length ||
        grant.operations.some(op => !supportedOperations[grant.tool]!.includes(op))) {
      throw new DomainError('INVALID_GRANT', `Unsupported or duplicate operation for ${grant.tool}`, 422);
    }
    if (grant.resource !== null || grant.credentialRef !== null) {
      throw new DomainError('INVALID_GRANT', 'Local capabilities cannot grant external resources or credentials', 422);
    }
  }
  if (manifest.tools.some(tool => !grants.has(tool))) {
    throw new DomainError('MISSING_GRANT', 'Each declared tool requires an explicit grant', 400);
  }
}

export interface Evidence {
  artifactIds: readonly string[];
  eventIds: readonly string[];
  taskId: string | null;
  jobId: string | null;
  summary: string;
}
export interface VerificationCheck {
  name: string;
  passed: boolean;
  evidence: Evidence;
  error: string | null;
}
export const REQUIRED_VERIFICATION_CHECKS = [
  'runtime', 'model', 'tools', 'authentication', 'permissions', 'memory',
  'communication', 'escalation', 'observability', 'evaluation', 'restart', 'end_to_end',
] as const;

/** Structural evidence admission only; the API must resolve every reference under the current lease. */
export function assertTaskCompletionEvidence(evidence: Evidence): void {
  if (!evidence.summary.trim() || evidence.artifactIds.length + evidence.eventIds.length === 0 ||
      [...evidence.artifactIds, ...evidence.eventIds].some(id => !id.trim()) ||
      new Set(evidence.artifactIds).size !== evidence.artifactIds.length ||
      new Set(evidence.eventIds).size !== evidence.eventIds.length) {
    throw new DomainError('EVIDENCE_REQUIRED', 'Completion requires a summary and distinct persisted artifact or event references', 422);
  }
}

export function assertVerificationEvidence(input: {
  manifestVersion: number;
  approvedManifestVersion: number | null;
  checks: readonly VerificationCheck[];
  requiredChecks?: readonly string[];
}): void {
  if (!Number.isInteger(input.manifestVersion) || input.manifestVersion < 1 || input.approvedManifestVersion !== input.manifestVersion) {
    throw new DomainError('MANIFEST_NOT_APPROVED', 'Verification must bind the exact approved manifest version');
  }
  const required = new Set<string>([...REQUIRED_VERIFICATION_CHECKS, ...(input.requiredChecks ?? [])]);
  const checks = new Map<string, VerificationCheck>();
  for (const check of input.checks) {
    if (checks.has(check.name)) throw new DomainError('DUPLICATE_VERIFICATION', 'Verification check names must be unique', 422);
    if (!check.passed || check.error !== null) {
      throw new DomainError('VERIFICATION_FAILED', `Verification failed: ${check.name}`, 422);
    }
    assertTaskCompletionEvidence(check.evidence);
    checks.set(check.name, check);
  }
  for (const name of required) {
    if (!checks.has(name)) throw new DomainError('VERIFICATION_REQUIRED', `Missing mandatory verification: ${name}`, 422);
  }
}
