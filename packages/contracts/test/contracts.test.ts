import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { Job, JobOutcome, AgentManifest, ErrorResponse, openApi, routes, cleanResponse } from '../src/index.js';
import { routeFixtures, emptyStates, errorFixtures, workerJobFixtures, jobOutcomes, manifest } from '../src/fixtures.js';
test('every operation has concrete request and response fixtures matching runtime schemas',()=>{
 assert.equal(routeFixtures.length,routes.length);
 for(const route of routes){
  const fixture=routeFixtures.find(f=>f.operationId===route.operationId)!;
  assert.notEqual(fixture.response,undefined,route.operationId);
  for(const key of ['body','params','headers','querystring'] as const){
   if(route.schema[key]) assert.ok(Value.Check(route.schema[key]!,fixture.request[key]),`${route.operationId} ${key}: ${JSON.stringify([...Value.Errors(route.schema[key]!,fixture.request[key])])}`);
  }
  assert.ok(Value.Check(route.schema.response[200],fixture.response),`${route.operationId} response: ${JSON.stringify([...Value.Errors(route.schema.response[200],fixture.response)])}`);
 }
});
test('every list has a validated empty state; unknown cost remains null',()=>{
 for(const fixture of emptyStates) assert.ok(Value.Check(routes.find(r=>r.operationId===fixture.operationId)!.schema.response[200],fixture.response));
 const usage=routeFixtures.find(f=>f.operationId==='listUsage')!.response as {data:{cost:number|null}[]};assert.equal(usage.data[0].cost,null);
});
test('all worker job kinds and completion variants are represented',()=>{
 assert.equal(new Set(workerJobFixtures.map(j=>j.kind)).size,6);
 for(const job of workerJobFixtures) assert.ok(Value.Check(Job,job),JSON.stringify([...Value.Errors(Job,job)]));
 for(const outcome of jobOutcomes) assert.ok(Value.Check(JobOutcome,outcome),JSON.stringify([...Value.Errors(JobOutcome,outcome)]));
});
test('errors match one public envelope',()=>{for(const fixture of errorFixtures) assert.ok(Value.Check(ErrorResponse,fixture.response));});
test('server-owned status and spoofed actors cannot be inserted into a manifest',()=>{
 assert.ok(Value.Check(AgentManifest,manifest));
 assert.equal(Value.Check(AgentManifest,{...manifest,agent:{...manifest.agent,status:'ACTIVE'}}),false);
 assert.equal(Value.Check(AgentManifest,{...manifest,requestedBy:{id:'human-ceo'}}),false);
});
test('OpenAPI covers every runtime route without duplicate operations',()=>{
 const api=openApi();assert.equal(api.info.version,'1.0.0');assert.equal(new Set(routes.map(r=>r.operationId)).size,routes.length);
 for(const route of routes) assert.ok(api.paths[route.url.replace(/:([A-Za-z]+)/g,'{$1}')][route.method.toLowerCase()]);
});

test('response cleaning removes service fields without mutating persisted input',()=>{
 const internal={...manifest,privateCache:'server-only',agent:{...manifest.agent,internalLease:'secret'}};
 const result=cleanResponse(AgentManifest,internal);
 assert.deepEqual(result,manifest);
 assert.equal(internal.privateCache,'server-only');
 assert.equal(internal.agent.internalLease,'secret');
 assert.throws(()=>cleanResponse(AgentManifest,{agent:{id:'broken'}}),/does not match/);
});
