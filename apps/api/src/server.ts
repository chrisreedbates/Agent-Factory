import { connect, type Queryable } from '@agent-factory/db';
import { buildApp } from './app.js';
import { resolve } from 'node:path';
const pool=connect();
const app=buildApp({db:pool as unknown as Queryable,acquire:async()=>{const client=await pool.connect();return {db:client as unknown as Queryable,release:()=>client.release()};},operatorToken:process.env.OPERATOR_TOKEN??'',workerToken:process.env.WORKER_TOKEN??'',organizationId:process.env.ORGANIZATION_ID,humanPrincipalId:process.env.HUMAN_PRINCIPAL_ID,workerPrincipalId:process.env.WORKER_PRINCIPAL_ID,artifactRoot:resolve(process.env.ARTIFACT_ROOT??'./artifacts'),publicOrigin:process.env.PUBLIC_ORIGIN??'http://localhost:3000'});
await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??3000)});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await app.close();await pool.end();process.exit(0);});
