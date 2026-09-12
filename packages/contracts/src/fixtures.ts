import type { Static } from '@sinclair/typebox';
import { AgentManifest, routes } from './index.js';
const timestamp = '2026-09-12T10:00:00.000Z';
const base = (id:string) => ({id,organizationId:'org-demo',version:1,createdAt:timestamp,updatedAt:timestamp});
export const human = {id:'human-ceo',kind:'human',organizationId:'org-demo'};
export const scope = {visibility:'organization',teamId:null,agentIds:[]};
export const evidence = {artifactIds:['artifact-report'],eventIds:['event-verification'],taskId:'task-review',jobId:'job-review',summary:'Stored report hash and read-back verify the delegated research result.'};
export const budget = {modelCallsDaily:20,externalSpendDaily:5,currency:'USD',maxConcurrentTasks:2};
export const grant = {tool:'workspace-files',operations:['read','write'],resource:null,credentialRef:null};
export const manifest: Static<typeof AgentManifest> = {
  agent:{id:'agent-research',name:'Research Lead',type:'employee'},
  organization:{teamId:'team-research',managerId:'human-ceo',managerKind:'human',reports:[]},
  role:{title:'Research Lead'},mission:{primary:'Turn approved source briefs into verified research evidence.'},
  responsibilities:['Review source briefs','Delegate evidence checks','Identify capability gaps'],successMetrics:['Evidence-backed reports'],
  runtime:{model:'configured-model',executionEnvironment:'sandboxed'},tools:['workspace-files','request_hire'],permissions:[grant,{tool:'request_hire',operations:['request'],resource:null,credentialRef:null}],
  memory:{working:true,episodic:true,semantic:true,canonical:true},learning:{enabled:true,cadence:'daily',autonomousChanges:['episodic observations'],approvalRequiredChanges:['canonical policy']},
  escalation:{managerId:'human-ceo',triggers:['missing evidence','budget exhausted'],defaultSeverity:'medium'},budget,observability:{logs:true,traces:true,metrics:true},
  standards:['Cite approved source files; never invent evidence.'],communication:{allowedAgentIds:[],canContactManager:true,canContactHuman:true},
  context:{companyMission:'Build a reliable AI-native organization.',teamMission:'Produce verifiable research.',canonicalMemoryIds:['memory-standards']},
  evaluation:{criteria:['Every claim has a source'],requiredVerificationChecks:['runtime','model','tools','authentication','permissions','memory','communication','escalation','observability','evaluation','restart','end_to_end']},consultant:null
};
export const organization = {...base('org-demo'),name:'Agent Factory Demo',mission:'Build a reliable AI-native organization.',metaAgentId:'meta-factory',humanPrincipalId:'human-ceo',limits:{maxActiveAgents:10,maxRecruitmentDepth:3,maxPendingHires:10,maxDailySpend:25}};
export const team = {...base('team-research'),name:'Research',mission:'Produce verifiable research.'};
export const coordinator = {...base('meta-factory'),name:'Factory Coordinator',kind:'factory',capabilities:['compile_manifest','provision_agent','verify_agent']};
export const agent = {...base('agent-research'),manifest,manifestVersion:1,status:'AWAITING_APPROVAL',activity:'idle',metaAgentId:'meta-factory',hiringRequestId:'hire-research',requestedBy:human,approvedBy:null,approvedManifestVersion:null,provisionedBy:null,cancellationRequested:false};
export const proposal = {justification:'The organization needs an accountable research function.',role:'Research Lead',mission:manifest.mission.primary,teamId:'team-research',proposedManagerId:'human-ceo',proposedManagerKind:'human',agentType:'employee',responsibilities:manifest.responsibilities,tools:manifest.tools,grants:manifest.permissions,expectedBenefit:'Reusable research with verified evidence.',budget};
export const hire = {...base('hire-research'),proposal,requestedBy:human,originatingTaskId:null,originatingJobId:null,proposedManager:'human-ceo',metaAgentId:'meta-factory',agentId:agent.id,status:'AWAITING_APPROVAL',manifest,manifestVersion:1,approvedBy:null,approvedManifestVersion:null,provisionedBy:null};
export const taskInput = {agentId:agent.id,objective:'Review the approved market brief.',constraints:['Use approved source files only.'],deliverable:'A cited summary in report.md.',deadline:null};
export const task = {...base('task-review'),...taskInput,parentTaskId:null,inputMessageId:null,status:'CREATED',requestedBy:human,executedBy:null,evidence:null,cancellationRequested:false};
export const messageInput = {recipientId:agent.id,recipientKind:'agent',content:'Review the approved market brief and reply with the evidence.',actionable:true,inReplyTo:null,taskId:null};
export const message = {...base('message-review'),...messageInput,sender:human,taskId:task.id,inputJobId:'job-review',deliveryStatus:'blocked',blockedReason:'Agent is awaiting approval.'};
export const escalationInput = {agentId:agent.id,taskId:task.id,severity:'medium',category:'missing_evidence',situation:'The brief references an unavailable source.',attemptedActions:['Checked the approved source directory.'],reason:'The source is required to verify a claim.',recommendation:'Provide the source before continuing.',requestedFrom:'human-ceo'};
export const escalation = {...base('escalation-source'),...escalationInput,status:'OPEN',resolution:null,resolvedBy:null,followUpTaskId:null};
export const memoryInput = {ownerAgentId:agent.id,category:'episodic',title:'Source availability finding',content:'The referenced evidence file was not included in the approved brief.',scope,provenance:evidence,expiresAt:null,supersedesId:null};
export const memory = {...base('memory-finding'),...memoryInput,status:'ACTIVE',approvedBy:null};
export const learning = {...base('learning-evidence'),agentId:agent.id,observation:'Source validation found a missing attachment.',hypothesis:'Checking attachments before drafting avoids unsupported conclusions.',conclusion:'Validate source availability before drafting.',evidence,memoryIds:[memory.id],canonicalRevisionId:null};
export const evaluation = {...base('evaluation-report'),agentId:agent.id,taskId:task.id,criteria:'Every claim cites an approved source.',passed:true,score:1,evidence};
export const usage = {...base('usage-review'),agentId:agent.id,jobId:'job-review',attempt:1,modelCalls:1,inputTokens:240,outputTokens:120,cost:null,currency:'USD',status:'SETTLED',reservedCost:0.1};
export const event = {...base('event-verification'),agentId:agent.id,taskId:task.id,jobId:'job-review',attempt:1,metaAgentId:'meta-factory',hiringRequestId:hire.id,correlationId:'correlation-review',type:'verification.completed',message:'Report content was read back and its hash verified.',data:{sha256:'a'.repeat(64)},executedBy:'worker-local'};
export const artifact = {...base('artifact-report'),agentId:agent.id,jobId:'job-review',attempt:1,path:'agent-research/job-review/1/report.md',contentType:'text/markdown',size:142,sha256:'a'.repeat(64),scope};
export const check = {name:'memory',passed:true,evidence,error:null};
export const resource = {...base('resource-workspace'),agentId:agent.id,type:'workspace',reference:'agent-research',status:'AVAILABLE',grants:[grant],verification:check};
export const schedule = {...base('schedule-learn'),agentId:agent.id,kind:'learn',intervalSeconds:86400,nextRunAt:'2026-09-13T10:00:00.000Z',enabled:true,payload:{}};
export const governanceInput = {agentId:agent.id,kind:'budget',expectedVersion:1,reason:'Expand the approved research capacity.',changes:{budget:{...budget,modelCallsDaily:30}}};
export const governance = {...base('governance-budget'),...governanceInput,requestedBy:human,status:'PENDING',approvedBy:null};
export const lease = {leaseToken:'lease-token-example',attempt:1};
export const job = {jobId:'job-review',kind:'run_task',payloadVersion:1,organizationId:'org-demo',agentId:agent.id,taskId:task.id,metaAgentId:'meta-factory',hiringRequestId:hire.id,inputMessageId:message.id,idempotencyKey:'task-review-run',...lease,leaseExpiresAt:'2026-09-12T10:01:00.000Z',payload:{agent,task,inputMessage:message}};
export const jobOutcomes = [
  {...lease,outcome:{kind:'compile_manifest',manifest}},
  {...lease,outcome:{kind:'provision_agent',steps:[{name:'workspace',status:'PASSED',evidence,error:null}],checks:[check],resources:[resource]}},
  {...lease,outcome:{kind:'reconfigure_agent',steps:[{name:'workspace',status:'PASSED',evidence,error:null}],checks:[check],resources:[resource]}},
  {...lease,outcome:{kind:'run_task',evidence,summary:'Completed the source review.',reply:'The report is ready for review.'}},
  {...lease,outcome:{kind:'learn',learning:{observation:learning.observation,hypothesis:learning.hypothesis,conclusion:learning.conclusion,evidence,memoryIds:[memory.id],canonicalRevisionId:null}}},
  {...lease,outcome:{kind:'retire_agent',evidence,credentialsRevoked:true,runtimeDisabled:true,knowledgePreserved:true,activeTasksResolved:true}}
];
const auth = {principal:human,delegatedAgentId:null,jobId:null,attempt:null};
const single = (value:unknown) => ({data:value});
const list = (value:unknown) => ({data:[value],nextCursor:null});
const examples: Record<string,{body?:unknown;response:unknown}> = {
 login:{body:{token:'example-operator-token'},response:single(auth)},logout:{body:{},response:single({loggedOut:true})},getSession:{response:single(auth)},
 getOrganization:{response:single({organization,teams:[team],coordinator,agents:[agent]})},listAgents:{response:list(agent)},getAgent:{response:single({agent,grants:[grant],resources:[resource],verification:[check]})},
 createHiringRequest:{body:proposal,response:single(hire)},listHiringRequests:{response:list(hire)},getHiringRequest:{response:single(hire)},decideHiringRequest:{body:{decision:'approve',expectedVersion:1,manifestVersion:1,reason:'Reviewed the exact manifest and operating budget.'},response:single({...hire,status:'APPROVED',approvedBy:'human-ceo',approvedManifestVersion:1,version:2})},
 createTask:{body:taskInput,response:single(task)},listTasks:{response:list(task)},getTask:{response:single(task)},cancelTask:{body:{expectedVersion:1,reason:'The source brief has been withdrawn.'},response:single({...task,status:'CANCELLED',cancellationRequested:true,version:2})},
 createMessage:{body:messageInput,response:single(message)},listMessages:{response:list(message)},createEscalation:{body:escalationInput,response:single(escalation)},listEscalations:{response:list(escalation)},resolveEscalation:{body:{expectedVersion:1,resolution:'The approved source is now available.',followUp:taskInput},response:single({...escalation,status:'RESOLVED',resolution:'The approved source is now available.',resolvedBy:'human-ceo',followUpTaskId:'task-followup',version:2})},
 createMemory:{body:memoryInput,response:single(memory)},listMemory:{response:list(memory)},getMemory:{response:single(memory)},listLearning:{response:list(learning)},listEvaluations:{response:list(evaluation)},listUsage:{response:list(usage)},listEvents:{response:list(event)},listResources:{response:list(resource)},listSchedules:{response:list(schedule)},createSchedule:{body:{agentId:agent.id,kind:'learn',intervalSeconds:86400,nextRunAt:schedule.nextRunAt,payload:{}},response:single(schedule)},
 lifecycleAction:{body:{action:'pause',expectedVersion:1,reason:'Operator maintenance.'},response:single({agent:{...agent,status:'PAUSED',version:2},governance:null})},createGovernance:{body:governanceInput,response:single(governance)},listGovernance:{response:list(governance)},decideGovernance:{body:{decision:'approve',expectedVersion:1,reason:'Approved after reviewing the budget delta.'},response:single({...governance,status:'APPLIED',approvedBy:'human-ceo',version:2})},
 getArtifact:{response:single(artifact)},getArtifactContent:{response:'# Verified report\n'},claimJob:{body:{kinds:['run_task'],leaseSeconds:60},response:single(job)},renewJob:{body:{...lease,leaseSeconds:60},response:single({leaseExpiresAt:'2026-09-12T10:02:00.000Z'})},verifyProvisionCommunication:{body:lease,response:single({message:{...message,id:'message-provision-verification',sender:{id:agent.id,kind:'agent',organizationId:agent.organizationId},recipientId:'human-ceo',recipientKind:'human',content:'Provisioning communication verification.',actionable:false,taskId:null,inputJobId:null,deliveryStatus:'queued',blockedReason:null},escalation:{...escalation,id:'escalation-provision-verification',taskId:null,category:'provisioning_verification',situation:'Provisioning escalation verification.',severity:'low'}})},appendJobEvent:{body:{...lease,type:event.type,message:event.message,data:event.data},response:single(event)},completeJob:{body:jobOutcomes[3],response:single({jobId:job.jobId,status:'COMPLETED',duplicate:false})},failJob:{body:{...lease,code:'SOURCE_UNAVAILABLE',message:'Approved source is unavailable.',retryable:false,evidence:null},response:single({jobId:job.jobId,status:'FAILED',duplicate:false})},publishArtifact:{body:{...lease,path:artifact.path,contentType:artifact.contentType,size:artifact.size,sha256:artifact.sha256,scope},response:single(artifact)},reserveBudget:{body:{...lease,modelCalls:1,cost:0.1,currency:'USD'},response:single({...usage,status:'RESERVED',modelCalls:1,inputTokens:null,outputTokens:null,cost:null})},settleBudget:{body:{...lease,reservationId:usage.id,modelCalls:1,inputTokens:240,outputTokens:120,cost:null},response:single(usage)}
};
export const routeFixtures = routes.map(route => ({operationId:route.operationId,method:route.method,url:route.url,request:{...(route.schema.params?{params:{id:route.url.includes('/jobs/')?job.jobId:agent.id}}:{}),...(route.schema.headers?{headers:{'idempotency-key':`fixture-${route.operationId}`}}:{}),...(route.schema.querystring?{querystring:{limit:25}}:{}),...(examples[route.operationId]?.body!==undefined?{body:examples[route.operationId].body}:{})},status:200,response:examples[route.operationId]?.response}));
export const emptyStates = routes.filter(r=>r.schema.querystring).map(r=>({operationId:r.operationId,status:200,response:{data:[],nextCursor:null}}));
export const errorFixtures = [
 {status:401,response:{error:{code:'UNAUTHENTICATED',message:'An operator session or valid worker credential is required.',retryable:false,correlationId:'correlation-auth'}}},
 {status:409,response:{error:{code:'VERSION_CONFLICT',message:'The reviewed manifest version has changed.',retryable:false,correlationId:'correlation-version'}}},
 {status:409,response:{error:{code:'LEASE_EXPIRED',message:'This attempt no longer owns the job lease.',retryable:false,correlationId:'correlation-lease'}}},
 {status:429,response:{error:{code:'BUDGET_EXCEEDED',message:'The daily budget cannot cover this reservation.',retryable:true,correlationId:'correlation-budget'}}}
];
export const workerJobFixtures = [
 {...job,jobId:'job-compile',kind:'compile_manifest',taskId:null,inputMessageId:null,payload:{hiringRequest:hire,agent,organization,teams:[team]}},
 ...['provision_agent','reconfigure_agent'].map(kind=>({...job,jobId:`job-${kind}`,kind,taskId:null,inputMessageId:null,payload:{agent,manifest,manifestVersion:1}})),
 job,{...job,kind:'learn',taskId:null,inputMessageId:null,payload:{agent}},
 {...job,kind:'retire_agent',taskId:null,inputMessageId:null,payload:{agent,reason:'Human-approved retirement.'}}
];
