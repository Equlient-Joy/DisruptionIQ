import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { parseSimulationDataset } from '../src/domain/simulation-dataset';
import { attachSimulation, advanceSimulationDay, controlSimulation } from '../src/domain/simulation';
import { ingestEvent, generatePlans, decidePlan } from '../src/domain/engine';
import { feedFixture } from './fixtures/feed';
import type { Actor, State } from '../src/shared/types';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const admin: Actor = { id: 'admin-1', name: 'Admin', email: 'admin@test.local', role: 'admin', orgId: 'focal' };
const analyst: Actor = { ...admin, id: 'analyst-1', role: 'analyst' };
const manager: Actor = { ...admin, id: 'manager-1', role: 'manager' };
const deliveredAt = '2026-11-01T12:00:00Z';
function attach(state: State, days = 2) { return attachSimulation(state, admin, parseSimulationDataset(JSON.stringify(feedFixture(days)))); }
function advance(state: State, index = state.simulation!.completedDays, requestId = `request-${index}`) {
  return advanceSimulationDay(state, admin, { datasetHash: state.simulation!.datasetHash, expectedDayIndex: index, requestId }, deliveredAt);
}
describe('day simulation controller', () => {
  let repo: Repository;
  beforeEach(async () => { repo = new Repository(); await repo.init(); }, 30000);
  afterEach(async () => { await repo.close(); });
  test('attachment changes neither catalog nor clock and refuses a replacement', async () => {
    const before = await repo.read();
    await repo.mutate(s => attach(s));
    const staged = await repo.read();
    expect(staged.lots).toHaveLength(0); expect(staged.clock).toBe(before.clock);
    await repo.mutate(s => attach(s));
    expect((await repo.read()).decisions).toHaveLength(1);
    await expect(repo.mutate(s => attach(s, 3))).rejects.toThrow('already attached');
    expect(JSON.stringify(staged.decisions)).not.toContain('shipment-atlas');
  });
  test('historical day 1 and no-event next day anchor explicitly and finish at day end', async () => {
    await repo.mutate(s => { s.clock = '2027-01-01T00:00:00Z'; attach(s); });
    await repo.mutate(s => advance(s));
    const first = await repo.read();
    expect(first.clock).toBe('2026-11-01T23:59:59.999Z'); expect(first.simulation!.completedDays).toBe(1);
    expect(first.suppliers.length).toBeGreaterThan(0);
    await repo.mutate(s => advance(s));
    const last = await repo.read();
    expect(last.clock).toBe('2026-11-02T23:59:59.999Z'); expect(last.simulation!.status).toBe('complete');
    await expect(repo.mutate(s => advance(s))).rejects.toThrow('complete');
  });
  test('pause blocks advance, resume changes no data or clock, and lost response retry returns saved receipt', async () => {
    await repo.mutate(s => attach(s));
    const first = await repo.mutate(s => advance(s));
    await repo.mutate(s => controlSimulation(s, admin, { datasetHash: s.simulation!.datasetHash, action: 'pause' }));
    await expect(repo.mutate(s => advance(s))).rejects.toThrow('paused');
    const before = await repo.read();
    const retry = await repo.mutate(s => advance(s, 0));
    expect(retry.newlyCommitted).toBe(false); expect(retry.receipt).toEqual(first.receipt);
    const after = await repo.read(); expect(after.events).toEqual(before.events); expect(after.decisions).toEqual(before.decisions);
    await expect(repo.mutate(s => advance(s, 1, 'request-0'))).rejects.toThrow('reused');
    await repo.mutate(s => controlSimulation(s, admin, { datasetHash: s.simulation!.datasetHash, action: 'resume' }));
    expect((await repo.read()).clock).toBe(before.clock); expect((await repo.read()).simulation!.completedDays).toBe(1);
  });
  test('two tabs at the same cursor commit one day', async () => {
    await repo.mutate(s => attach(s));
    const outcomes = await Promise.allSettled([repo.mutate(s => advance(s, 0, 'tab-a')), repo.mutate(s => advance(s, 0, 'tab-b'))]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.read()).simulation!.completedDays).toBe(1);
  });
  test('pause and advance serialize at the workspace lock', async () => {
    await repo.mutate(s => attach(s));
    const pause = () => repo.mutate(s => controlSimulation(s, admin, {datasetHash: s.simulation!.datasetHash, action: 'pause'}));
    const results = await Promise.allSettled([pause(), repo.mutate(s => advance(s))]);
    expect(results[1]!.status).toBe('rejected'); expect((await repo.read()).simulation!.completedDays).toBe(0);
    await repo.mutate(s => controlSimulation(s, admin, {datasetHash: s.simulation!.datasetHash, action: 'resume'}));
    await Promise.all([repo.mutate(s => advance(s)), pause()]);
    expect((await repo.read()).simulation!.completedDays).toBe(1); expect((await repo.read()).simulation!.status).toBe('paused');
  });
  test('catalog error rolls back the entire day when another import uses a future ID', async () => {
    const source = feedFixture(); source.days[1]!.catalog.warehouses.push({id: 'next-hub', name: 'Next', region: 'East', capacity: 100, status: 'online'});
    await repo.mutate(s => attachSimulation(s, admin, parseSimulationDataset(JSON.stringify(source))));
    await repo.mutate(s => advance(s));
    await repo.mutate(s => s.warehouses.push({id: 'next-hub', name: 'Manual', region: 'East', capacity: 200, status: 'online'}));
    const before = await repo.read();
    await expect(repo.mutate(s => advance(s))).rejects.toThrow('Existing IDs');
    expect(await repo.read()).toEqual(before);
  });
  test('public ingestion cannot cross the day boundary and anomalies remain evidence', async () => {
    await repo.mutate(s => attach(s));
    const early = await repo.mutate(s => ingestEvent(s, {id:'early',source:'manual',type:'stock_count',entityId:'absent',time:'2026-11-01T10:00:00Z',payload:{}},admin));
    expect(early.status).toBe('invalid'); expect(early.message).toContain('Start day 1');
    await repo.mutate(s => { s.events=[]; s.queue=[]; advance(s); });
    const future = await repo.mutate(s => ingestEvent(s, {id:'future',source:'manual',type:'shipment_eta',entityId:s.shipments[0]!.id,time:'2026-11-03T00:00:00Z',payload:{eta:'2026-11-04T00:00:00Z'}},admin));
    expect(future.status).toBe('invalid'); expect((await repo.read()).clock).toBe('2026-11-01T23:59:59.999Z');
  });
  test('a day retains semantic results and maps document source IDs', async () => {
    const source = feedFixture(); const first = source.days[0]!;
    const event = { id:'delay',source:'supplier',type:'supplier_delay',entityId:first.catalog.suppliers[0]!.id,time:'2026-11-01T10:00:00Z',payload:{delayHours:24} };
    first.events.push(event,event,{...event,id:'bad',payload:{delayHours:-1}});
    first.documents.push({id:'claim',filename:'manifest.txt',text:`Shipment: ${first.catalog.shipments[0]!.id}\nQuantity: 999\nDate: 2026-11-01`});
    await repo.mutate(s => attachSimulation(s, admin, parseSimulationDataset(JSON.stringify(source))));
    const result = await repo.mutate(s => advance(s));
    expect(result.receipt.eventCounts).toMatchObject({accepted:1,duplicate:1,invalid:1});
    expect(result.receipt.documents[0]!.sourceId).toBe('claim');
    expect((await repo.read()).documents[0]!.status).toBe('mismatch');
  });
  test('next day retains a confirmed recovery and its approvals', async () => {
    const source = feedFixture(); source.days[0]!.events.push({id:'delay',source:'supplier',type:'supplier_delay',entityId:source.days[0]!.catalog.suppliers[0]!.id,time:'2026-11-01T10:00:00Z',payload:{delayHours:48}});
    source.days[0]!.catalog.orders.forEach(order => { order.deadline = '2026-11-04T00:00:00Z'; });
    source.days[0]!.events[0]!.payload.delayHours = 96;
    await repo.mutate(s => attachSimulation(s,admin,parseSimulationDataset(JSON.stringify(source))));
    await repo.mutate(s => advance(s));
    const plan = await repo.mutate(s => generatePlans(s,s.incidents[0]!.id,analyst).find(p => p.feasible && p.type==='reallocate')!);
    expect(plan).toBeDefined();
    await repo.mutate(s => decidePlan(s,plan.id,{action:'approve',confirmed:true},manager));
    if ((await repo.read()).plans.find(p=>p.id===plan.id)!.status==='awaiting_second_approval') await repo.mutate(s=>decidePlan(s,plan.id,{action:'approve',confirmed:true},admin));
    const recovered=await repo.read();
    await repo.mutate(s=>advance(s)); const after=await repo.read();
    expect(after.lots).toEqual(recovered.lots); expect(after.plans).toEqual(recovered.plans);
    expect(after.simulation!.receipts[1]!.before.executedPlans).toBe(1);
  });
  test('progress and receipts survive a disk restart', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.cache', 'test-simulation-'));
    let disk = new Repository({pglitePath:dir});
    try {
      await disk.init(); await disk.mutate(s=>attach(s)); const receipt=await disk.mutate(s=>advance(s));
      await disk.close(); disk=new Repository({pglitePath:dir}); await disk.init();
      const retry=await disk.mutate(s=>advance(s,0)); expect(retry.receipt).toEqual(receipt.receipt); expect(retry.newlyCommitted).toBe(false);
    } finally { await disk.close(); await rm(dir,{recursive:true,force:true}); }
  },30000);
});
