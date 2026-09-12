import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, seed, type Queryable } from '@agent-factory/db';
import { proposal } from '@agent-factory/contracts/fixtures';
import { buildApp } from '../src/app.js';
import { Store, digest } from '../src/store.js';
const operatorToken='operator-security-test-token-32-characters';
const workerToken='worker-security-test-token-32-characters';
async function setup(t:{after(fn:()=>Promise<unknown>):void}) {
 const pg=new PGlite();
 const db:Queryable={async query<T>(sql:string,values?:unknown[]){if(values?.length)return pg.query<T>(sql,values);const results=await pg.exec(sql);return {rows:(results.at(-1)?.rows??[]) as T[]};}};
 await migrate(db);await seed(db);
 let time=Date.parse('2026-09-12T10:00:00.000Z');
 const app=buildApp({db,operatorToken,workerToken,artifactRoot:'/unused-auth-test-artifacts',now:()=>new Date(time)});
 t.after(async()=>{await app.close();await pg.close();});
 const store=new Store(db,'org-demo',()=>new Date(time));
 let sequence=0;
 const request=(method:'GET'|'POST',url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{authorization:`Bearer ${operatorToken}`,...(method==='POST'?{'idempotency-key':`auth-${++sequence}`} : {}),...headers}});
 async function runningJob() {
  const hire=await request('POST','/v1/hiring-requests',proposal);assert.equal(hire.statusCode,200,hire.body);
  const claim=await request('POST','/v1/worker/jobs/claim',{kinds:['compile_manifest'],leaseSeconds:60},{authorization:`Bearer ${workerToken}`});assert.equal(claim.statusCode,200,claim.body);return claim.json().data;
 }
 return {app,store,request,runningJob,advance:(ms:number)=>{time+=ms;}};
}

test('operator cookie login, logout, expiry and origin checks use the frozen responses',async t=>{
 const h=await setup(t);
 const login=await h.app.inject({method:'POST',url:'/v1/session',payload:{token:operatorToken}});
 assert.equal(login.statusCode,200,login.body);
 const cookie=login.headers['set-cookie'] as string;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
 const cookieValue=cookie.split(';')[0]!;
 const session=await h.app.inject({method:'GET',url:'/v1/session',headers:{cookie:cookieValue}});assert.equal(session.statusCode,200);
 const crossOrigin=await h.app.inject({method:'POST',url:'/v1/session/logout',payload:{},headers:{cookie:cookieValue,origin:'https://attacker.example'}});assert.equal(crossOrigin.statusCode,403);
 const logout=await h.app.inject({method:'POST',url:'/v1/session/logout',payload:{},headers:{cookie:cookieValue}});assert.equal(logout.statusCode,200,logout.body);assert.deepEqual(logout.json(),{data:{loggedOut:true}});
 const expired=await h.app.inject({method:'GET',url:'/v1/session',headers:{cookie:cookieValue}});assert.equal(expired.statusCode,401);
 const malformed=await h.app.inject({method:'GET',url:'/v1/session',headers:{authorization:operatorToken}});assert.equal(malformed.statusCode,401);
});

test('only query.limit is converted; unknown usage numbers remain null',async t=>{
 const h=await setup(t);const job=await h.runningJob();const headers={authorization:`Bearer ${workerToken}`};const lease={leaseToken:job.leaseToken,attempt:job.attempt};
 const reserve=await h.request('POST',`/v1/worker/jobs/${job.jobId}/budget/reserve`,{...lease,modelCalls:1,cost:0.1,currency:'USD'},headers);assert.equal(reserve.statusCode,200,reserve.body);
 const settle=await h.request('POST',`/v1/worker/jobs/${job.jobId}/budget/settle`,{...lease,reservationId:reserve.json().data.id,modelCalls:1,inputTokens:null,outputTokens:null,cost:null},headers);assert.equal(settle.statusCode,200,settle.body);
 assert.equal(settle.json().data.cost,null);assert.equal(settle.json().data.inputTokens,null);assert.equal(settle.json().data.outputTokens,null);
 const invalid=await h.request('POST',`/v1/worker/jobs/${job.jobId}/budget/reserve`,{...lease,modelCalls:'1',cost:0.1,currency:'USD'},headers);assert.equal(invalid.statusCode,400);
 const page=await h.request('GET','/v1/usage?limit=1');assert.equal(page.statusCode,200,page.body);assert.equal(page.json().data[0].cost,null);
});

test('cached event writes cannot be replayed after a job is cancelled or its lease expires',async t=>{
 const h=await setup(t);const job=await h.runningJob();const headers={authorization:`Bearer ${workerToken}`,'idempotency-key':'same-event'};
 const body={leaseToken:job.leaseToken,attempt:job.attempt,type:'auth.test',message:'Observed evidence',data:{}};
 const first=await h.request('POST',`/v1/worker/jobs/${job.jobId}/events`,body,headers);assert.equal(first.statusCode,200,first.body);
 const again=await h.request('POST',`/v1/worker/jobs/${job.jobId}/events`,body,headers);assert.equal(again.statusCode,200,again.body);
 h.advance(61000);
 const expired=await h.request('POST',`/v1/worker/jobs/${job.jobId}/events`,body,headers);assert.equal(expired.statusCode,409);
 h.advance(-61000);
 await h.store.save('jobs',{...await h.store.get('jobs',job.jobId),status:'FAILED',cancellationRequested:true});
 const cancelled=await h.request('POST',`/v1/worker/jobs/${job.jobId}/events`,body,headers);assert.equal(cancelled.statusCode,409);
});

test('cached terminal receipts are tied to the accepted outcome instead of any FAILED state',async t=>{
 const h=await setup(t);const job=await h.runningJob();const idempotencyKey='completed-receipt';
 const body={leaseToken:job.leaseToken,attempt:job.attempt,outcome:{kind:'run_task',evidence:{artifactIds:[],eventIds:['event-evidence'],taskId:null,jobId:job.jobId,summary:'Synthetic accepted receipt'},summary:'Result',reply:null}};
 const fingerprint=digest({op:'completeJob',id:job.jobId,body,actor:'worker-local',jobId:null,attempt:null});
 await h.store.insert('idempotency_keys',{fingerprint,response:{data:{jobId:job.jobId,status:'COMPLETED',duplicate:false}}},`idem-${digest({op:'completeJob',actor:'worker-local',key:idempotencyKey})}`);
 await h.store.save('jobs',{...await h.store.get('jobs',job.jobId),status:'FAILED'});
 const denied=await h.request('POST',`/v1/worker/jobs/${job.jobId}/complete`,body,{authorization:`Bearer ${workerToken}`,'idempotency-key':idempotencyKey});assert.equal(denied.statusCode,409,denied.body);
 await h.store.save('jobs',{...await h.store.get('jobs',job.jobId),status:'COMPLETED',outcomeDigest:digest(body.outcome)});
 h.advance(61000);
 const receipt=await h.request('POST',`/v1/worker/jobs/${job.jobId}/complete`,body,{authorization:`Bearer ${workerToken}`,'idempotency-key':idempotencyKey});assert.equal(receipt.statusCode,200,receipt.body);
});

test('job claims ignore optional idempotency keys and expose no cached obsolete lease',async t=>{
 const h=await setup(t);const job=await h.runningJob();const headers={authorization:`Bearer ${workerToken}`,'idempotency-key':'repeated-claim'};
 const claim=()=>h.request('POST','/v1/worker/jobs/claim',{kinds:['compile_manifest'],leaseSeconds:60},headers);
 const idle=await claim();assert.equal(idle.statusCode,200,idle.body);assert.equal(idle.json().data,null);
 const row=await h.store.get('jobs',job.jobId);await h.store.save('jobs',{...row,status:'QUEUED'});
 const next=await claim();assert.equal(next.statusCode,200,next.body);assert.equal(next.json().data.jobId,job.jobId);assert.equal(next.json().data.attempt,job.attempt+1);
});

test('worker event payloads redact credentials before durable storage',async t=>{
 const h=await setup(t);const job=await h.runningJob();const headers={authorization:`Bearer ${workerToken}`};const lease={leaseToken:job.leaseToken,attempt:job.attempt};
 const event=await h.request('POST',`/v1/worker/jobs/${job.jobId}/events`,{...lease,type:'auth.redaction',message:`Leaked ${operatorToken}`,data:{api_key:'unknown-provider-secret',nested:{clientSecret:'sensitive',safe:'visible'}}},headers);assert.equal(event.statusCode,200,event.body);
 assert.ok(!event.body.includes(operatorToken));assert.ok(!event.body.includes('unknown-provider-secret'));assert.ok(!event.body.includes('sensitive'));assert.ok(event.body.includes('visible'));
 const persisted=await h.store.get('events',event.json().data.id);assert.equal(persisted.data.api_key,'[REDACTED]');assert.equal(persisted.data.nested.clientSecret,'[REDACTED]');
});
