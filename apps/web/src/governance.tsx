import { useState } from 'react';
import type { Agent, Manifest } from './api';
import { api } from './api';
const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,JSON.parse(canonical(item))])):value);
export function reviewedManifest(source:string, original:Manifest):Manifest {
  const parsed:unknown=JSON.parse(source);
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Enter a complete manifest object.');
  const manifest=parsed as Manifest;
  for(const field of Object.keys(original))if(!(field in manifest))throw new Error(`Complete manifest required: missing ${field}.`);
  if(canonical(manifest)===canonical(original))throw new Error('Edit the manifest before proposing a change.');
  if(manifest.agent?.id!==original.agent.id)throw new Error('The agent ID cannot change.');
  return manifest;
}
export function GovernanceEditor({agent,run}:{agent:Agent;run:(action:()=>Promise<unknown>,success:string)=>Promise<unknown>}){
  const [source,setSource]=useState(JSON.stringify(agent.manifest,null,2)),[reason,setReason]=useState(''),[kind,setKind]=useState('reconfigure'),[reviewed,setReviewed]=useState(false),[sending,setSending]=useState(false);
  if(!agent.manifest)return null;
  return <details><summary>Review and propose a manifest change</summary><p>Edit the complete manifest below. The API validates authority and contract fields. Submission creates a pending proposal; approval is a separate decision.</p><label>Change type <select aria-label="Change type" value={kind} onChange={e=>{setKind(e.target.value);setReviewed(false)}}><option value="reconfigure">Reconfiguration</option><option value="grant">Tool grant</option><option value="budget">Budget</option></select></label><label>Edited manifest<textarea aria-label="Edited manifest" rows={20} value={source} onChange={e=>{setSource(e.target.value);setReviewed(false)}}/></label><label>Change reason<input aria-label="Change reason" value={reason} onChange={e=>{setReason(e.target.value);setReviewed(false)}}/></label><label><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/> I reviewed this complete edited manifest and reason</label><button disabled={sending||!reviewed||!reason.trim()} onClick={async()=>{setSending(true);try{const ok=await run(()=>{const manifest=reviewedManifest(source,agent.manifest!);return kind==='reconfigure'?api.lifecycle(agent.id,{action:'reconfigure',expectedVersion:agent.version,reason,manifest}):api.createGovernance({agentId:agent.id,kind,expectedVersion:agent.version,reason,changes:{manifest}})},'Manifest change proposed; awaiting governance approval');if(ok)setReviewed(false)}finally{setSending(false)}}}>Submit reviewed change</button></details>
}
export function OrganizationTree({agents,select,selected}:{agents:Agent[];select:(agent:Agent)=>void;selected:string}){
  const nodes=(items:Agent[],seen:Set<string>):React.ReactNode=> <ul>{items.map(agent=>{const path=new Set(seen).add(agent.id);const reports=agents.filter(child=>child.manifest?.organization.managerKind==='agent'&&child.manifest.organization.managerId===agent.id&&!path.has(child.id));return <li key={agent.id}><button className={selected===agent.id?'selected agent':'secondary agent'} onClick={()=>select(agent)}>{agent.manifest?.agent.name??agent.id}<small>{agent.id} — {agent.status} / {agent.activity}</small></button><p>Reports to {agent.manifest?.organization.managerKind??'uncompiled'} {agent.manifest?.organization.managerId??'pending manifest'}</p><p className="muted">Requested by {agent.requestedBy?.kind??'unknown'} {agent.requestedBy?.id??'unknown'} · approved by {agent.approvedBy??'pending'} · provisioned by {agent.provisionedBy??'pending'} · hire {agent.hiringRequestId??'unknown'}</p>{reports.length>0&&nodes(reports,path)}</li>})}</ul>;
  const roots=agents.filter(a=>a.manifest?.organization.managerKind!=='agent'||!agents.some(parent=>parent.id===a.manifest?.organization.managerId));
  const reachable=new Set<string>();const mark=(agent:Agent)=>{if(reachable.has(agent.id))return;reachable.add(agent.id);agents.filter(a=>a.manifest?.organization.managerKind==='agent'&&a.manifest.organization.managerId===agent.id).forEach(mark)};roots.forEach(mark);
  const unresolved=agents.filter(a=>!reachable.has(a.id));
  return <div className="hierarchy" aria-label="Reporting hierarchy">{nodes(roots,new Set())}{unresolved.length>0&&<><p className="warning">Reporting cycle or unresolved hierarchy</p>{nodes(unresolved,new Set())}</>}</div>
}
