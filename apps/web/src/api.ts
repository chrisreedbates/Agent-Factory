import type { AgentManifest } from '@agent-factory/contracts';
export type Json = Record<string, unknown>;
export type Page<T> = { data: T[]; nextCursor?: string | null };
export type Manifest = AgentManifest;
export type Versioned = { id: string; version: number; status?: string; createdAt?: string; updatedAt?: string };
export type Agent = Versioned & { status: string; activity: string; manifest: Manifest | null; manifestVersion: number | null; cancellationRequested: boolean; requestedBy?: {kind:string;id:string}; approvedBy?:string|null; provisionedBy?:string|null; hiringRequestId?:string; metaAgentId?:string };
export type Hire = Versioned & { status: string; requestedBy: { kind: string; id: string }; proposal: { role: string; mission: string; teamId: string }; manifest: Manifest | null; manifestVersion: number | null; agentId: string; originatingTaskId: string | null; originatingJobId: string | null; approvedBy: string | null; approvedManifestVersion: number | null; provisionedBy: string | null };
export type Check = { name: string; passed: boolean; error: string | null; evidence?: { summary: string } };
export type AgentDetail = { agent: Agent; grants: Json[]; resources: Versioned[]; verification: Check[] };
export type OrganizationDetail = { organization: Versioned & { name: string; mission: string }; teams: (Versioned & { name: string; mission: string })[]; coordinator: Versioned & { name: string }; agents: Agent[] };
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
// Retain unresolved command identities across reloads without storing request content.
const pending = new Map<string,string>();
const storageKey=(hash:string)=>`agent-factory:pending:${hash}`;
const readPending=(hash:string)=>{try{return sessionStorage.getItem(storageKey(hash))??pending.get(hash)}catch{return pending.get(hash)}};
const savePending=(hash:string,key:string)=>{pending.set(hash,key);try{sessionStorage.setItem(storageKey(hash),key)}catch{/* Restricted storage still preserves live-tab retries. */}};
const clearPending=(hash:string)=>{pending.delete(hash);try{sessionStorage.removeItem(storageKey(hash))}catch{/* Storage may be unavailable. */}};
const hashCommand=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutation = init.method === 'POST';
  const tracked = mutation && !path.startsWith('/v1/session');
  const fingerprint = tracked ? await hashCommand(path + ':' + String(init.body ?? '')) : '';
  const commandKey = mutation ? (tracked ? readPending(fingerprint) : undefined) ?? crypto.randomUUID() : undefined;
  if (tracked) savePending(fingerprint, commandKey!);
  const response = await fetch(path, { ...init, credentials: 'include', headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(mutation ? { 'idempotency-key': commandKey! } : {}), ...init.headers } });
  if (!response.ok) {
    if (response.status < 500 && tracked) clearPending(fingerprint);
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `API returned ${response.status}`);
  }
  const result = await response.json() as T;
  if (tracked) clearPending(fingerprint);
  return result;
}
const get = <T>(path: string) => request<T>(path); const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }); const page = <T>(path: string) => get<Page<T>>(path);
export const api = {
  login: (token: string) => post('/v1/session', { token }), logout: () => post('/v1/session/logout', {}), session: () => get<{ data: Json }>('/v1/session'), organization: () => get<{ data: OrganizationDetail }>('/v1/organization'), agents: () => page<Agent>('/v1/agents'), agent: (id: string) => get<{ data: AgentDetail }>(`/v1/agents/${id}`),
  hires: () => page<Hire>('/v1/hiring-requests'), createHire: (body: Json) => post<{ data: Hire }>('/v1/hiring-requests', body), decideHire: (hire: Hire, decision: 'approve' | 'reject', reason: string) => post<{ data: Hire }>(`/v1/hiring-requests/${hire.id}/decision`, { decision, expectedVersion: hire.version, manifestVersion: hire.manifestVersion, reason }),
  tasks: () => page<Versioned & Json>('/v1/tasks'), createTask: (body: Json) => post('/v1/tasks', body), cancelTask: (id: string, expectedVersion: number, reason: string) => post(`/v1/tasks/${id}/cancel`, { expectedVersion, reason }), messages: () => page<Versioned & Json>('/v1/messages'), sendMessage: (body: Json) => post('/v1/messages', body),
  escalations: () => page<Versioned & Json>('/v1/escalations'), createEscalation: (body: Json) => post('/v1/escalations', body), resolveEscalation: (id: string, expectedVersion: number, resolution: string) => post(`/v1/escalations/${id}/resolve`, { expectedVersion, resolution, followUp: null }),
  memory: () => page<Versioned & Json>('/v1/memory'), learning: () => page<Versioned & Json>('/v1/learning'), evaluations: () => page<Versioned & Json>('/v1/evaluations'), usage: () => page<Versioned & Json>('/v1/usage'), events: () => page<Versioned & Json>('/v1/events'), resources: () => page<Versioned & Json>('/v1/resources'), schedules: () => page<Versioned & Json>('/v1/schedules'), createSchedule: (body: Json) => post('/v1/schedules', body),
  governance: () => page<Versioned & Json>('/v1/governance'), createGovernance: (body: Json) => post('/v1/governance', body), decideGovernance: (id: string, expectedVersion: number, decision: 'approve' | 'reject', reason: string) => post(`/v1/governance/${id}/decision`, { decision, expectedVersion, reason }), lifecycle: (id: string, body: Json) => post(`/v1/agents/${id}/lifecycle`, body), artifact: (id: string) => get<{ data: Versioned & Json }>(`/v1/artifacts/${id}`), artifactContent: (id: string) => fetch(`/v1/artifacts/${id}/content`, { credentials: 'include' }).then(r => r.ok ? r.text() : Promise.reject(new ApiError(r.status, 'Artifact unavailable')))
};
