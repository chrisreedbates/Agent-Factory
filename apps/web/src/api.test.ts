import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api';
test('an unresolved command retains its idempotency key; resolved commands get new keys',async()=>{
  const fetchBefore=globalThis.fetch;const keys:string[]=[];let attempts=0;
  globalThis.fetch=async(_url,init)=>{keys.push(new Headers(init?.headers).get('idempotency-key')!);attempts++;if(attempts===1)throw new TypeError('Response lost');if(attempts===2)return new Response('{}',{status:503});return Response.json({data:{id:'task'}})};
  try{const body={agentId:'idempotency-test',objective:'do work'};await assert.rejects(api.createTask(body));await assert.rejects(api.createTask(body),ApiError);await api.createTask(body);await api.createTask(body);assert.equal(keys[0],keys[1]);assert.equal(keys[1],keys[2]);assert.notEqual(keys[2],keys[3]);}finally{globalThis.fetch=fetchBefore}
});
test('a rejected stale command does not hold its key for a corrected retry',async()=>{
 const fetchBefore=globalThis.fetch;const keys:string[]=[];globalThis.fetch=async(_url,init)=>{keys.push(new Headers(init?.headers).get('idempotency-key')!);return new Response('{}',{status:409})};
 try{await assert.rejects(api.cancelTask('stale-task',1,'stop'));await assert.rejects(api.cancelTask('stale-task',2,'stop'));assert.notEqual(keys[0],keys[1]);}finally{globalThis.fetch=fetchBefore}
});
