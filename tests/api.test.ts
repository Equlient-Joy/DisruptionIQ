import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import { buildScenarioAState } from './fixtures/demo-scenarios';
process.env.DEMO_MODE = 'true';

describe('authenticated incident and recovery API', () => {
  const repo = new Repository(); const app = createApp(repo);
  let analyst = '', manager = '', partner = '', admin = '', procurement = '';
  async function login(email: string) {
    const r = await app.request('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'disruption-demo'})});
    expect(r.status).toBe(200); return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  function post(path:string,body:unknown,cookie=analyst) {
    return app.request(path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(body)});
  }
  beforeAll(async () => {
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildScenarioAState()));
    analyst=await login('analyst@disruptioniq.demo'); manager=await login('manager@disruptioniq.demo');
    partner=await login('partner@disruptioniq.demo'); admin=await login('admin@disruptioniq.demo');
    procurement=await login('procurement@disruptioniq.demo');
  },30000);
  afterAll(async () => { await repo.close(); });
  test('dashboard rejects unauthenticated access and incorrect passwords', async () => {
    expect((await app.request('/api/dashboard')).status).toBe(401);
    expect((await post('/api/login',{email:'admin@disruptioniq.demo',password:'wrong'},'')).status).toBe(401);
  });
  test('integration outage state survives reads and only carrier controls its legacy flag', async () => {
    const before = await repo.read();
    try {
      expect((await post('/api/outage', { enabled: true }, manager)).status).toBe(200);
      expect((await repo.read()).integrationOutage).toBe(true);
      expect((await post('/api/outage', { enabled: false, integrationId: 'warehouse' }, manager)).status).toBe(200);
      expect((await repo.read()).integrationOutage).toBe(true);
      const paused = await repo.read();
      expect((await post('/api/outage', { enabled: false, integrationId: 'missing' }, manager)).status).toBe(404);
      expect(await repo.read()).toEqual(paused);
    } finally {
      await repo.mutate(s => Object.assign(s, before));
    }
  });
  test('analyst cannot reset and untrusted webhook is rejected', async () => {
    expect((await post('/api/reset',{})).status).toBe(403);
    expect((await post('/api/webhooks/carrier',{})).status).toBe(401);
  });
  test('scenario impact, confirmed recovery and audit are linked', async () => {
    const state=await repo.read();
    const incident=state.incidents[0]!;
    expect((await post('/api/plans/generate',{incidentId:incident.id})).status).toBe(200);
    const p=(await repo.read()).plans.find(p=>p.feasible && p.type==='expedite') || (await repo.read()).plans.find(p=>p.feasible && p.type==='reallocate');
    expect(p).toBeDefined();
    expect((await post(`/api/plans/${p!.id}`,{action:'approve',confirmed:true})).status).toBe(403);
    expect((await post(`/api/plans/${p!.id}`,{action:'approve'},manager)).status).toBe(400);
    expect((await post(`/api/plans/${p!.id}`,{action:'approve',confirmed:true},manager)).status).toBe(200);
    const mid=await repo.read(); expect(mid.plans.find(x=>x.id===p!.id)?.status).toBe('awaiting_second_approval');
    expect((await post(`/api/plans/${p!.id}`,{action:'approve',confirmed:true},admin)).status).toBe(200);
    const after=await repo.read(); expect(after.plans.find(x=>x.id===p!.id)?.status).toBe('executed');
    expect(after.decisions.some(d=>d.entityId===p!.id && d.before && d.after)).toBe(true);
  });
  test('partner view exposes scoped incident but no internal stock, orders or audit', async () => {
    const response=await app.request('/api/dashboard',{headers:{cookie:partner}});
    expect(response.status).toBe(200); const data=await response.json();
    expect(data.state.orders).toHaveLength(0); expect(data.state.lots).toHaveLength(0);
    expect(data.state.decisions).toHaveLength(0); expect(data.state.plans).toHaveLength(0);
    expect(data.state.incidents.every((i:any)=>i.memberOrgIds.includes('partner'))).toBe(true);
    expect((await post('/api/import',{},partner)).status).toBe(403);
  });
  test('imports return row errors instead of replacing good data', async () => {
    const before=await repo.read();
    const response=await post('/api/import',{format:'csv',entity:'lots',content:'id,itemId,name,warehouseId,quantity,reserved,status,version\nBAD,item,Test,unknown,-1,0,available,1'});
    expect(response.status).toBe(200); const data=await response.json(); expect(data.errors.length).toBeGreaterThan(0);
    expect((await repo.read()).lots.length).toBe(before.lots.length);
  });
  test('cross-origin state changes are rejected even with a valid session', async () => {
    const r=await app.request('/api/reset',{method:'POST',headers:{cookie:admin,origin:'https://untrusted.example','content-type':'application/json'},body:'{}'});
    expect(r.status).toBe(403);
  });
  test('procurement can submit documents and shipment imports validate lot references', async () => {
    // Test procurement submitting document
    const docRes = await post('/api/documents', { filename: 'po.txt', text: 'Shipment: shipment-1\nQuantity: 50\nDate: 2026-10-30' }, procurement);
    expect(docRes.status).toBe(202);

    // Test shipment imports validation of lotId: unknown lot
    const importUnknown = await post('/api/import', {
      format: 'csv',
      entity: 'shipments',
      content: 'id,supplierId,warehouseId,itemId,quantity,status,eta,baselineEta,etaHistory,lotId\nSH-BAD-1,supplier-core,warehouse-west,controller,10,scheduled,2026-11-01T00:00:00Z,2026-11-01T00:00:00Z,[],unknown-lot-xyz',
    }, admin);
    expect(importUnknown.status).toBe(200);
    const dataUnknown = await importUnknown.json();
    expect(dataUnknown.errors.some((e: any) => e.message.includes('Unknown lot unknown-lot-xyz'))).toBe(true);

    // Test shipment imports validation of lotId: mismatched item or warehouse
    const existingLot = (await repo.read()).lots.find(l => l.warehouseId !== 'warehouse-west' || l.itemId !== 'controller')!;
    const importMismatch = await post('/api/import', {
      format: 'csv',
      entity: 'shipments',
      content: `id,supplierId,warehouseId,itemId,quantity,status,eta,baselineEta,etaHistory,lotId\nSH-BAD-2,supplier-core,warehouse-west,controller,10,scheduled,2026-11-01T00:00:00Z,2026-11-01T00:00:00Z,[],${existingLot.id}`,
    }, admin);
    expect(importMismatch.status).toBe(200);
    const dataMismatch = await importMismatch.json();
    expect(dataMismatch.errors.some((e: any) => e.message.includes('item or warehouse does not match shipment'))).toBe(true);
  });
  test('demo reset preserves audit history and records reset decision with prior details', async () => {
    // Ensure there is at least one decision
    const beforeReset = await repo.read();
    expect(beforeReset.decisions.length).toBeGreaterThan(0);
    const priorCount = beforeReset.decisions.length;

    // Reset via API
    const resetRes = await post('/api/reset', {}, admin);
    expect(resetRes.status).toBe(200);

    const afterReset = await repo.read();
    // Audit history must not be vaporized!
    expect(afterReset.decisions.length).toBe(priorCount + 1);
    const resetDecision = afterReset.decisions[afterReset.decisions.length - 1]!;
    expect(resetDecision.action).toBe('demo_reset');
    expect(resetDecision.detail).toContain('Prior version');
    // Operational collections are cleared to empty
    expect(afterReset.orders).toHaveLength(0);
    expect(afterReset.shipments).toHaveLength(0);
    expect(afterReset.lots).toHaveLength(0);
  });
});
