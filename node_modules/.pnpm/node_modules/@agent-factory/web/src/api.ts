export type Agent={id:string;status:string;activity:string;manifest:{agent:{name:string};role:{title:string}}|null;updatedAt:string};
export type Hire={id:string;status:string;version:number;requestedBy:{kind:string;id:string};proposal:{role:string;mission:string;expectedBenefit:string};manifestVersion:number|null;agentId:string};
export type Check={name:string;passed:boolean;error:string|null};
type Page<T>={data:T[]};
const origin=import.meta.env.VITE_API_ORIGIN ?? '';
async function request<T>(path:string, init?:RequestInit):Promise<T>{const r=await fetch(origin+path,{...init,headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID(),...init?.headers}});if(!r.ok)throw new Error((await r.json().catch(()=>null))?.error?.message??`API returned ${r.status}`);return r.json()}
export const api={organization:()=>request<{data:{organization:{name:string};agents:Agent[]}}>('/v1/organization'),hires:()=>request<Page<Hire>>('/v1/hiring-requests'),agent:(id:string)=>request<{data:{verification:Check[]}}>('/v1/agents/'+id),approve:(hire:Hire)=>request<{data:Hire}>('/v1/hiring-requests/'+hire.id+'/decision',{method:'POST',body:JSON.stringify({decision:'approve',expectedVersion:hire.version,manifestVersion:hire.manifestVersion,reason:'Human approval from operator console'})})};
