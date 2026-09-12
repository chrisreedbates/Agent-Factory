import type { Queryable, TableName } from './schema.js';

export const seedIds = {
  organization: 'org-demo', human: 'human-ceo', worker: 'worker-local',
  researchTeam: 'team-research', deliveryTeam: 'team-delivery', coordinator: 'meta-factory',
} as const;

/** Idempotent opt-in development setup. Never fabricates hires, approvals or evidence. */
export async function seed(db: Queryable): Promise<void> {
  await db.query('BEGIN');
  try {
    const insert = async (table: TableName, id: string, data: Record<string, unknown>) => {
      await db.query(`INSERT INTO ${table} (id, org_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [id, seedIds.organization, JSON.stringify({ id, organizationId: seedIds.organization, ...data })]);
    };
    await insert('organizations', seedIds.organization, {
      name: 'Agent Factory Demo', mission: 'Build an evidence-backed organization through governed recruitment.',
      metaAgentId: seedIds.coordinator, humanPrincipalId: seedIds.human,
      limits: { maxActiveAgents: 10, maxRecruitmentDepth: 3, maxPendingHires: 10, maxDailySpend: 25 },
    });
    await insert('teams', seedIds.researchTeam, { name: 'Research', mission: 'Gather and verify useful evidence.' });
    await insert('teams', seedIds.deliveryTeam, { name: 'Delivery', mission: 'Turn verified evidence into useful deliverables.' });
    await insert('principals', seedIds.human, { kind: 'human', name: 'Human CEO', role: 'operator' });
    await insert('principals', seedIds.worker, { kind: 'worker', name: 'Local worker', role: 'worker' });
    await insert('principals', seedIds.coordinator, {
      kind: 'factory', name: 'Factory coordinator',
      capabilities: ['compile_manifest', 'provision_agent', 'verify_agent'],
    });
    await insert('memory_entries', 'standards-demo-v1', {
      category: 'canonical', ownerAgentId: null,
      scope: { visibility: 'organization', teamId: null, agentIds: [] },
      title: 'Development operating standards', version: 1,
      content: 'Use approved workspace files. Cite evidence. Ask for human approval before hiring, expanding permissions, changing canonical policy, or retirement. Never represent missing verification as success.',
      provenance: { artifactIds: [], eventIds: [], taskId: null, jobId: null, summary: 'Explicit development bootstrap standards from db/src/seed.ts.' },
      expiresAt: null, supersedesId: null, status: 'ACTIVE', approvedBy: seedIds.human,
    });
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
