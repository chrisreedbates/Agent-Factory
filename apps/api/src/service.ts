import { randomUUID } from 'node:crypto';
import { AgentManifest, validateResponse } from '@agent-factory/contracts';
import type { TableName } from '@agent-factory/db';
import { Store, type Actor, type RecordData, expected, principal, digest } from './store.js';
import { enqueue } from './worker.js';
import { DomainError, assertGraphPosition, assertCommunicationScope, assertMemoryAccess, assertSupportedGrants, assertWorkAdmission, assertRetirementAllowed, assertAgentTransition, assertVerificationEvidence, type ScopedActor } from './domain.js';
import { readArtifact } from './artifacts.js';
const fail = (code:string,message:string,status=409):never => { throw new DomainError(code,message,status); };
export function assertUtcTimestamp(value:unknown,field:string): void {
  if(value===null||value===undefined)return;
  const match=typeof value==='string'?/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?Z$/.exec(value):null;
  const parsed=typeof value==='string'?Date.parse(value):NaN;
  if(!match||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,19)!==match[1])fail('INVALID_TIMESTAMP',`${field} must be an actual UTC calendar timestamp`,400);
}
const terminal = (status:string) => ['COMPLETED','FAILED','ESCALATED','CANCELLED'].includes(status);
export class Service {
  constructor(public s: Store, public actor: Actor, public artifactRoot: string) {}
  assertHuman() { if(this.actor.kind!=='human')fail('HUMAN_APPROVAL_REQUIRED','This operation requires the authenticated human operator',403); }
  async assertActiveActor() { if(this.actor.kind==='agent')assertWorkAdmission(await this.s.get('agents',this.actor.id) as any); }
  async canReadAgent(agent:RecordData) { return this.actor.kind==='human'||agent.id===this.actor.id||agent.manifest?.organization.managerId===this.actor.id; }
  async org() { return this.s.get('organizations',this.s.organizationId); }
  async graph() {
    const agents = await this.s.list('agents');
    return { agents: agents.map(a=>this.graphAgent(a)), teams: await this.s.list('teams') as any, humans: (await this.s.list('principals')).filter(p=>p.kind==='human') as any, maxDepth:(await this.org()).limits.maxRecruitmentDepth };
  }
  graphAgent(a:RecordData) { return { id:a.id,organizationId:a.organizationId,teamId:a.manifest?.organization.teamId ?? a.teamId,managerId:a.manifest?.organization.managerId ?? a.managerId,status:a.status }; }
  async validateManifest(manifest: any, agentId: string) {
    if (!validateResponse(AgentManifest,manifest)) fail('INVALID_MANIFEST','Manifest does not match the shared schema',400);
    assertUtcTimestamp(manifest.consultant?.deadline,'consultant.deadline');
    if (manifest.agent.id!==agentId) fail('IDENTITY_MISMATCH','A manifest cannot change agent identity',403);
    const current=await this.s.maybe('agents',agentId);
    if(current?.manifest&&current.manifest.agent.type!==manifest.agent.type)fail('IDENTITY_MISMATCH','Reconfiguration cannot change employee/consultant identity',403);
    assertSupportedGrants(manifest);
    const graph = await this.graph();
    const managerHuman = graph.humans.some((p:any)=>p.id===manifest.organization.managerId);
    if ((manifest.organization.managerKind==='human')!==managerHuman) fail('INVALID_MANAGER','managerKind must match the manager identity',400);
    const reports = graph.agents.filter(a=>a.managerId===agentId && !['ARCHIVED','REJECTED'].includes(a.status)).map(a=>a.id).sort();
    if (JSON.stringify([...manifest.organization.reports].sort())!==JSON.stringify(reports)) fail('INVALID_REPORTS','Reports are derived from the organization graph',400);
    if (manifest.escalation.managerId!==manifest.organization.managerId) fail('INVALID_ESCALATION','Escalation must route to the reporting manager',400);
    if (manifest.budget.currency!=='USD') fail('CURRENCY_UNAVAILABLE','The local deployment accounts in USD',422);
    if (manifest.agent.type==='consultant'&&!manifest.consultant) fail('CONSULTANT_BOUND_REQUIRED','Consultants require a deliverable and termination condition',400);
    assertGraphPosition({id:agentId,organizationId:this.s.organizationId,teamId:manifest.organization.teamId,managerId:manifest.organization.managerId,status:'AWAITING_APPROVAL'},graph);
    for (const id of manifest.context.canonicalMemoryIds) {
      const memory=await this.s.get('memory_entries',id);
      if(memory.category!=='canonical'||memory.status!=='ACTIVE') fail('INVALID_CONTEXT','Canonical context must reference active canonical knowledge',400);
      assertMemoryAccess({id:agentId,kind:'agent',organizationId:this.s.organizationId,teamId:manifest.organization.teamId},memory as any,'read');
    }
  }
  async scopedActor(id=this.actor.id,kind=this.actor.kind): Promise<ScopedActor> {
    if(kind==='human') { const p=await this.s.get('principals',id); if(p.kind!=='human')fail('INVALID_PRINCIPAL','Recipient is not a human principal',403); return {id,kind:'human',organizationId:this.s.organizationId}; }
    const a=await this.s.get('agents',id);
    return {id,kind:'agent',organizationId:this.s.organizationId,teamId:a.manifest?.organization.teamId,managerId:a.manifest?.organization.managerId,communication:a.manifest?.communication};
  }
  async accessAgent(id:string) {
    const agent=await this.s.get('agents',id);
    if(this.actor.kind!=='human') assertCommunicationScope(await this.scopedActor(),await this.scopedActor(id,'agent'));
    return agent;
  }
  async visible(table:TableName,row:RecordData) {
    if(this.actor.kind==='human') return true;
    try {
      const me=await this.scopedActor();
      if(table==='memory_entries') { if(row.status!=='ACTIVE'||(row.expiresAt&&row.expiresAt<=this.s.timestamp()))return false; assertMemoryAccess(me,row as any,'read'); return true; }
      if(table==='messages')return row.sender.id===me.id||row.recipientId===me.id;
      if(table==='escalations')return row.agentId===me.id||row.requestedFrom===me.id;
      if(table==='hiring_requests')return row.requestedBy.id===me.id||row.agentId===me.id;
      if(table==='governance')return row.requestedBy.id===me.id||row.agentId===me.id;
      if(table==='artifacts') { assertMemoryAccess(me,{...row,ownerAgentId:row.agentId,category:'semantic'} as any,'read');return true; }
      if(table==='agents') return this.canReadAgent(row);
      return row.agentId===me.id;
    } catch(e) { if(e instanceof DomainError)return false; throw e; }
  }
  async list(table:TableName,query:RecordData) {
    let rows:RecordData[]=[];
    for(const row of await this.s.list(table)) if(await this.visible(table,row)) rows.push(row);
    if(query.agentId)rows=rows.filter(r=>(r.agentId??r.ownerAgentId)===query.agentId);
    if(query.taskId)rows=rows.filter(r=>r.taskId===query.taskId);
    if(query.status)rows=rows.filter(r=>r.status===query.status);
    if(query.cursor) { const offset=rows.findIndex(r=>r.id===query.cursor); if(offset<0)fail('INVALID_CURSOR','Cursor is not visible in this result set',400); rows=rows.slice(offset+1); }
    const limit=Number(query.limit??50);return {data:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1]!.id:null};
  }
  async notification(recipient:any,content:string) {
    if(!['human','agent'].includes(recipient.kind))recipient={id:(await this.org()).humanPrincipalId,kind:'human'};
    return this.s.insert('messages',{sender:{id:(await this.org()).metaAgentId,kind:'factory',organizationId:this.s.organizationId},recipientId:recipient.id,recipientKind:recipient.kind,content,actionable:recipient.kind==='agent',inReplyTo:null,taskId:null,inputJobId:null,deliveryStatus:recipient.kind==='agent'?'blocked':'queued',blockedReason:recipient.kind==='agent'?'Awaiting task admission':null});
  }
  async createHire(body:RecordData) {
    assertUtcTimestamp(body.consultant?.deadline,'consultant.deadline');
    const org=await this.org();
    assertSupportedGrants({tools:body.tools,permissions:body.grants});
    if(body.budget.currency!=='USD')fail('CURRENCY_UNAVAILABLE','The local deployment accounts in USD',422);
    if(this.actor.kind==='agent') {
      const self=await this.s.get('agents',this.actor.id);assertWorkAdmission(self as any);
      if(!self.manifest.permissions.some((p:any)=>p.tool==='request_hire'&&p.operations.includes('request')))fail('GRANT_REQUIRED','request_hire is not currently granted',403);
      if(body.proposedManagerId!==self.id||body.proposedManagerKind!=='agent')fail('INVALID_MANAGER','An autonomous recruit must report to its requesting agent',403);
    }
    const all=await this.s.list('agents'); const open=(await this.s.list('hiring_requests')).filter(h=>!['REJECTED','FAILED','ACTIVE'].includes(h.status));
    const equivalent=digest({requestedBy:this.actor.id,role:body.role.trim().toLowerCase(),mission:body.mission.trim().toLowerCase(),team:body.teamId,manager:body.proposedManagerId});
    const duplicate=open.find(h=>h.equivalenceKey===equivalent);if(duplicate)return duplicate;
    if(all.filter(a=>!['REJECTED','ARCHIVED'].includes(a.status)).length>=org.limits.maxActiveAgents)fail('AGENT_LIMIT','Configured employee limit reached',429);
    if(open.length>=org.limits.maxPendingHires)fail('PENDING_HIRE_LIMIT','Too many pending hiring requests',429);
    const allocated=all.filter(a=>!['ARCHIVED','REJECTED'].includes(a.status)).reduce((n,a)=>n+(a.manifest?.budget.externalSpendDaily??a.proposedBudget??0),0);
    if(allocated+body.budget.externalSpendDaily>org.limits.maxDailySpend)fail('BUDGET_LIMIT','Hiring would exceed organization daily spending authority',429);
    const id=randomUUID(), hireId=randomUUID();
    if(body.proposedManagerKind==='human') {const p=await this.s.get('principals',body.proposedManagerId);if(p.kind!=='human')fail('INVALID_MANAGER','Expected human manager',400);}
    else await this.s.get('agents',body.proposedManagerId);
    assertGraphPosition({id,organizationId:this.s.organizationId,teamId:body.teamId,managerId:body.proposedManagerId,status:'SPECIFYING'},await this.graph());
    const agent=await this.s.insert('agents',{manifest:null,manifestVersion:null,status:'SPECIFYING',activity:'queued',metaAgentId:org.metaAgentId,hiringRequestId:hireId,requestedBy:principal(this.actor),approvedBy:null,approvedManifestVersion:null,provisionedBy:null,cancellationRequested:false,teamId:body.teamId,managerId:body.proposedManagerId,proposedBudget:body.budget.externalSpendDaily},id);
    const hire=await this.s.insert('hiring_requests',{proposal:body,requestedBy:principal(this.actor),originatingTaskId:this.actor.job?.taskId??null,originatingJobId:this.actor.job?.id??null,proposedManager:body.proposedManagerId,metaAgentId:org.metaAgentId,agentId:id,status:'COMPILING',manifest:null,manifestVersion:null,approvedBy:null,approvedManifestVersion:null,provisionedBy:null,equivalenceKey:equivalent},hireId);
    await enqueue(this.s,{kind:'compile_manifest',agentId:id,hiringRequestId:hireId,idempotencyKey:`compile-${hireId}-1`,payload:{hiringRequest:hire,agent,organization:org,teams:await this.s.list('teams')}});
    await this.s.event('hire.requested','Hiring request queued for compilation',{agentId:id,hiringRequestId:hireId,jobId:this.actor.job?.id,attempt:this.actor.job?.attempt},{requestedBy:principal(this.actor)});
    return hire;
  }
  async decideHire(id:string,body:RecordData) {
    this.assertHuman();
    const hire=await this.s.get('hiring_requests',id);expected(hire,body.expectedVersion);
    if(hire.status!=='AWAITING_APPROVAL'||hire.manifestVersion!==body.manifestVersion)fail('STALE_APPROVAL','Decision must bind the current reviewed manifest version');
    let agent=await this.s.get('agents',hire.agentId);
    if(body.decision==='approve')await this.validateManifest(hire.manifest,agent.id);
    await this.s.insert('approvals',{subjectType:'hiring_request',subjectId:id,decision:body.decision,approvedBy:this.actor.id,approvedManifestVersion:body.manifestVersion,reason:body.reason});
    if(body.decision==='reject') { agent=await this.s.save('agents',{...agent,status:'REJECTED',activity:'idle'});hire.status='REJECTED'; }
    else {
      const org=await this.org();const all=await this.s.list('agents');
      const allocation=all.filter(a=>a.id!==agent.id&&!['ARCHIVED','REJECTED'].includes(a.status)).reduce((n,a)=>n+(a.manifest?.budget.externalSpendDaily??a.proposedBudget??0),0);
      if(all.filter(a=>!['ARCHIVED','REJECTED'].includes(a.status)).length>org.limits.maxActiveAgents||allocation+hire.manifest.budget.externalSpendDaily>org.limits.maxDailySpend)fail('BUDGET_LIMIT','Current organization limits do not admit this hire',429);
      agent=await this.s.save('agents',{...agent,status:'PROVISIONING',activity:'queued',approvedBy:this.actor.id,approvedManifestVersion:body.manifestVersion});
      hire.status='PROVISIONING';hire.approvedBy=this.actor.id;hire.approvedManifestVersion=body.manifestVersion;
      await enqueue(this.s,{kind:'provision_agent',agentId:agent.id,hiringRequestId:id,idempotencyKey:`provision-${id}-${body.manifestVersion}`,payload:{agent,manifest:hire.manifest,manifestVersion:body.manifestVersion}});
    }
    const updated=await this.s.save('hiring_requests',hire);
    await this.notification(hire.requestedBy,`Hiring request ${id} ${body.decision==='approve'?'approved; provisioning queued':'rejected'}. Agent: ${agent.id}.`);
    await this.s.event('hire.decision',body.reason,{agentId:agent.id,hiringRequestId:id},{approvedBy:this.actor.id,manifestVersion:body.manifestVersion,decision:body.decision});return updated;
  }
  async createTask(body:RecordData,inputMessageId:string|null=null) {
    await this.assertActiveActor();
    const agent=await this.accessAgent(body.agentId);assertWorkAdmission(agent as any);
    assertUtcTimestamp(body.deadline,'deadline');
    if(body.deadline&&Date.parse(body.deadline)<=this.s.now().getTime())fail('DEADLINE_EXPIRED','Task deadline is in the past',400);
    if(body.parentTaskId) {const parent=await this.s.get('tasks',body.parentTaskId);if(this.actor.kind==='agent'&&parent.agentId!==this.actor.id)fail('TASK_FORBIDDEN','Parent task is not owned by requester',403);}
    const pending=(await this.s.list('tasks')).filter(t=>t.agentId===agent.id&&!terminal(t.status));
    if(pending.length>=agent.manifest.budget.maxConcurrentTasks)fail('CONCURRENCY_LIMIT','Agent has reached its current concurrent work limit',429);
    const task=await this.s.insert('tasks',{...body,parentTaskId:body.parentTaskId??null,inputMessageId,status:'CREATED',requestedBy:principal(this.actor),executedBy:null,evidence:null,cancellationRequested:false});
    await enqueue(this.s,{kind:'run_task',agentId:agent.id,taskId:task.id,hiringRequestId:agent.hiringRequestId,inputMessageId,idempotencyKey:`task-${task.id}`,payload:{agent,task,inputMessage:inputMessageId?await this.s.get('messages',inputMessageId):null}});
    await this.s.save('agents',{...agent,activity:'queued'});
    await this.s.event('task.created',body.objective,{agentId:agent.id,taskId:task.id});return task;
  }
  async message(body:RecordData) {
    await this.assertActiveActor();
    const sender=await this.scopedActor();const recipient=await this.scopedActor(body.recipientId,body.recipientKind);assertCommunicationScope(sender,recipient);
    if(body.taskId){const t=await this.s.get('tasks',body.taskId);if(this.actor.kind==='agent'&&t.agentId!==this.actor.id)fail('TASK_FORBIDDEN','Message task must belong to the sender',403);}
    let replyTo:RecordData|null=null;
    if(body.inReplyTo) {replyTo=await this.s.get('messages',body.inReplyTo);if(replyTo.recipientId!==this.actor.id||replyTo.sender.id!==body.recipientId)fail('INVALID_REPLY','Reply must connect the original participants',403);}
    const agent=body.recipientKind==='agent'?await this.s.get('agents',body.recipientId):null;
    const blocked=!!(agent&&body.actionable&&agent.status!=='ACTIVE');
    let msg=await this.s.insert('messages',{...body,sender:principal(this.actor),inputJobId:null,deliveryStatus:blocked?'blocked':'queued',blockedReason:blocked?'Recipient is not ACTIVE':null});
    if(agent&&body.actionable&&!blocked) {
      const task=await this.createTask({agentId:agent.id,objective:body.content,constraints:[],deliverable:'Reply to the originating message with evidence',deadline:null,parentTaskId:body.taskId??undefined},msg.id);
      const job=(await this.s.list('jobs')).find(j=>j.taskId===task.id)!;
      msg=await this.s.save('messages',{...msg,taskId:task.id,inputJobId:job.id});
    }
    if(replyTo)await this.s.save('messages',{...replyTo,deliveryStatus:'replied',blockedReason:null});
    await this.s.event('message.sent','Message persisted',{agentId:this.actor.kind==='agent'?this.actor.id:body.recipientKind==='agent'?body.recipientId:null},{messageId:msg.id});return msg;
  }
  async stopWork(agentId:string,reason:string) {
    for(const task of await this.s.list('tasks'))if(task.agentId===agentId&&!terminal(task.status))await this.s.save('tasks',{...task,status:'CANCELLED',cancellationRequested:true});
    for(const job of await this.s.list('jobs'))if(job.agentId===agentId&&['QUEUED','RUNNING'].includes(job.status))await this.s.save('jobs',{...job,status:'FAILED',cancellationRequested:true,leaseToken:null,leaseExpiresAt:null});
    for(const schedule of await this.s.list('schedules'))if(schedule.agentId===agentId&&schedule.enabled)await this.s.save('schedules',{...schedule,enabled:false});
    for(const message of await this.s.list('messages'))if(message.recipientId===agentId&&['consumed','queued'].includes(message.deliveryStatus)&&message.actionable)await this.s.save('messages',{...message,deliveryStatus:'failed',blockedReason:reason});
  }
  async governance(body:RecordData) {
    await this.assertActiveActor();
    if(body.kind==='canonical_revision')fail('CANONICAL_PROPOSAL_REQUIRED','Submit canonical knowledge through the memory endpoint so approval binds its content and history',400);
    if(body.agentId) {const agent=await this.accessAgent(body.agentId);expected(agent,body.expectedVersion);}
    if(['credential','policy'].includes(body.kind))fail('CAPABILITY_UNAVAILABLE','This deployment supports canonical revisions and approved local manifests; external credentials and tenant policy changes are unavailable',422);
    let changes=body.changes;
    if(['reconfigure','grant','budget'].includes(body.kind)) { if(!body.agentId||!changes.manifest)fail('MANIFEST_REQUIRED','Resource changes require the complete reviewed manifest',400);await this.validateManifest(changes.manifest,body.agentId);changes={manifest:changes.manifest}; }
    if(body.kind==='retire'&&!body.agentId)fail('AGENT_REQUIRED','Retirement requires an agent',400);
    const gov=await this.s.insert('governance',{...body,changes,requestedBy:principal(this.actor),status:'PENDING',approvedBy:null});
    await this.s.event('governance.proposed',body.reason,{agentId:body.agentId},{governanceId:gov.id,kind:body.kind});return gov;
  }
  async lifecycle(id:string,body:RecordData) {
    this.assertHuman();
    let agent=await this.s.get('agents',id);expected(agent,body.expectedVersion);
    if(['reconfigure','retire'].includes(body.action)) {
      if(body.transferReportsTo)fail('REPORT_TRANSFER_REQUIRES_MANIFEST','Approve reporting-manager changes on each report before retirement',422);
      const governance=await this.governance({agentId:id,kind:body.action,expectedVersion:agent.version,reason:body.reason,changes:body.manifest?{manifest:body.manifest}:{}});
      return {agent,governance};
    }
    if(body.action==='pause') {assertAgentTransition(agent.status,'PAUSED');await this.stopWork(id,body.reason);agent=await this.s.save('agents',{...agent,status:'PAUSED',activity:'blocked',cancellationRequested:true});}
    if(body.action==='resume') {assertAgentTransition(agent.status,'ACTIVE');assertVerificationEvidence({manifestVersion:agent.manifestVersion,approvedManifestVersion:agent.approvedManifestVersion,checks:agent.verification??[],requiredChecks:agent.manifest.evaluation.requiredVerificationChecks});agent=await this.s.save('agents',{...agent,status:'ACTIVE',activity:'idle',cancellationRequested:false});}
    if(body.action==='remediate') {
      if(agent.status==='TERMINATING') {
        const jobs=(await this.s.list('jobs')).filter(job=>job.agentId===id&&job.kind==='retire_agent');
        if(jobs.some(job=>['QUEUED','RUNNING'].includes(job.status)))fail('RETIREMENT_IN_PROGRESS','Existing cleanup must fail or exhaust its retries before human remediation');
        const approvals=(await this.s.list('governance')).filter(g=>g.agentId===id&&g.kind==='retire'&&g.status==='APPLIED');
        const approvedJob=jobs.find(job=>approvals.some(g=>job.idempotencyKey===`retire-${g.id}`));
        if(!approvedJob||!jobs.some(job=>job.status==='FAILED'))return fail('RETIREMENT_RETRY_UNAVAILABLE','Retirement remediation requires a failed cleanup job backed by human approval');
        assertRetirementAllowed(id,(await this.graph()).agents);
        agent=await this.s.save('agents',{...agent,activity:'queued',cancellationRequested:true});
        await enqueue(this.s,{kind:'retire_agent',agentId:id,hiringRequestId:approvedJob.hiringRequestId,idempotencyKey:`remediate-retire-${id}-${agent.version}`,payload:approvedJob.payload});
      } else {
        if(agent.status!=='REMEDIATING')fail('INVALID_TRANSITION','Only REMEDIATING agents or failed TERMINATING cleanup may be remediated');
        const hire=await this.s.get('hiring_requests',agent.hiringRequestId);
        const approved=agent.approvedManifestVersion!==null&&agent.approvedManifestVersion===agent.manifestVersion;
        const kind=approved?(agent.reconfiguring?'reconfigure_agent':'provision_agent'):'compile_manifest';
        agent=await this.s.save('agents',{...agent,status:approved?(agent.reconfiguring?'RECONFIGURING':'PROVISIONING'):'SPECIFYING',activity:'queued',cancellationRequested:false});
        await enqueue(this.s,{kind,agentId:id,hiringRequestId:hire.id,idempotencyKey:`remediate-${id}-${agent.version}`,payload:approved?{agent,manifest:agent.manifest,manifestVersion:agent.manifestVersion}:{agent,hiringRequest:hire,organization:await this.org(),teams:await this.s.list('teams')}});
      }
    }
    await this.s.event(`agent.${body.action}`,body.reason,{agentId:id});return {agent,governance:null};
  }
  async decideGovernance(id:string,body:RecordData) {
    this.assertHuman();
    const g=await this.s.get('governance',id);expected(g,body.expectedVersion);if(g.status!=='PENDING')fail('ALREADY_DECIDED','Governance proposal is no longer pending');
    if(body.decision==='approve') {
      if(g.kind==='canonical_revision') {
        const memory=await this.s.get('memory_entries',g.changes.memoryId);
        if(memory.category!=='canonical'||memory.status!=='PROPOSED'||memory.ownerAgentId!==g.agentId||memory.version!==g.changes.memoryVersion||memory.proposedBy?.id!==g.requestedBy.id||this.memoryDigest(memory)!==g.changes.memoryDigest)fail('STALE_REVISION','Canonical approval must bind the exact owned proposal and reviewed content');
        if(memory.supersedesId){const prior=await this.s.get('memory_entries',memory.supersedesId);if(prior.status!=='ACTIVE'||prior.version!==g.changes.priorVersion)fail('STALE_REVISION','Canonical source changed after review');await this.s.save('memory_entries',{...prior,status:'SUPERSEDED'});}
        await this.s.save('memory_entries',{...memory,status:'ACTIVE',approvedBy:this.actor.id});
      } else {
        let agent=await this.s.get('agents',g.agentId);expected(agent,g.expectedVersion);
        if(g.kind==='retire') {
          assertRetirementAllowed(agent.id,(await this.graph()).agents);assertAgentTransition(agent.status,'TERMINATING');
          await this.stopWork(agent.id,g.reason);
          agent=await this.s.save('agents',{...agent,status:'TERMINATING',activity:'queued',cancellationRequested:true});
          await enqueue(this.s,{kind:'retire_agent',agentId:agent.id,hiringRequestId:agent.hiringRequestId,idempotencyKey:`retire-${g.id}`,payload:{agent,reason:g.reason}});
        } else {
          await this.validateManifest(g.changes.manifest,agent.id);assertAgentTransition(agent.status,'RECONFIGURING');
          const org=await this.org();const allocated=(await this.s.list('agents')).filter(a=>a.id!==agent.id&&!['ARCHIVED','REJECTED'].includes(a.status)).reduce((n,a)=>n+(a.manifest?.budget.externalSpendDaily??a.proposedBudget??0),0);
          if(allocated+g.changes.manifest.budget.externalSpendDaily>org.limits.maxDailySpend)fail('BUDGET_LIMIT','Reconfiguration exceeds organization authority',429);
          await this.stopWork(agent.id,g.reason);
          const manifestVersion=agent.manifestVersion+1;
          await this.s.insert('manifests',{agentId:agent.id,version:manifestVersion,manifest:g.changes.manifest,approvedBy:this.actor.id});
          agent=await this.s.save('agents',{...agent,manifest:g.changes.manifest,manifestVersion,approvedManifestVersion:manifestVersion,approvedBy:this.actor.id,status:'RECONFIGURING',activity:'queued',cancellationRequested:false,reconfiguring:true,budgetExceeded:false});
          await enqueue(this.s,{kind:'reconfigure_agent',agentId:agent.id,hiringRequestId:agent.hiringRequestId,idempotencyKey:`reconfigure-${g.id}`,payload:{agent,manifest:agent.manifest,manifestVersion}});
        }
      }
    }
    await this.s.insert('approvals',{subjectType:'governance',subjectId:id,decision:body.decision,approvedBy:this.actor.id,approvedManifestVersion:g.changes.manifest?(await this.s.get('agents',g.agentId)).manifestVersion:null,reason:body.reason});
    const updated=await this.s.save('governance',{...g,status:body.decision==='approve'?'APPLIED':'REJECTED',approvedBy:this.actor.id});
    await this.notification(g.requestedBy,`Governance ${g.id} ${body.decision==='approve'?'approved':'rejected'}.`);
    await this.s.event('governance.decided',body.reason,{agentId:g.agentId},{governanceId:id,decision:body.decision,approvedBy:this.actor.id});return updated;
  }
  memoryDigest(memory:RecordData) { return digest({ownerAgentId:memory.ownerAgentId,category:memory.category,title:memory.title,content:memory.content,scope:memory.scope,provenance:memory.provenance,expiresAt:memory.expiresAt,supersedesId:memory.supersedesId}); }
  async memory(body:RecordData) {
    await this.assertActiveActor();
    if(body.ownerAgentId)await this.s.get('agents',body.ownerAgentId);
    if(body.scope.teamId)await this.s.get('teams',body.scope.teamId);
    for(const id of body.scope.agentIds)await this.s.get('agents',id);
    if(body.scope.visibility==='team'&&!body.scope.teamId)fail('INVALID_SCOPE','Team visibility requires teamId',400);
    if(this.actor.kind==='agent') {
      if(body.ownerAgentId!==this.actor.id)fail('MEMORY_FORBIDDEN','Agents may only write their own knowledge',403);
      const self=await this.scopedActor(); if(body.scope.teamId&&body.scope.teamId!==self.teamId)fail('MEMORY_FORBIDDEN','Cannot publish knowledge to another team',403);
      for(const id of body.scope.agentIds)await this.accessAgent(id);
    }
    assertUtcTimestamp(body.expiresAt,'expiresAt');
    if(body.expiresAt&&Date.parse(body.expiresAt)<=this.s.now().getTime())fail('INVALID_RETENTION','New memory expiry must be in the future',400);
    if(body.provenance.taskId) {const task=await this.s.get('tasks',body.provenance.taskId);if(!await this.visible('tasks',task))fail('EVIDENCE_FORBIDDEN','Task provenance is outside knowledge scope',403);}
    if(body.provenance.jobId) {const job=await this.s.get('jobs',body.provenance.jobId);if(this.actor.kind==='agent'&&job.agentId!==this.actor.id)fail('EVIDENCE_FORBIDDEN','Job provenance is outside knowledge scope',403);if(body.provenance.taskId&&job.taskId!==body.provenance.taskId)fail('INVALID_EVIDENCE','Task and job provenance do not refer to the same execution',400);}
    for(const id of body.provenance.artifactIds){const a=await this.s.get('artifacts',id);if(!await this.visible('artifacts',a))fail('EVIDENCE_FORBIDDEN','Artifact outside knowledge scope',403);}
    for(const id of body.provenance.eventIds){const e=await this.s.get('events',id);if(!await this.visible('events',e))fail('EVIDENCE_FORBIDDEN','Event outside knowledge scope',403);}
    if(this.actor.kind==='agent'&&!body.provenance.artifactIds.length&&!body.provenance.eventIds.length)fail('EVIDENCE_REQUIRED','Agent learning requires persisted evidence',422);
    let prior:RecordData|null=null;
    if(body.supersedesId) {prior=await this.s.get('memory_entries',body.supersedesId);if(prior.category!==body.category||prior.ownerAgentId!==body.ownerAgentId||prior.status!=='ACTIVE')fail('INVALID_REVISION','Revision must replace active knowledge of the same category and owner');}
    const memory=await this.s.insert('memory_entries',{...body,status:body.category==='canonical'?'PROPOSED':'ACTIVE',approvedBy:null,proposedBy:principal(this.actor)});
    if(body.category==='canonical')await this.s.insert('governance',{agentId:body.ownerAgentId,kind:'canonical_revision',expectedVersion:body.ownerAgentId?(await this.s.get('agents',body.ownerAgentId)).version:1,reason:`Review canonical revision: ${body.title}`,changes:{memoryId:memory.id,memoryVersion:memory.version,memoryDigest:this.memoryDigest(memory),priorVersion:prior?.version??null},requestedBy:principal(this.actor),status:'PENDING',approvedBy:null});
    else if(prior)await this.s.save('memory_entries',{...prior,status:'SUPERSEDED'});
    await this.s.event('memory.proposed',body.title,{agentId:body.ownerAgentId},{memoryId:memory.id,category:body.category});return memory;
  }
  async handle(op:string,id:string,body:RecordData,query:RecordData):Promise<any> {
    if(this.actor.organizationId!==this.s.organizationId||!['human','agent'].includes(this.actor.kind))fail('FORBIDDEN','This operation requires an organization-scoped human or delegated agent',403);
    if(['getOrganization','decideHiringRequest','decideGovernance','lifecycleAction','cancelTask','resolveEscalation','createSchedule'].includes(op))this.assertHuman();
    if(!op.startsWith('get')&&!op.startsWith('list'))await this.assertActiveActor();
    const listTables:Record<string,TableName>={listAgents:'agents',listHiringRequests:'hiring_requests',listTasks:'tasks',listMessages:'messages',listEscalations:'escalations',listMemory:'memory_entries',listLearning:'learning_proposals',listEvaluations:'evaluations',listUsage:'usage_reservations',listEvents:'events',listResources:'resources',listSchedules:'schedules',listGovernance:'governance'};
    if(listTables[op])return this.list(listTables[op],query);
    if(op==='getOrganization') { const organization=await this.org();return {organization,teams:await this.s.list('teams'),coordinator:await this.s.get('principals',organization.metaAgentId),agents:await this.s.list('agents')}; }
    if(op==='getAgent') {const agent=await this.s.get('agents',id);if(!await this.canReadAgent(agent))fail('AGENT_FORBIDDEN','Detailed agent state is restricted to its operator, owner and direct manager',403);return {agent,grants:agent.status==='ACTIVE'?agent.manifest.permissions:[],resources:(await this.s.list('resources')).filter(r=>r.agentId===id),verification:agent.verification??[]};}
    const getTables:Record<string,TableName>={getHiringRequest:'hiring_requests',getTask:'tasks',getMemory:'memory_entries',getArtifact:'artifacts'};
    if(getTables[op]) {const value=await this.s.get(getTables[op],id);if(!await this.visible(getTables[op],value))fail('FORBIDDEN','Record is outside your access scope',403);return value;}
    switch(op) {
      case 'createHiringRequest': return this.createHire(body);
      case 'decideHiringRequest': return this.decideHire(id,body);
      case 'createTask': return this.createTask(body);
      case 'createMessage': return this.message(body);
      case 'createMemory': return this.memory(body);
      case 'createGovernance': return this.governance(body);
      case 'decideGovernance': return this.decideGovernance(id,body);
      case 'lifecycleAction': return this.lifecycle(id,body);
      case 'getArtifactContent': {const artifact=await this.s.get('artifacts',id);if(!await this.visible('artifacts',artifact))fail('FORBIDDEN','Artifact is outside your scope',403);return readArtifact(this.artifactRoot,artifact.path,artifact as any);}
      case 'cancelTask': {
        const task=await this.s.get('tasks',id);expected(task,body.expectedVersion);if(terminal(task.status))fail('TERMINAL_TASK','Task is already terminal');
        for(const job of await this.s.list('jobs'))if(job.taskId===id&&['QUEUED','RUNNING'].includes(job.status))await this.s.save('jobs',{...job,status:'FAILED',leaseToken:null,leaseExpiresAt:null,cancellationRequested:true});
        if(task.inputMessageId){const msg=await this.s.get('messages',task.inputMessageId);await this.s.save('messages',{...msg,deliveryStatus:'failed',blockedReason:body.reason});}
        await this.s.event('task.cancelled',body.reason,{agentId:task.agentId,taskId:id});return this.s.save('tasks',{...task,status:'CANCELLED',cancellationRequested:true});
      }
      case 'createEscalation': {
        const agent=await this.accessAgent(body.agentId);if(this.actor.kind==='agent'&&body.agentId!==this.actor.id)fail('FORBIDDEN','An agent may only escalate its own execution',403);
        if(body.requestedFrom!==agent.manifest.organization.managerId)fail('INVALID_ESCALATION','Route escalation to the authoritative manager',400);
        if(body.taskId){const task=await this.s.get('tasks',body.taskId);if(task.agentId!==agent.id||terminal(task.status))fail('TERMINAL_TASK','Only owned nonterminal work can escalate');await this.s.save('tasks',{...task,status:'ESCALATED'});for(const job of await this.s.list('jobs'))if(job.taskId===task.id&&['QUEUED','RUNNING'].includes(job.status))await this.s.save('jobs',{...job,status:'FAILED',leaseToken:null,leaseExpiresAt:null});}
        const escalation=await this.s.insert('escalations',{...body,status:'OPEN',resolution:null,resolvedBy:null,followUpTaskId:null});
        await this.notification({id:body.requestedFrom,kind:agent.manifest.organization.managerKind},`Escalation ${escalation.id}: ${body.situation}`);await this.s.event('escalation.created',body.reason,{agentId:agent.id,taskId:body.taskId});return escalation;
      }
      case 'resolveEscalation': {
        const escalation=await this.s.get('escalations',id);expected(escalation,body.expectedVersion);if(escalation.status!=='OPEN')fail('ALREADY_RESOLVED','Escalation is already resolved');
        let followUp:RecordData|null=null;if(body.followUp)followUp=await this.createTask({...body.followUp,parentTaskId:escalation.taskId??body.followUp.parentTaskId});
        await this.s.event('escalation.resolved',body.resolution,{agentId:escalation.agentId,taskId:escalation.taskId});return this.s.save('escalations',{...escalation,status:'RESOLVED',resolution:body.resolution,resolvedBy:this.actor.id,followUpTaskId:followUp?.id??null});
      }
      case 'createSchedule': {
        assertUtcTimestamp(body.nextRunAt,'nextRunAt');
        const agent=await this.s.get('agents',body.agentId);assertWorkAdmission(agent as any);
        if(body.kind==='run_task'&&(!body.payload.objective||!body.payload.deliverable))fail('INVALID_SCHEDULE','Task schedules require objective and deliverable',400);
        return this.s.insert('schedules',{...body,enabled:true});
      }
      default: return fail('UNKNOWN_OPERATION','Operation is unavailable',404);
    }
  }
}
