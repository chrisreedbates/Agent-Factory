import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { routes, cleanResponse, CONTRACT_VERSION, type ApiRoute } from '@agent-factory/contracts';
import type { Queryable } from '@agent-factory/db';
import { transaction, digest, type Actor, type RecordData, type Store } from './store.js';
import { DomainError, assertWorkAdmission } from './domain.js';
import { Service } from './service.js';
import { WorkerService } from './worker.js';
export interface AppConfig {
  db: Queryable; organizationId?: string; operatorToken: string; workerToken: string;
  humanPrincipalId?: string; workerPrincipalId?: string; artifactRoot: string;
  publicOrigin?: string; now?: () => Date;
  acquire?: () => Promise<{db:Queryable;release:()=>void}>;
}
const same = (a:string,b:string) => {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function deny(code:string,message:string,status=403):never {throw new DomainError(code,message,status);}
export function buildApp(config:AppConfig) {
  if(config.operatorToken.length<32||config.workerToken.length<32||config.operatorToken===config.workerToken)throw new Error('Configure distinct operator and worker tokens of at least 32 characters');
  const organizationId=config.organizationId??'org-demo',humanId=config.humanPrincipalId??'human-ceo',workerId=config.workerPrincipalId??'worker-local';
  const publicOrigin=config.publicOrigin??'http://localhost:3000';
  const app=Fastify({logger:false,bodyLimit:1024*1024,ajv:{customOptions:{removeAdditional:false,coerceTypes:false,allErrors:false}}});
  app.register(cookie);
  // Query strings are textual; only this explicitly numeric query parameter is coerced.
  // Body nulls must remain null, particularly unknown usage and cost values.
  app.addHook('preValidation',async request=>{
    const query=request.query as Record<string,unknown>|undefined;
    if(query&&typeof query.limit==='string'&&/^[0-9]+$/.test(query.limit))query.limit=Number(query.limit);
  });
  const scrub=(value:any):any=>{
    if(typeof value==='string')return value.split(config.operatorToken).join('[REDACTED]').split(config.workerToken).join('[REDACTED]').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{10,})/gi,'[REDACTED]');
    if(Array.isArray(value))return value.map(scrub);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|client[_-]?secret|private[_-]?key|credential|token)$/i.test(k)?'[REDACTED]':scrub(v)]));
    return value;
  };
  app.setErrorHandler((error:any,request,reply)=>{
    const status=error instanceof DomainError?error.status:error.validation?400:500;
    const code=error instanceof DomainError?error.code:error.validation?'VALIDATION_ERROR':'INTERNAL_ERROR';
    const message=error instanceof DomainError?scrub(error.message):error.validation?'Request does not match the versioned API schema':'The request could not be completed';
    reply.status(status).send({error:{code,message,retryable:status===500||status===429,correlationId:request.id.replace(/[^A-Za-z0-9_-]/g,'_')}});
  });
  async function auth(s:Store,r:any,route:ApiRoute):Promise<Actor> {
    const authorization=r.headers.authorization;
    if(authorization!==undefined&&(typeof authorization!=='string'||!/^Bearer [^\s]+$/i.test(authorization)))deny('UNAUTHENTICATED','Authorization requires the Bearer scheme',401);
    const bearer=authorization===undefined?'':authorization.slice(7);
    let actor:Actor;
    if(bearer&&same(bearer,config.operatorToken))actor={id:humanId,kind:'human',organizationId};
    else if(bearer&&same(bearer,config.workerToken))actor={id:workerId,kind:'worker',organizationId};
    else {
      const raw=r.cookies.af_session;
      const session=raw?await s.maybe('idempotency_keys',`session-${digest(raw)}`):null;
      if(!session||session.scope!=='session'||session.expiresAt<=s.timestamp())deny('UNAUTHENTICATED','Operator session or worker authentication is required',401);
      actor={id:session.principalId,kind:'human',organizationId};
    }
    const p=await s.get('principals',actor.id);if(p.kind!==actor.kind)deny('INVALID_PRINCIPAL','Configured identity does not match credential class');
    if(route.auth==='worker') {if(actor.kind!=='worker')deny('WORKER_REQUIRED','This operation requires a worker credential');return actor;}
    if(actor.kind==='worker') {
      if(route.auth==='human')deny('HUMAN_APPROVAL_REQUIRED','This operation requires a human principal');
      const jobId=String(r.headers['x-job-id']??''),token=String(r.headers['x-lease-token']??''),attempt=Number(r.headers['x-job-attempt']);
      const job=await s.maybe('jobs',jobId);
      if(!job||job.status!=='RUNNING'||job.workerPrincipalId!==workerId||job.attempt!==attempt||job.leaseToken!==token||!job.leaseExpiresAt||job.leaseExpiresAt<=s.timestamp())deny('STALE_LEASE','Delegated access requires the current unexpired worker lease',409);
      if(!['run_task','learn'].includes(job.kind)||!job.agentId)deny('DELEGATION_FORBIDDEN','Only agent task or learning execution may act as an agent');
      const agent=await s.get('agents',job.agentId);assertWorkAdmission(agent as any);
      if(agent.cancellationRequested)deny('EXECUTION_CANCELLED','Agent execution is cancelled',409);
      actor={id:agent.id,kind:'agent',organizationId,job};
    }
    return actor;
  }
  for(const route of routes) {
    app.route({method:route.method,url:route.url,schema:route.schema,handler:async(request:any,reply)=>{
      if(request.headers.origin&&request.headers.origin!==publicOrigin)deny('ORIGIN_FORBIDDEN','Request origin is not allowed');
      if(request.headers['sec-fetch-site']==='cross-site')deny('ORIGIN_FORBIDDEN','Cross-site requests are not allowed');
      const acquired=config.acquire?await config.acquire():{db:config.db,release:()=>{}};
      try {
        return await transaction(acquired.db,organizationId,async s=>{
          const op=route.operationId;
          if(op==='login') {
            if(!same(request.body.token,config.operatorToken))deny('UNAUTHENTICATED','Invalid operator credential',401);
            const configuredHuman=await s.get('principals',humanId);
            if(configuredHuman.kind!=='human')deny('INVALID_PRINCIPAL','Configured operator identity must be a human principal');
            const raw=randomBytes(32).toString('base64url');
            await s.insert('idempotency_keys',{scope:'session',key:digest(raw),principalId:humanId,expiresAt:new Date(s.now().getTime()+8*3600000).toISOString()},`session-${digest(raw)}`);
            reply.setCookie('af_session',raw,{httpOnly:true,sameSite:'strict',secure:publicOrigin.startsWith('https:'),path:'/',maxAge:8*3600});
            return {data:{principal:{id:humanId,kind:'human',organizationId},delegatedAgentId:null,jobId:null,attempt:null}};
          }
          const actor=await auth(s,request,route);
          if(op==='logout') {
            if(request.cookies.af_session){const session=await s.maybe('idempotency_keys',`session-${digest(request.cookies.af_session)}`);if(session)await s.save('idempotency_keys',{...session,expiresAt:s.timestamp()});}
            reply.clearCookie('af_session',{path:'/'});return {data:{loggedOut:true}};
          }
          if(op==='getSession')return {data:{principal:{id:actor.id,kind:actor.kind,organizationId},delegatedAgentId:actor.kind==='agent'?actor.id:null,jobId:actor.job?.id??null,attempt:actor.job?.attempt??null}};
          let body=request.body??{};
          if(['appendJobEvent','failJob'].includes(op))body=scrub(body);
          const id=request.params?.id??'';
          const key=['claimJob','renewJob'].includes(op)?undefined:request.headers['idempotency-key'];
          const fingerprint=digest({op,id,body,actor:actor.id,jobId:actor.job?.id??null,attempt:actor.job?.attempt??null});
          const cacheId=key?`idem-${digest({op,actor:actor.id,key})}`:null;
          const cached=cacheId?await s.maybe('idempotency_keys',cacheId):null;
          if(cached) {
            if(cached.fingerprint!==fingerprint)deny('IDEMPOTENCY_CONFLICT','Idempotency key was already used for different input',409);
            if(route.auth==='worker') {
              const job=await s.get('jobs',id);
              const sameOwner=job.workerPrincipalId===actor.id&&job.attempt===body.attempt&&job.leaseToken===body.leaseToken;
              const acceptedCompletion=op==='completeJob'&&job.status==='COMPLETED'&&job.outcomeDigest===digest(body.outcome);
              const acceptedFailure=op==='failJob'&&['FAILED','QUEUED'].includes(job.status)&&job.failureDigest===digest({code:body.code,message:body.message,retryable:body.retryable,evidence:body.evidence});
              const liveLease=job.status==='RUNNING'&&typeof job.leaseExpiresAt==='string'&&Number.isFinite(Date.parse(job.leaseExpiresAt))&&Date.parse(job.leaseExpiresAt)>s.now().getTime();
              const replayAllowed=['completeJob','failJob'].includes(op)?acceptedCompletion||acceptedFailure:liveLease;
              if(!sameOwner||!replayAllowed||job.cancellationRequested)deny('STALE_LEASE','Previous or cancelled lease owner cannot replay this mutation',409);
            }
            return cached.response;
          }
          const result=route.auth==='worker'?await new WorkerService(s,{artifactRoot:config.artifactRoot,workerPrincipalId:workerId}).handle(op,id,body,actor):await new Service(s,actor,config.artifactRoot).handle(op,id,body,request.query??{});
          if(op==='getArtifactContent') {reply.header('content-type','application/octet-stream').header('content-disposition','attachment').header('x-content-type-options','nosniff');return result;}
          const response=cleanResponse(route.schema.response[200]!,op.startsWith('list')?result:{data:result});
          if(cacheId)await s.insert('idempotency_keys',{scope:`${actor.id}:${op}`,key,fingerprint,response},cacheId);
          reply.header('x-contract-version',CONTRACT_VERSION);return response;
        },config.now);
      } finally {acquired.release();}
    }});
  }
  app.get('/health',async()=>({status:'ok',contractVersion:CONTRACT_VERSION}));
  return app;
}
