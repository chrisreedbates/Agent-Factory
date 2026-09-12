import { Value } from '@sinclair/typebox/value';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
export const CONTRACT_VERSION = '1.1.0';
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const strings = () => Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 });
const nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
export const Id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' });
export const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$' });
export const Text = Type.String({ minLength: 1, maxLength: 20000 });
export const JsonObject = Type.Record(Type.String(), Type.Unknown());
export const Version = Type.Integer({ minimum: 1 });
export const Nonnegative = Type.Number({ minimum: 0 });
export const AgentStatus = Type.Union(['REQUESTED','SPECIFYING','AWAITING_APPROVAL','PROVISIONING','VERIFYING','REMEDIATING','ACTIVE','PAUSED','RECONFIGURING','REJECTED','TERMINATING','ARCHIVED'].map(value => Type.Literal(value)));
export const TaskStatus = Type.Union(['CREATED','PLANNING','EXECUTING','VERIFYING','RETRYING','COMPLETED','FAILED','ESCALATED','CANCELLED'].map(value => Type.Literal(value)));
export const JobKind = Type.Union(['compile_manifest','provision_agent','reconfigure_agent','run_task','learn','retire_agent'].map(value => Type.Literal(value)));
export const Principal = object({ id: Id, kind: Type.Union(['human','worker','agent','factory'].map(value => Type.Literal(value))), organizationId: Id });
export const AuthContext = object({ principal: Principal, delegatedAgentId: nullable(Id), jobId: nullable(Id), attempt: nullable(Version) });
export const ErrorResponse = object({ error: object({ code: Text, message: Text, retryable: Type.Boolean(), correlationId: Id }) });
export const PageQuery = object({ cursor: Type.Optional(Id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), agentId: Type.Optional(Id), taskId: Type.Optional(Id), status: Type.Optional(Text) });
export const IdParams = object({ id: Id });
export const DelegationHeaders = Type.Object({ 'x-job-id': Type.Optional(Id), 'x-lease-token': Type.Optional(Text), 'x-job-attempt': Type.Optional(Type.String({pattern:'^[1-9][0-9]*$'})) }, {additionalProperties:true});
export const MutationHeaders = Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: true });
export const Scope = object({ visibility: Type.Union(['private','team','organization'].map(value => Type.Literal(value))), teamId: nullable(Id), agentIds: Type.Array(Id) });
export const Evidence = object({ artifactIds: Type.Array(Id), eventIds: Type.Array(Id), taskId: nullable(Id), jobId: nullable(Id), summary: Text });
export const Grant = object({ tool: Text, operations: strings(), resource: nullable(Text), credentialRef: nullable(Id) });
export const Budget = object({ modelCallsDaily: Type.Integer({ minimum: 0 }), externalSpendDaily: Nonnegative, currency: Type.String({ pattern: '^[A-Z]{3}$' }), maxConcurrentTasks: Type.Integer({ minimum: 1, maximum: 100 }) });
export const AgentManifest = object({
  agent: object({ id: Id, name: Text, type: Type.Union([Type.Literal('employee'),Type.Literal('consultant')]) }),
  organization: object({ teamId: Id, managerId: Id, managerKind: Type.Union([Type.Literal('human'),Type.Literal('agent')]), reports: Type.Array(Id) }),
  role: object({ title: Text }), mission: object({ primary: Text }), responsibilities: strings(), successMetrics: strings(),
  runtime: object({ model: Text, executionEnvironment: Type.Literal('sandboxed') }), tools: strings(), permissions: Type.Array(Grant),
  memory: object({ working: Type.Boolean(), episodic: Type.Boolean(), semantic: Type.Boolean(), canonical: Type.Boolean() }),
  learning: object({ enabled: Type.Boolean(), cadence: Text, autonomousChanges: strings(), approvalRequiredChanges: strings() }),
  escalation: object({ managerId: Id, triggers: strings(), defaultSeverity: Type.Union(['low','medium','high','critical'].map(value => Type.Literal(value))) }),
  budget: Budget, observability: object({ logs: Type.Boolean(), traces: Type.Boolean(), metrics: Type.Boolean() }),
  standards: strings(), communication: object({ allowedAgentIds: Type.Array(Id), canContactManager: Type.Boolean(), canContactHuman: Type.Boolean() }),
  context: object({ companyMission: Text, teamMission: Text, canonicalMemoryIds: Type.Array(Id) }),
  evaluation: object({ criteria: strings(), requiredVerificationChecks: strings() }),
  consultant: nullable(object({ deliverable: Text, deadline: nullable(Timestamp), terminationCondition: Text, knowledgeRecipientIds: Type.Array(Id) }))
});
export type AgentManifest = Static<typeof AgentManifest>;
export const baseProperties = { id: Id, organizationId: Id, version: Version, createdAt: Timestamp, updatedAt: Timestamp };
export const Organization = object({ ...baseProperties, name: Text, mission: Text, metaAgentId: Id, humanPrincipalId: Id, limits: object({ maxActiveAgents: Type.Integer({ minimum: 1 }), maxRecruitmentDepth: Type.Integer({ minimum: 3 }), maxPendingHires: Type.Integer({ minimum: 1 }), maxDailySpend: Nonnegative }) });
export const Team = object({ ...baseProperties, name: Text, mission: Text });
export const FactoryCoordinator = object({ ...baseProperties, name: Text, kind: Type.Literal('factory'), capabilities: Type.Array(Type.Union(['compile_manifest','provision_agent','verify_agent'].map(value => Type.Literal(value)))) });
export const Agent = object({ ...baseProperties, manifest: nullable(AgentManifest), manifestVersion: nullable(Version), status: AgentStatus, activity: Type.Union(['idle','queued','working','blocked'].map(value => Type.Literal(value))), metaAgentId: Id, hiringRequestId: Id, requestedBy: Principal, approvedBy: nullable(Id), approvedManifestVersion: nullable(Version), provisionedBy: nullable(Id), cancellationRequested: Type.Boolean() });
export type Agent = Static<typeof Agent>;
export const HireProposal = object({ justification: Text, role: Text, mission: Text, teamId: Id, proposedManagerId: Id, proposedManagerKind: Type.Union([Type.Literal('human'),Type.Literal('agent')]), agentType: Type.Union([Type.Literal('employee'),Type.Literal('consultant')]), responsibilities: strings(), tools: strings(), grants: Type.Array(Grant), expectedBenefit: Text, budget: Budget, consultant: Type.Optional(AgentManifest.properties.consultant) });
export const HiringRequest = object({ ...baseProperties, proposal: HireProposal, requestedBy: Principal, originatingTaskId: nullable(Id), originatingJobId: nullable(Id), proposedManager: Id, metaAgentId: Id, agentId: Id, status: Type.Union(['COMPILING','AWAITING_APPROVAL','APPROVED','REJECTED','PROVISIONING','ACTIVE','FAILED'].map(value => Type.Literal(value))), manifest: nullable(AgentManifest), manifestVersion: nullable(Version), approvedBy: nullable(Id), approvedManifestVersion: nullable(Version), provisionedBy: nullable(Id) });
export const Decision = object({ decision: Type.Union([Type.Literal('approve'),Type.Literal('reject')]), expectedVersion: Version, manifestVersion: Version, reason: Text });
export const Approval = object({ ...baseProperties, subjectType: Text, subjectId: Id, decision: Type.Union([Type.Literal('approve'),Type.Literal('reject')]), approvedBy: Id, approvedManifestVersion: nullable(Version), reason: Text });
export const CreateTask = object({ agentId: Id, objective: Text, constraints: strings(), deliverable: Text, deadline: nullable(Timestamp), parentTaskId: Type.Optional(Id) });
export const Task = object({ ...baseProperties, agentId: Id, objective: Text, constraints: strings(), deliverable: Text, deadline: nullable(Timestamp), parentTaskId: nullable(Id), inputMessageId: nullable(Id), status: TaskStatus, requestedBy: Principal, executedBy: nullable(Id), evidence: nullable(Evidence), cancellationRequested: Type.Boolean() });
export const CreateMessage = object({ recipientId: Id, recipientKind: Type.Union([Type.Literal('human'),Type.Literal('agent')]), content: Text, actionable: Type.Boolean(), inReplyTo: nullable(Id), taskId: nullable(Id) });
export const Message = object({ ...baseProperties, sender: Principal, recipientId: Id, recipientKind: Type.Union([Type.Literal('human'),Type.Literal('agent')]), content: Text, actionable: Type.Boolean(), inReplyTo: nullable(Id), taskId: nullable(Id), inputJobId: nullable(Id), deliveryStatus: Type.Union(['queued','consumed','replied','failed','blocked'].map(value => Type.Literal(value))), blockedReason: nullable(Text) });
export const CreateEscalation = object({ agentId: Id, taskId: nullable(Id), severity: Type.Union(['low','medium','high','critical'].map(value => Type.Literal(value))), category: Text, situation: Text, attemptedActions: strings(), reason: Text, recommendation: Text, requestedFrom: Id });
export const Escalation = object({ ...baseProperties, ...CreateEscalation.properties, status: Type.Union([Type.Literal('OPEN'),Type.Literal('RESOLVED')]), resolution: nullable(Text), resolvedBy: nullable(Id), followUpTaskId: nullable(Id) });
export const MemoryCategory = Type.Union(['working','episodic','semantic','canonical'].map(value => Type.Literal(value)));
export const CreateMemory = object({ ownerAgentId: nullable(Id), category: MemoryCategory, title: Text, content: Text, scope: Scope, provenance: Evidence, expiresAt: nullable(Timestamp), supersedesId: nullable(Id) });
export const Memory = object({ ...baseProperties, ...CreateMemory.properties, status: Type.Union(['PROPOSED','ACTIVE','SUPERSEDED','EXPIRED'].map(value => Type.Literal(value))), approvedBy: nullable(Id) });
export const Learning = object({ ...baseProperties, agentId: Id, observation: Text, hypothesis: Text, conclusion: Text, evidence: Evidence, memoryIds: Type.Array(Id), canonicalRevisionId: nullable(Id) });
export const Evaluation = object({ ...baseProperties, agentId: Id, taskId: nullable(Id), criteria: Text, passed: Type.Boolean(), score: nullable(Type.Number()), evidence: Evidence });
export const Usage = object({ ...baseProperties, agentId: Id, jobId: Id, attempt: Version, modelCalls: Type.Integer({ minimum: 0 }), inputTokens: nullable(Nonnegative), outputTokens: nullable(Nonnegative), cost: nullable(Nonnegative), currency: Type.String({ pattern: '^[A-Z]{3}$' }), status: Type.Union(['RESERVED','SETTLED','RELEASED'].map(value => Type.Literal(value))), reservedCost: Nonnegative });
export const Event = object({ ...baseProperties, agentId: nullable(Id), taskId: nullable(Id), jobId: nullable(Id), attempt: nullable(Version), metaAgentId: Id, hiringRequestId: nullable(Id), correlationId: Id, type: Text, message: Text, data: JsonObject, executedBy: nullable(Id) });
export const Artifact = object({ ...baseProperties, agentId: Id, jobId: Id, attempt: Version, path: Text, contentType: Text, size: Type.Integer({ minimum: 0 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), scope: Scope });
export const VerificationCheck = object({ name: Text, passed: Type.Boolean(), evidence: Evidence, error: nullable(Text) });
export const ProvisioningStep = object({ name: Text, status: Type.Union(['PENDING','RUNNING','PASSED','FAILED'].map(value => Type.Literal(value))), evidence: nullable(Evidence), error: nullable(Text) });
export const Resource = object({ ...baseProperties, agentId: Id, type: Type.Union(['workspace','runtime','credential','tool','queue','schedule'].map(value => Type.Literal(value))), reference: Text, status: Type.Union(['AVAILABLE','UNAVAILABLE','REVOKED'].map(value => Type.Literal(value))), grants: Type.Array(Grant), verification: nullable(VerificationCheck) });
export const Schedule = object({ ...baseProperties, agentId: Id, kind: Type.Union([Type.Literal('run_task'),Type.Literal('learn')]), intervalSeconds: Type.Integer({ minimum: 60 }), nextRunAt: Timestamp, enabled: Type.Boolean(), payload: JsonObject });
export const LifecycleAction = object({ action: Type.Union(['pause','resume','remediate','reconfigure','retire'].map(value => Type.Literal(value))), expectedVersion: Version, reason: Text, manifest: Type.Optional(AgentManifest), transferReportsTo: Type.Optional(Id) });
export const GovernanceProposal = object({ agentId: nullable(Id), kind: Type.Union(['reconfigure','retire','grant','credential','budget','canonical_revision','policy'].map(value => Type.Literal(value))), expectedVersion: Version, reason: Text, changes: JsonObject });
export const Governance = object({ ...baseProperties, ...GovernanceProposal.properties, requestedBy: Principal, status: Type.Union(['PENDING','APPROVED','REJECTED','APPLIED'].map(value => Type.Literal(value))), approvedBy: nullable(Id) });
export const JobPayload = Type.Union([
  object({hiringRequest:HiringRequest,agent:Agent,organization:Organization,teams:Type.Array(Team)}),
  object({agent:Agent,manifest:AgentManifest,manifestVersion:Version}),
  object({agent:Agent,task:Task,inputMessage:nullable(Message)}),
  object({agent:Agent}),
  object({agent:Agent,reason:Text})
]);
export const Job = object({ jobId: Id, kind: JobKind, payloadVersion: Type.Literal(1), organizationId: Id, agentId: nullable(Id), taskId: nullable(Id), metaAgentId: Id, hiringRequestId: nullable(Id), inputMessageId: nullable(Id), idempotencyKey: Text, attempt: Version, leaseToken: Text, leaseExpiresAt: Timestamp, payload: JobPayload });
export type Job = Static<typeof Job>;
export const Lease = object({ leaseToken: Text, attempt: Version });
export const JobClaim = object({ kinds: Type.Array(JobKind, { minItems: 1 }), leaseSeconds: Type.Integer({ minimum: 10, maximum: 300 }) });
export const JobEventInput = object({ ...Lease.properties, type: Text, message: Text, data: JsonObject });
export const JobOutcome = object({ ...Lease.properties, outcome: Type.Union([
  object({ kind: Type.Literal('compile_manifest'), manifest: AgentManifest }),
  object({ kind: Type.Literal('provision_agent'), steps: Type.Array(ProvisioningStep), checks: Type.Array(VerificationCheck), resources: Type.Array(Resource) }),
  object({ kind: Type.Literal('reconfigure_agent'), steps: Type.Array(ProvisioningStep), checks: Type.Array(VerificationCheck), resources: Type.Array(Resource) }),
  object({ kind: Type.Literal('run_task'), evidence: Evidence, summary: Text, reply: nullable(Text) }),
  object({ kind: Type.Literal('learn'), learning: object({ observation: Text, hypothesis: Text, conclusion: Text, evidence: Evidence, memoryIds: Type.Array(Id), canonicalRevisionId: nullable(Id) }) }),
  object({ kind: Type.Literal('retire_agent'), evidence: Evidence, credentialsRevoked: Type.Boolean(), runtimeDisabled: Type.Boolean(), knowledgePreserved: Type.Boolean(), activeTasksResolved: Type.Boolean() })
]) });
export const JobFailure = object({ ...Lease.properties, code: Text, message: Text, retryable: Type.Boolean(), evidence: nullable(Evidence) });
export const JobReceipt = object({ jobId: Id, status: Type.Union(['COMPLETED','FAILED','QUEUED'].map(value => Type.Literal(value))), duplicate: Type.Boolean() });
export const PublishArtifact = object({ ...Lease.properties, path: Type.String({ minLength: 1, maxLength: 1000, pattern: '^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[0-9]+/[A-Za-z0-9_./-]+$' }), contentType: Text, size: Type.Integer({ minimum: 0 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), scope: Scope });
export const BudgetReserve = object({ ...Lease.properties, modelCalls: Type.Integer({ minimum: 0 }), cost: Nonnegative, currency: Type.String({ pattern: '^[A-Z]{3}$' }) });
export const BudgetSettle = object({ ...Lease.properties, reservationId: Id, modelCalls: Type.Integer({ minimum: 0 }), inputTokens: nullable(Nonnegative), outputTokens: nullable(Nonnegative), cost: nullable(Nonnegative) });
export const data = <T extends TSchema>(schema: T) => object({ data: schema });
export const page = <T extends TSchema>(schema: T) => object({ data: Type.Array(schema), nextCursor: nullable(Id) });
export const OrganizationDetail = object({ organization: Organization, teams: Type.Array(Team), coordinator: FactoryCoordinator, agents: Type.Array(Agent) });
export const AgentDetail = object({ agent: Agent, grants: Type.Array(Grant), resources: Type.Array(Resource), verification: Type.Array(VerificationCheck) });
export const Schemas = { Organization, Team, FactoryCoordinator, AgentManifest, Agent, HireProposal, HiringRequest, Approval, Task, Message, Escalation, Memory, Learning, Evaluation, Usage, Event, Artifact, Resource, Schedule, Governance, Job, JobOutcome, ErrorResponse };
export type ApiRoute = { operationId: string; method: 'GET'|'POST'; url: string; auth: 'human'|'worker'|'human-or-agent'|'any'|'public'; schema: { body?: TSchema; params?: TSchema; querystring?: TSchema; headers?: TSchema; response: Record<number, TSchema> } };
const route = (operationId: string, method: 'GET'|'POST', url: string, response: TSchema, body?: TSchema, auth: ApiRoute['auth'] = 'human', list = false): ApiRoute => ({ operationId, method, url, auth, schema: { ...(body ? { body } : {}), ...(url.includes(':id') ? { params: IdParams } : {}), ...(list ? { querystring: PageQuery } : {}), ...((auth==='any'||auth==='human-or-agent'||method==='POST') ? {headers:Type.Object({...((auth==='any'||auth==='human-or-agent')?DelegationHeaders.properties:{}),...((method==='POST'&&!['claimJob','renewJob','login','logout'].includes(operationId))?MutationHeaders.properties:{})},{additionalProperties:true})}:{}), response: { 200: response, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse } } });
export const routes = [
  route('login','POST','/v1/session',data(AuthContext),object({token:Text}),'public'),
  route('logout','POST','/v1/session/logout',data(object({loggedOut:Type.Boolean()})),object({}),'human'),
  route('getSession','GET','/v1/session',data(AuthContext)),
  route('getOrganization','GET','/v1/organization',data(OrganizationDetail)),
  route('listAgents','GET','/v1/agents',page(Agent),undefined,'any',true),
  route('getAgent','GET','/v1/agents/:id',data(AgentDetail),undefined,'any'),
  route('createHiringRequest','POST','/v1/hiring-requests',data(HiringRequest),HireProposal,'human-or-agent'),
  route('listHiringRequests','GET','/v1/hiring-requests',page(HiringRequest),undefined,'any',true),
  route('getHiringRequest','GET','/v1/hiring-requests/:id',data(HiringRequest),undefined,'any'),
  route('decideHiringRequest','POST','/v1/hiring-requests/:id/decision',data(HiringRequest),Decision),
  route('createTask','POST','/v1/tasks',data(Task),CreateTask,'human-or-agent'),
  route('listTasks','GET','/v1/tasks',page(Task),undefined,'any',true),
  route('getTask','GET','/v1/tasks/:id',data(Task),undefined,'any'),
  route('cancelTask','POST','/v1/tasks/:id/cancel',data(Task),object({expectedVersion:Version,reason:Text})),
  route('createMessage','POST','/v1/messages',data(Message),CreateMessage,'human-or-agent'),
  route('listMessages','GET','/v1/messages',page(Message),undefined,'any',true),
  route('createEscalation','POST','/v1/escalations',data(Escalation),CreateEscalation,'human-or-agent'),
  route('listEscalations','GET','/v1/escalations',page(Escalation),undefined,'any',true),
  route('resolveEscalation','POST','/v1/escalations/:id/resolve',data(Escalation),object({expectedVersion:Version,resolution:Text,followUp:nullable(CreateTask)})),
  route('createMemory','POST','/v1/memory',data(Memory),CreateMemory,'human-or-agent'),
  route('listMemory','GET','/v1/memory',page(Memory),undefined,'any',true),
  route('getMemory','GET','/v1/memory/:id',data(Memory),undefined,'any'),
  route('listLearning','GET','/v1/learning',page(Learning),undefined,'any',true),
  route('listEvaluations','GET','/v1/evaluations',page(Evaluation),undefined,'any',true),
  route('listUsage','GET','/v1/usage',page(Usage),undefined,'any',true),
  route('listEvents','GET','/v1/events',page(Event),undefined,'any',true),
  route('listResources','GET','/v1/resources',page(Resource),undefined,'any',true),
  route('listSchedules','GET','/v1/schedules',page(Schedule),undefined,'any',true),
  route('createSchedule','POST','/v1/schedules',data(Schedule),object({agentId:Id,kind:Schedule.properties.kind,intervalSeconds:Schedule.properties.intervalSeconds,nextRunAt:Timestamp,payload:JsonObject})),
  route('lifecycleAction','POST','/v1/agents/:id/lifecycle',data(object({agent:Agent,governance:nullable(Governance)})),LifecycleAction),
  route('createGovernance','POST','/v1/governance',data(Governance),GovernanceProposal,'human-or-agent'),
  route('listGovernance','GET','/v1/governance',page(Governance),undefined,'any',true),
  route('decideGovernance','POST','/v1/governance/:id/decision',data(Governance),object({decision:Type.Union([Type.Literal('approve'),Type.Literal('reject')]),expectedVersion:Version,reason:Text})),
  route('getArtifact','GET','/v1/artifacts/:id',data(Artifact),undefined,'any'),
  route('getArtifactContent','GET','/v1/artifacts/:id/content',Type.String({ contentEncoding:'binary' }),undefined,'any'),
  route('claimJob','POST','/v1/worker/jobs/claim',data(nullable(Job)),JobClaim,'worker'),
  route('renewJob','POST','/v1/worker/jobs/:id/renew',data(object({leaseExpiresAt:Timestamp})),object({...Lease.properties,leaseSeconds:Type.Integer({minimum:10,maximum:300})}),'worker'),
  route('verifyProvisionCommunication','POST','/v1/worker/jobs/:id/verify-communication',data(object({message:Message,escalation:Escalation})),Lease,'worker'),
  route('appendJobEvent','POST','/v1/worker/jobs/:id/events',data(Event),JobEventInput,'worker'),
  route('completeJob','POST','/v1/worker/jobs/:id/complete',data(JobReceipt),JobOutcome,'worker'),
  route('failJob','POST','/v1/worker/jobs/:id/fail',data(JobReceipt),JobFailure,'worker'),
  route('publishArtifact','POST','/v1/worker/jobs/:id/artifacts',data(Artifact),PublishArtifact,'worker'),
  route('reserveBudget','POST','/v1/worker/jobs/:id/budget/reserve',data(Usage),BudgetReserve,'worker'),
  route('settleBudget','POST','/v1/worker/jobs/:id/budget/settle',data(Usage),BudgetSettle,'worker')
] as const;
export const routeById = Object.fromEntries(routes.map(r => [r.operationId,r])) as Record<string, ApiRoute>;
export function openApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.url.replace(/:([A-Za-z]+)/g,'{$1}');
    const parameters: unknown[] = [];
    for (const [location,schema] of [['path',r.schema.params],['query',r.schema.querystring],['header',r.schema.headers]] as const) {
      if (!schema) continue;
      for (const [name,value] of Object.entries(schema.properties)) parameters.push({name,in:location,required:location==='path'||(schema.required??[]).includes(name),schema:value});
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = { operationId:r.operationId, security:r.auth==='public' ? [] : r.auth==='worker' ? [{workerBearer:[]}] : r.auth==='human' ? [{operatorSession:[]}] : [{operatorSession:[]},{workerBearer:[]}], parameters, ...(r.schema.body ? {requestBody:{required:true,content:{'application/json':{schema:r.schema.body}}}} : {}), responses: Object.fromEntries(Object.entries(r.schema.response).map(([status,schema])=>[status,{description:status==='200'?'Success':'Error',content:{[r.operationId==='getArtifactContent'&&status==='200'?'application/octet-stream':'application/json']:{schema}}}])) };
  }
  return {openapi:'3.1.0',info:{title:'Agent Factory Control Plane',version:CONTRACT_VERSION},paths,components:{securitySchemes:{operatorSession:{type:'apiKey',in:'cookie',name:'af_session'},workerBearer:{type:'http',scheme:'bearer'}},schemas:Schemas}};
}

export function validateResponse(schema: TSchema, value: unknown): boolean { return Value.Check(schema,value); }
export function validationErrors(schema: TSchema, value: unknown) { return [...Value.Errors(schema,value)].map(({path,message})=>({path,message})); }

/** Remove service-only fields from a cloned value; never mutate stored state. */
export function cleanResponse(schema: TSchema, value: unknown): unknown {
  const cleaned = Value.Clean(schema, structuredClone(value));
  if (!Value.Check(schema, cleaned)) {
    const errors = validationErrors(schema, cleaned).map(error => `${error.path}: ${error.message}`).join('; ');
    throw new Error(`Response does not match the v1 contract: ${errors}`);
  }
  return cleaned;
}
