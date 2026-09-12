import assert from 'node:assert/strict';
import test from 'node:test';
import { manifest as sampleManifest } from '@agent-factory/contracts/fixtures';
import { Service, assertUtcTimestamp } from '../src/service.js';
import { Store, type Actor, type RecordData } from '../src/store.js';
import { DomainError } from '../src/domain.js';

const org='org-demo';
const human:Actor={id:'human-ceo',kind:'human',organizationId:org};
const employee:Actor={id:'agent-research',kind:'agent',organizationId:org};
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
const stamp='2026-09-12T10:00:00.000Z';
function setup(actor=human,extras:Record<string,RecordData[]>={}) {
 const manifest=structuredClone(sampleManifest);
 const rows:Record<string,RecordData[]>={organizations:[{id:org,metaAgentId:'meta-factory',limits:{maxRecruitmentDepth:3}}],principals:[human,{id:'worker-local',kind:'worker',organizationId:org}],agents:[{id:employee.id,organizationId:org,version:1,status:'ACTIVE',manifest,manifestVersion:1,approvedManifestVersion:1}],...extras};
 const get=async(table:string,id:string)=>{const row=rows[table]?.find(row=>row.id===id);if(!row)throw new DomainError('NOT_FOUND','Missing fixture',404);return structuredClone(row);};
 const store={organizationId:org,timestamp:()=>stamp,get,maybe:async(table:string,id:string)=>rows[table]?.find(row=>row.id===id)??null,list:async(table:string)=>structuredClone(rows[table]??[]),insert:async(table:string,value:RecordData,id=`${table}-${(rows[table]??[]).length+1}`)=>{const row={...value,id,organizationId:org,version:value.version??1,createdAt:stamp,updatedAt:stamp};(rows[table]??=[]).push(row);return structuredClone(row);},save:async(table:string,row:RecordData)=>{const updated={...row,version:row.version+1};rows[table]![rows[table]!.findIndex(v=>v.id===row.id)]=updated;return structuredClone(updated);},event:async()=>({})} as unknown as Store;
 return {service:new Service(store,actor,'/unused-artifact-root'),rows,manifest};
}

test('agent and bare worker cannot call human governance functions directly',async()=>{
 for(const actor of [employee,{id:'worker-local',kind:'worker',organizationId:org}]) {
  const {service}=setup(actor);
  await assert.rejects(service.decideHire('any',{}),code('HUMAN_APPROVAL_REQUIRED'));
  await assert.rejects(service.decideGovernance('any',{}),code('HUMAN_APPROVAL_REQUIRED'));
  await assert.rejects(service.lifecycle('any',{}),code('HUMAN_APPROVAL_REQUIRED'));
 }
});

test('paused actors cannot delegate new tasks, send messages, or propose knowledge',async()=>{
 const {service,rows}=setup(employee);rows.agents![0]!.status='PAUSED';
 await assert.rejects(service.createTask({agentId:'another-agent'}),code('AGENT_INACTIVE'));
 await assert.rejects(service.message({}),code('AGENT_INACTIVE'));
 await assert.rejects(service.memory({}),code('AGENT_INACTIVE'));
 await assert.rejects(service.governance({}),code('AGENT_INACTIVE'));
});

test('a worker principal cannot be relabeled as a human message recipient',async()=>{
 const {service}=setup();
 await assert.rejects(service.scopedActor('worker-local','human'),code('INVALID_PRINCIPAL'));
});

test('communication access does not disclose another agent private console state',async()=>{
 const {service,rows,manifest}=setup(employee);
 manifest.communication.allowedAgentIds=['peer'];rows.agents![0]!.manifest=manifest;
 const peer={...rows.agents![0],id:'peer',manifest:{...manifest,agent:{...manifest.agent,id:'peer'}}};rows.agents!.push(peer);
 assert.equal((await service.accessAgent('peer')).id,'peer');
 await assert.rejects(service.handle('getAgent','peer',{},{}),code('AGENT_FORBIDDEN'));
 assert.equal(await service.visible('agents',peer),false);
 peer.manifest.organization={...peer.manifest.organization,managerId:employee.id,managerKind:'agent'};
 assert.equal(await service.canReadAgent(peer),true);
});

test('canonical governance cannot be crafted around arbitrary memory references',async()=>{
 const {service}=setup(employee);
 await assert.rejects(service.governance({kind:'canonical_revision',agentId:null,changes:{memoryId:'other-agent-private-proposal',priorVersion:1}}),code('CANONICAL_PROPOSAL_REQUIRED'));
});

test('canonical approval rejects content changed after proposal review',async()=>{
 const {service,rows}=setup();
 const memory={id:'memory-policy',organizationId:org,version:1,ownerAgentId:null,category:'canonical',title:'Policy',content:'Reviewed content',scope:{visibility:'organization',teamId:null,agentIds:[]},provenance:{artifactIds:[],eventIds:[],taskId:null,jobId:null,summary:'Operator-authored policy'},expiresAt:null,supersedesId:null,status:'PROPOSED',proposedBy:human};
 rows.memory_entries=[memory];rows.governance=[{id:'proposal-policy',version:1,status:'PENDING',kind:'canonical_revision',agentId:null,requestedBy:human,changes:{memoryId:memory.id,memoryVersion:1,memoryDigest:service.memoryDigest(memory),priorVersion:null}}];
 memory.content='Unreviewed altered content';
 await assert.rejects(service.decideGovernance('proposal-policy',{expectedVersion:1,decision:'approve'}),code('STALE_REVISION'));
 assert.equal(memory.status,'PROPOSED');assert.equal(rows.approvals,undefined);
});

test('reconfiguration preserves employee/consultant identity',async()=>{
 const {service,manifest:original}=setup();const manifest=structuredClone(original);
 manifest.agent.type='consultant';manifest.consultant={deliverable:'A bounded report',deadline:null,terminationCondition:'Report accepted',knowledgeRecipientIds:[]};
 await assert.rejects(service.validateManifest(manifest,employee.id),code('IDENTITY_MISMATCH'));
});

test('resume rejects a token verification record with missing mandatory checks',async()=>{
 const {service,rows}=setup();rows.agents![0]!.status='PAUSED';rows.agents![0]!.verification=[{name:'memory',passed:true,error:null,evidence:{artifactIds:['a'],eventIds:[],taskId:null,jobId:null,summary:'One check only'}}];
 await assert.rejects(service.lifecycle(employee.id,{action:'resume',expectedVersion:1,reason:'Resume'}),code('VERIFICATION_REQUIRED'));
 assert.equal(rows.agents![0]!.status,'PAUSED');
});

test('memory cannot attach another agent execution as its provenance',async()=>{
 const {service,rows}=setup(employee);rows.jobs=[{id:'foreign-job',agentId:'peer',taskId:'peer-task'}];
 await assert.rejects(service.memory({ownerAgentId:employee.id,scope:{visibility:'private',teamId:null,agentIds:[]},provenance:{jobId:'foreign-job',taskId:null,artifactIds:[],eventIds:[]}}),code('EVIDENCE_FORBIDDEN'));
});

test('tenant mismatch and bare workers are rejected before service operation dispatch',async()=>{
 const foreign=setup({...human,organizationId:'other-org'}).service;
 await assert.rejects(foreign.handle('listAgents','',{},{}),code('FORBIDDEN'));
 const worker=setup({id:'worker-local',kind:'worker',organizationId:org}).service;
 await assert.rejects(worker.handle('listAgents','',{},{}),code('FORBIDDEN'));
});

test('timestamps reject impossible calendar dates and retain valid UTC fractional seconds',()=>{
 for(const value of ['2026-02-31T10:00:00.000Z','2026-13-01T10:00:00Z','2026-09-12T24:00:00Z','not-a-date'])assert.throws(()=>assertUtcTimestamp(value,'test'),code('INVALID_TIMESTAMP'));
 for(const value of ['2024-02-29T10:00:00Z','2026-09-12T10:00:00.123456Z',null])assert.doesNotThrow(()=>assertUtcTimestamp(value,'test'));
});

test('escalations are visible to their subject and intended manager, not unrelated peers', async () => {
 const {service}=setup(employee);
 assert.equal(await service.visible('escalations',{agentId:'child',requestedFrom:employee.id}),true);
 assert.equal(await service.visible('escalations',{agentId:employee.id,requestedFrom:'human-ceo'}),true);
 assert.equal(await service.visible('escalations',{agentId:'peer',requestedFrom:'other-manager'}),false);
});
