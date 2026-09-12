import {test,expect} from '@playwright/test';
const manifest={agent:{id:'manager',name:'Manager',type:'employee'},organization:{teamId:'team',managerId:'operator',managerKind:'human',reports:['child']},role:{title:'Manager'},mission:{primary:'Manage'},responsibilities:['Review'],tools:['workspace-files'],permissions:[{tool:'workspace-files',operations:['read'],resource:null,credentialRef:null}],budget:{modelCallsDaily:10,externalSpendDaily:0,currency:'USD',maxConcurrentTasks:1},standards:['Review'],evaluation:{requiredVerificationChecks:['workspace-files']}};
const agent={id:'manager',version:3,status:'ACTIVE',activity:'idle',manifest,manifestVersion:1,requestedBy:{kind:'human',id:'operator'},approvedBy:'operator',provisionedBy:'worker',hiringRequestId:'hire-manager'};
const child={...agent,id:'child',hiringRequestId:'hire-child',requestedBy:{kind:'agent',id:'manager'},manifest:{...manifest,agent:{...manifest.agent,id:'child',name:'Assistant'},organization:{...manifest.organization,managerKind:'agent',managerId:'manager',reports:[]}}};
test.beforeEach(async({page})=>{
  await page.route('**/v1/**',async route=>{const url=new URL(route.request().url());let data:unknown=[];
    if(url.pathname==='/v1/organization')data={organization:{id:'org',name:'Test organization',mission:'Test'},coordinator:{id:'factory',name:'Factory'},teams:[],agents:[agent,child]};
    if(url.pathname==='/v1/agents/manager')data={agent,verification:[],grants:[],resources:[]};
    await route.fulfill({json:{data}});
  });
  await page.goto('/');
});
test('renders actual reporting hierarchy and recruitment provenance',async({page})=>{
  const tree=page.getByLabel('Reporting hierarchy');
  const manager=tree.locator('li').filter({has:page.getByRole('button',{name:/^Manager/})}).first();
  await expect(manager.locator('ul').getByRole('button',{name:/^Assistant/})).toBeVisible();
  await expect(manager.locator('ul')).toContainText('Requested by agent manager');
  await expect(manager).toContainText('approved by operator');
});
test('clears masked token after login and logout',async({page})=>{
  const input=page.getByLabel('Session token');await expect(input).toHaveAttribute('type','password');
  await input.fill('secret-operator');await page.getByRole('button',{name:'Start session'}).click();await expect(input).toHaveValue('');
  await input.fill('another-secret');await page.getByRole('button',{name:'End session'}).click();await expect(input).toHaveValue('');
});
test('sends the edited complete manifest for reconfiguration and governance',async({page})=>{
  await page.getByRole('button',{name:/^Manager/}).click();await page.getByText('Review and propose a manifest change',{exact:true}).click();
  const edited={...manifest,mission:{primary:'Changed mission'}};await page.getByLabel('Edited manifest',{exact:true}).fill(JSON.stringify(edited));await page.getByLabel('Change reason').fill('New assignment');await page.getByRole('checkbox',{name:'I reviewed this complete edited manifest and reason'}).check();
  const request=page.waitForRequest(r=>r.url().endsWith('/v1/agents/manager/lifecycle')&&r.method()==='POST');await page.getByRole('button',{name:'Submit reviewed change'}).click();
  expect((await request).postDataJSON()).toEqual({action:'reconfigure',expectedVersion:3,reason:'New assignment',manifest:edited});await expect(page.getByRole('checkbox',{name:'I reviewed this complete edited manifest and reason'})).not.toBeChecked();
  await page.getByLabel('Change type').selectOption('budget');await page.getByRole('checkbox',{name:'I reviewed this complete edited manifest and reason'}).check();
  const governance=page.waitForRequest(r=>r.url().endsWith('/v1/governance')&&r.method()==='POST');await page.getByRole('button',{name:'Submit reviewed change'}).click();
  expect((await governance).postDataJSON()).toEqual({agentId:'manager',kind:'budget',expectedVersion:3,reason:'New assignment',changes:{manifest:edited}});
});
test('rejects unchanged manifest and retains input after an unknown mutation outcome',async({page})=>{
  await page.getByRole('button',{name:/^Manager/}).click();await page.getByText('Review and propose a manifest change',{exact:true}).click();await page.getByLabel('Change reason').fill('No edit');await page.getByRole('checkbox',{name:'I reviewed this complete edited manifest and reason'}).check();await page.getByRole('button',{name:'Submit reviewed change'}).click();await expect(page.getByText('Edit the manifest before proposing a change.',{exact:false})).toBeVisible();
  const keys:string[]=[];await page.route('**/v1/tasks',async route=>{if(route.request().method()!=='POST')return route.fulfill({json:{data:[]}});keys.push(route.request().headers()['idempotency-key']);if(keys.length===1)return route.abort();return route.fulfill({json:{data:{id:'task'}}})});
  const form=page.locator('form').filter({has:page.getByRole('button',{name:'Create task',exact:true})});await form.getByPlaceholder('Agent ID',{exact:true}).fill('manager');await form.getByPlaceholder('Objective',{exact:true}).fill('Do work');await form.getByPlaceholder('Deliverable',{exact:true}).fill('Artifact');await form.getByRole('button').click();await expect(page.getByText('Failed to fetch',{exact:false})).toBeVisible();await expect(form.getByPlaceholder('Objective',{exact:true})).toHaveValue('Do work');await form.getByRole('button').click();await expect(form.getByPlaceholder('Objective',{exact:true})).toHaveValue('');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
});
test('maps multiple selected tools to explicit valid per-tool grants',async({page})=>{
  const form=page.locator('form').filter({has:page.getByRole('button',{name:'Create governed proposal'})});
  for(const [name,value] of Object.entries({role:'Writer',mission:'Write',teamId:'team',managerId:'operator',responsibilities:'Write',benefit:'Helpful',justification:'Need writing'}))await form.locator(`[name="${name}"]`).fill(value);
  await form.getByRole('button').click();await expect(page.getByText('Select at least one supported tool.',{exact:false})).toBeVisible();
  for(const tool of ['workspace-files','request_hire','send_message'])await form.locator(`[name="tools"][value="${tool}"]`).check();
  const request=page.waitForRequest(r=>r.url().endsWith('/v1/hiring-requests')&&r.method()==='POST');await form.getByRole('button').click();const body=(await request).postDataJSON();expect(body.tools).toEqual(['workspace-files','request_hire','send_message']);expect(body.grants).toEqual([
    {tool:'workspace-files',operations:['read','write','list'],resource:null,credentialRef:null},
    {tool:'request_hire',operations:['request'],resource:null,credentialRef:null},
    {tool:'send_message',operations:['send'],resource:null,credentialRef:null}
  ]);
});

test('retries an unresolved command after reload without persisting its content',async({page})=>{
  const keys:string[]=[];await page.route('**/v1/tasks',async route=>{if(route.request().method()!=='POST')return route.fulfill({json:{data:[]}});keys.push(route.request().headers()['idempotency-key']);if(keys.length===1)return route.abort();return route.fulfill({json:{data:{id:'task'}}})});
  const form=page.locator('form').filter({has:page.getByRole('button',{name:'Create task',exact:true})});
  const fill=async()=>{await form.getByPlaceholder('Agent ID',{exact:true}).fill('manager');await form.getByPlaceholder('Objective',{exact:true}).fill('Private objective');await form.getByPlaceholder('Deliverable',{exact:true}).fill('Private deliverable')};
  await fill();await form.getByRole('button').click();await expect(page.getByText('Failed to fetch',{exact:false})).toBeVisible();
  const stored=await page.evaluate(()=>Object.entries(sessionStorage));expect(stored).toHaveLength(1);expect(stored[0][0]).toMatch(/^agent-factory:pending:[a-f0-9]{64}$/);expect(stored[0][1]).toBe(keys[0]);expect(JSON.stringify(stored)).not.toContain('Private');
  await page.reload();await fill();await form.getByRole('button').click();await expect(form.getByPlaceholder('Objective',{exact:true})).toHaveValue('');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(await page.evaluate(()=>Object.keys(sessionStorage))).toHaveLength(0);
});
