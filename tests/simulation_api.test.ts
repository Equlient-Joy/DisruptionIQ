import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import { feedFixture } from './fixtures/feed';
process.env.DEMO_MODE = 'true';
process.env.AI_FEATURES_ENABLED = 'false';

describe('simulation API', () => {
  let repo: Repository;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  async function login(role: string) {
    const r=await app.request('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`${role}@disruptioniq.demo`,password:'disruption-demo'})});
    expect(r.status).toBe(200); return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  function post(path: string, body: unknown, cookie = admin) {
    return app.request(path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  }
  async function attach() {
    const data=feedFixture(); data.days[1]!.catalog.warehouses.push({id:'future-secret',name:'UNDELIVERED-SECRET',region:'East',capacity:200,status:'online'});
    const response=await post('/api/simulation/dataset',{content:JSON.stringify(data)});
    expect(response.status).toBe(200); return (await response.json()).simulation.datasetHash as string;
  }
  beforeEach(async()=>{repo=new Repository();await repo.init();app=createApp(repo);admin=await login('admin');},30000);
  afterEach(async()=>{await repo.close();});
  test('routes enforce roles and never expose future source records', async()=>{
    expect((await app.request('/api/simulation')).status).toBe(401);
    const analyst=await login('analyst'); const partner=await login('partner');
    expect((await post('/api/simulation/dataset',{content:JSON.stringify(feedFixture())},analyst)).status).toBe(403);
    const hash=await attach();
    expect((await app.request('/api/simulation',{headers:{cookie:analyst}})).status).toBe(200);
    expect((await app.request('/api/simulation',{headers:{cookie:partner}})).status).toBe(403);
    for(const cookie of [admin,partner]) {
      const response=await app.request('/api/dashboard',{headers:{cookie}});const text=await response.text();
      expect(text).not.toContain('UNDELIVERED-SECRET'); expect(text).not.toContain('simulationDataset');
      if(cookie===partner) expect(text).not.toContain(hash);
    }
    expect((await repo.read()).warehouses).toHaveLength(0);
  });
  test('manager/admin can advance and other roles can only read progress', async()=>{
    const hash=await attach();const manager=await login('manager');
    for(const role of ['analyst','warehouse','procurement']) {
      const cookie=await login(role);
      expect((await app.request('/api/simulation',{headers:{cookie}})).status).toBe(200);
      expect((await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:role},cookie)).status).toBe(403);
    }
    expect((await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:'first'},manager)).status).toBe(200);
    expect((await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:'other'})).status).toBe(409);
    const retry=await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:'first'});
    expect((await retry.json()).newlyCommitted).toBe(false);
  });
  test('validates input, rejects replacement and preserves pause', async()=>{
    expect((await post('/api/simulation/dataset',{content:'bad JSON'})).status).toBe(400);
    expect((await post('/api/simulation/dataset',{content:' '.repeat(2*1024*1024+1)})).status).toBe(413);
    const hash=await attach();
    expect((await post('/api/simulation/dataset',{content:JSON.stringify(feedFixture(3))})).status).toBe(409);
    expect((await post('/api/simulation/control',{datasetHash:hash,action:'pause'})).status).toBe(200);
    expect((await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:'paused'})).status).toBe(409);
    expect((await repo.read()).simulation!.completedDays).toBe(0);
  });
  test('pre-day-1 guards imports/documents and all event routes respect the boundary', async()=>{
    const hash=await attach();
    expect((await post('/api/import',{entity:'warehouses',format:'json',content:'[]'})).status).toBe(409);
    expect((await post('/api/documents',{filename:'text.txt',text:'hello'})).status).toBe(409);
    const input={id:'future',source:'manual',type:'shipment_eta',entityId:'shipment-atlas',time:'2026-11-03T00:00:00Z',payload:{eta:'2026-11-04T00:00:00Z'}};
    expect((await post('/api/events',input)).status).toBe(409);
    expect((await repo.read()).events).toHaveLength(0);
    await post('/api/simulation/advance',{datasetHash:hash,expectedDayIndex:0,requestId:'first'});
    expect((await (await post('/api/events',input)).json()).status).toBe('invalid');
    const imported=await (await post('/api/import',{entity:'events',format:'json',content:JSON.stringify([{...input,id:'import-future'}])})).json();
    expect(imported.accepted).toBe(0);
    const webhook=await app.request('/api/webhooks/carrier',{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':'local-carrier-demo'},body:JSON.stringify({...input,id:'webhook-future'})});
    expect((await webhook.json()).status).toBe('invalid');
    await repo.mutate(s=>s.queue.push({...input,id:'queued-future'}));
    expect((await (await post('/api/replay',{})).json()).events[0].status).toBe('invalid');
    expect((await repo.read()).clock).toBe('2026-11-01T23:59:59.999Z');
    expect((await post('/api/import',{entity:'warehouses',format:'json',content:JSON.stringify({id:'manual',name:'Manual',region:'East',capacity:10,status:'online'})})).status).toBe(200);
  });
  test('post-commit triage happens once and reset preserves receipt audit and removes feed', async()=>{
    const data=feedFixture();data.days[0]!.events.push({id:'delay',source:'supplier',type:'supplier_delay',entityId:data.days[0]!.catalog.suppliers[0]!.id,time:'2026-11-01T12:00:00Z',payload:{delayHours:24}});
    await post('/api/simulation/dataset',{content:JSON.stringify(data)});
    let publications=0;repo.agentBus.subscribe('disruption:ingested',()=>{publications++;});
    const command={datasetHash:(await repo.read()).simulation!.datasetHash,expectedDayIndex:0,requestId:'first'};
    await post('/api/simulation/advance',command);await repo.agentBus.waitForIdle();
    await post('/api/simulation/advance',command);await repo.agentBus.waitForIdle();
    expect(publications).toBe(1);
    await post('/api/reset',{});
    const reset=await repo.read();expect(reset.simulation).toBeUndefined();expect(reset.simulationDataset).toBeUndefined();
    expect(reset.workspaceGeneration).toBe(2); expect(JSON.stringify(reset.decisions.at(-1)?.before)).toContain('first');
  });
  test('an old document job cannot repopulate a reset workspace', async()=>{
    const uploaded=await (await post('/api/documents?sync=true',{filename:'old.txt',text:'Shipment: old\nQuantity: 12\nDate: 2026-11-01'})).json();
    expect(uploaded.id).toBeDefined();
    await post('/api/reset',{});await attach();
    const before=await repo.read();
    await repo.processDocument(uploaded.id,uploaded.jobId,1);
    const after=await repo.read();
    expect(after.documents).toEqual(before.documents);expect(after.notifications).toEqual(before.notifications);
  });
});
