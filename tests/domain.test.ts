import { describe, expect, test } from 'bun:test';
import { createSeedState } from './fixtures/enterprise';
import { runScenario } from './fixtures/scenarios';
import { DomainError, decidePlan, generatePlans, getImpact, ingestEvent, inspectDocument, replayQueue, resolveDocument, setLotDisposition, setTaskStatus } from '../src/domain/engine';
import { availableShipment } from '../src/domain/impact';
import type { Actor, EventInput, RecoveryPlan, State } from '../src/shared/types';

const analyst: Actor = { id: 'analyst-1', name: 'Analyst', email: 'a@test', role: 'analyst', orgId: 'focal' };
const manager: Actor = { ...analyst, id: 'manager-1', role: 'manager' };
const procurement: Actor = { ...analyst, id: 'procurement-1', role: 'procurement' };
const warehouse: Actor = { ...analyst, id: 'warehouse-1', role: 'warehouse' };
const partner: Actor = { ...analyst, id: 'partner-1', orgId: 'partner' };
const fresh = () => createSeedState(new Date('2026-10-30T06:00:00Z'));
const event = (state: State, id: string, type: EventInput['type'], entityId: string, payload: Record<string, unknown>, time = state.clock): EventInput => ({ id, type, entityId, payload, time, source: 'test' });
function rejects(fn: () => unknown, status: number) {
  try { fn(); throw new Error('Expected rejection'); } catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).status).toBe(status); }
}

describe('source reconciliation', () => {
  test('duplicate deliveries never add stock twice', () => {
    const s = fresh(); const shipment = s.shipments[0]!; const e = event(s, 'delivery-1', 'shipment_status', shipment.id, { status: 'delivered', quantity: 40 });
    ingestEvent(s, e, analyst); const after = s.lots.reduce((n, l) => n + l.quantity, 0);
    expect(ingestEvent(s, e, analyst).status).toBe('duplicate');
    expect(s.lots.reduce((n, l) => n + l.quantity, 0)).toBe(after);
  });
  test('different lifecycle counts are evidence, not conflicting physical stock', () => {
    const s = fresh(); const lot = s.lots[0]!; const initial = lot.quantity;
    expect(ingestEvent(s, event(s, 'dispatch', 'stock_count', lot.id, { quantity: 100, meaning: 'dispatched' }), analyst).status).toBe('accepted');
    expect(ingestEvent(s, event(s, 'collected', 'stock_count', lot.id, { quantity: 60, meaning: 'collected' }), analyst).status).toBe('accepted');
    expect(ingestEvent(s, event(s, 'received', 'stock_count', lot.id, { quantity: 40, meaning: 'received' }), analyst).status).toBe('accepted');
    expect(lot.quantity).toBe(initial); expect(lot.status).toBe('available');
  });
  test('same-time physical contradictions dispute stock and retain both claims', () => {
    const s = fresh(); const lot = s.lots[0]!;
    ingestEvent(s, event(s, 'count-a', 'stock_count', lot.id, { quantity: 35, meaning: 'on_hand' }), analyst);
    expect(ingestEvent(s, event(s, 'count-b', 'stock_count', lot.id, { quantity: 31, meaning: 'on_hand' }), analyst).status).toBe('conflict');
    expect(lot.status).toBe('disputed'); expect(s.events).toHaveLength(2);
  });
  test('invalid quantities and impossible delivered-to-transit transitions preserve evidence', () => {
    const s = fresh(); const sh = s.shipments[0]!;
    expect(ingestEvent(s, event(s, 'bad', 'stock_count', s.lots[0]!.id, { quantity: -1 }), analyst).status).toBe('invalid');
    ingestEvent(s, event(s, 'done', 'shipment_status', sh.id, { status: 'delivered', quantity: sh.quantity }), analyst);
    expect(ingestEvent(s, event(s, 'reverse', 'shipment_status', sh.id, { status: 'in_transit' }, new Date(Date.parse(s.clock) + 1000).toISOString()), analyst).status).toBe('invalid');
    expect(sh.status).toBe('delivered');
  });
  test('replayed older ETA cannot overwrite the newer accepted ETA', () => {
    const s = fresh(); const sh = s.shipments[0]!; const originalTime = s.clock; const newer = new Date(Date.parse(s.clock) + 7200000).toISOString(); const latestEta = new Date(Date.parse(s.clock) + 90000000).toISOString();
    ingestEvent(s, event(s, 'new', 'shipment_eta', sh.id, { eta: latestEta }, newer), analyst);
    s.integrationOutage = true;
    ingestEvent(s, event(s, 'old', 'shipment_eta', sh.id, { eta: sh.baselineEta }, originalTime), analyst);
    ingestEvent(s, event(s, 'new', 'shipment_eta', sh.id, { eta: latestEta }, newer), analyst);
    replayQueue(s, manager);
    expect(sh.eta).toBe(latestEta); expect(s.queue).toHaveLength(0);
    expect(s.events.some(e => e.id === 'old' && e.status === 'stale')).toBe(true);
    expect(s.events.some(e => e.status === 'duplicate')).toBe(true);
  });
  test('equivalent payload key order remains an idempotent duplicate', () => {
    const s = fresh(); const first = event(s, 'same-key', 'stock_count', s.lots[0]!.id, { quantity: 35, meaning: 'on_hand' });
    ingestEvent(s, first, analyst);
    expect(ingestEvent(s, { ...first, payload: { meaning: 'on_hand', quantity: 35 } }, analyst).status).toBe('duplicate');
    expect(s.lots[0]!.status).toBe('available');
  });
  test('valid cumulative partial receipts add only the newly received units', () => {
    const s = fresh(); const sh = s.shipments[0]!; const time = s.clock;
    ingestEvent(s, event(s, 'partial-40', 'shipment_status', sh.id, { status: 'delivered', quantity: 40 }, time), analyst);
    const lot = s.lots.find(l => l.id === sh.lotId)!; expect(lot.quantity).toBe(40); expect(sh.status).toBe('in_transit');
    ingestEvent(s, event(s, 'partial-60', 'shipment_status', sh.id, { status: 'delivered', quantity: 60 }, new Date(Date.parse(time) + 1000).toISOString()), analyst);
    expect(lot.quantity).toBe(60); expect(sh.status).toBe('in_transit');
  });
  test('cumulative receipts after expedited delivery accurately add stock and track available shipment', () => {
    // Case A: Expedite executed before receipts
    const s = fresh(); const sh = s.shipments[0]!;
    sh.quantity = 120; sh.status = 'in_transit'; sh.lotId = undefined;
    s.incidents.push({ id: 'inc-1', type: 'supplier_delay', entityId: 'supplier-core', title: 'Test Inc', description: 'test', status: 'active', createdAt: s.clock, memberOrgIds: ['focal'], affectedOrderIds: [s.orders[0]!.id], alertCount: 1 });
    const planA: RecoveryPlan = {
      id: 'plan-exp-a', incidentId: 'inc-1', orderId: s.orders[0]!.id,
      type: 'expedite', quantity: 70, sourceId: sh.id,
      arrivesAt: s.clock, costCents: 1000, feasible: true, reasons: [],
      status: 'proposed', createdBy: 'analyst-1', version: 1, rationale: 'test',
      riskLevel: 'routine',
      evidenceIds: [], inventoryVersion: s.version,
    };
    s.plans.push(planA);
    decidePlan(s, planA.id, { action: 'approve', confirmed: true }, manager);
    expect(planA.status).toBe('executed');
    expect(availableShipment(s, sh)).toBe(50);

    // First receipt: cumulative 80
    ingestEvent(s, event(s, 'rec-80', 'shipment_status', sh.id, { status: 'delivered', quantity: 80 }, s.clock), analyst);
    const lotA = s.lots.find(l => l.id === sh.lotId)!;
    expect(lotA.quantity).toBe(10);
    expect(availableShipment(s, sh)).toBe(40);

    // Second receipt: cumulative 120
    ingestEvent(s, event(s, 'rec-120', 'shipment_status', sh.id, { status: 'delivered', quantity: 120 }, new Date(Date.parse(s.clock) + 1000).toISOString()), analyst);
    expect(lotA.quantity).toBe(50);
    expect(availableShipment(s, sh)).toBe(0);

    // Case B: Physical receipt before expedite
    const s2 = fresh(); const sh2 = s2.shipments[0]!;
    sh2.quantity = 120; sh2.status = 'in_transit'; sh2.lotId = undefined;
    s2.incidents.push({ id: 'inc-2', type: 'supplier_delay', entityId: 'supplier-core', title: 'Test Inc 2', description: 'test', status: 'active', createdAt: s2.clock, memberOrgIds: ['focal'], affectedOrderIds: [s2.orders[0]!.id], alertCount: 1 });

    // Cumulative 30 received first
    ingestEvent(s2, event(s2, 'rec-30', 'shipment_status', sh2.id, { status: 'delivered', quantity: 30 }, s2.clock), analyst);
    const lotB = s2.lots.find(l => l.id === sh2.lotId)!;
    expect(lotB.quantity).toBe(30);
    expect(availableShipment(s2, sh2)).toBe(90);

    // Expedite 70 executed
    const planB: RecoveryPlan = {
      id: 'plan-exp-b', incidentId: 'inc-2', orderId: s2.orders[0]!.id,
      type: 'expedite', quantity: 70, sourceId: sh2.id,
      arrivesAt: s2.clock, costCents: 1000, feasible: true, reasons: [],
      status: 'proposed', createdBy: 'analyst-1', version: 1, rationale: 'test',
      riskLevel: 'routine',
      evidenceIds: [], inventoryVersion: s2.version,
    };
    s2.plans.push(planB);
    decidePlan(s2, planB.id, { action: 'approve', confirmed: true }, manager);
    expect(availableShipment(s2, sh2)).toBe(20);

    // Cumulative 120 received second
    ingestEvent(s2, event(s2, 'rec-120-b', 'shipment_status', sh2.id, { status: 'delivered', quantity: 120 }, new Date(Date.parse(s2.clock) + 2000).toISOString()), analyst);
    expect(lotB.quantity).toBe(50); // Total physical stock added is 50
    expect(availableShipment(s2, sh2)).toBe(0);
  });
  test('invalid shipment lot references return invalid event status without creating fallback lot', () => {
    const s = fresh(); const sh = s.shipments[0]!;
    sh.lotId = 'nonexistent-lot-id';
    const initialLotsCount = s.lots.length;
    const res = ingestEvent(s, event(s, 'deliv-unknown-lot', 'shipment_status', sh.id, { status: 'delivered', quantity: sh.quantity }), analyst);
    expect(res.status).toBe('invalid');
    expect(s.lots.length).toBe(initialLotsCount);
    expect(s.lots.find(l => l.id === `lot-received-${sh.id}`)).toBeUndefined();

    // Mismatched lot warehouse/item
    const otherLot = s.lots.find(l => l.warehouseId !== sh.warehouseId || l.itemId !== sh.itemId)!;
    sh.lotId = otherLot.id;
    const res2 = ingestEvent(s, event(s, 'deliv-mismatch-lot', 'shipment_status', sh.id, { status: 'delivered', quantity: sh.quantity }), analyst);
    expect(res2.status).toBe('invalid');
    expect(s.lots.length).toBe(initialLotsCount);
  });
  test('replayed older stock count cannot overwrite operational allocation or restore consumed stock', () => {
    const s = fresh();
    const lot = s.lots[0]!;
    lot.quantity = 50; lot.reserved = 0;
    const originalTime = s.clock;
    s.incidents.push({ id: 'inc-alloc', type: 'stock_conflict', entityId: lot.id, title: 'Stock Test Inc', description: 'test', status: 'active', createdAt: s.clock, memberOrgIds: ['focal'], affectedOrderIds: [s.orders[0]!.id], alertCount: 1 });

    // Advance clock and execute a plan consuming stock from this lot
    const laterTime = new Date(Date.parse(originalTime) + 3600_000).toISOString();
    s.clock = laterTime;
    const plan: RecoveryPlan = {
      id: 'plan-alloc-1', incidentId: 'inc-alloc', orderId: s.orders[0]!.id,
      type: 'reallocate', quantity: 20, sourceId: lot.id,
      arrivesAt: laterTime, costCents: 500, feasible: true, reasons: [],
      status: 'proposed', createdBy: 'analyst-1', version: 1, rationale: 'alloc test',
      riskLevel: 'routine',
      evidenceIds: [lot.id], inventoryVersion: s.version,
    };
    s.plans.push(plan);
    decidePlan(s, plan.id, { action: 'approve', confirmed: true }, manager);
    expect(lot.quantity).toBe(30);

    // Replay older stock count from originalTime (before allocation)
    const oldEvent = event(s, 'old-count', 'stock_count', lot.id, { quantity: 50, meaning: 'on_hand' }, originalTime);
    const result = ingestEvent(s, oldEvent, analyst);
    expect(result.status).toBe('stale');
    expect(result.message).toContain('Older effective-time evidence preserved');
    expect(lot.quantity).toBe(30);
  });
});

describe('impact and compound exposure', () => {
  test('shared upstream delay reaches both supplier paths with correlated alerts', () => {
    const s = fresh(); const upstream = s.suppliers.find(x => x.tier === 2)!;
    ingestEvent(s, event(s, 'delay-1', 'supplier_delay', upstream.id, { delayHours: 48 }), analyst);
    ingestEvent(s, event(s, 'delay-2', 'supplier_delay', upstream.id, { delayHours: 48 }), analyst);
    const impact = getImpact(s); expect(impact.length).toBeGreaterThanOrEqual(2);
    expect(s.incidents.filter(x => x.entityId === upstream.id)).toHaveLength(1);
    expect(impact.some(x => x.paths.some(p => p.includes(upstream.id)))).toBe(true);
    expect(impact[0]!.score).toBeGreaterThanOrEqual(impact[1]!.score);
  });
  test('scenario A exposes overlap once per order with supplier and outage explanations', () => {
    const s = fresh(); runScenario(s, 'A', analyst); const impacts = getImpact(s);
    expect(new Set(impacts.map(x => x.orderId)).size).toBe(impacts.length);
    expect(impacts.some(x => x.incidentIds.length >= 2)).toBe(true);
    expect(impacts.every(x => x.shortage <= s.orders.find(o => o.id === x.orderId)!.quantity)).toBe(true);
  });
  test('missing ETA history is insufficient evidence and volatile history is explained', () => {
    const s = fresh(); runScenario(s, 'A', analyst); s.shipments[0]!.etaHistory = [];
    const factors = getImpact(s).flatMap(x => x.factors).join(' ');
    expect(factors).toContain('insufficient ETA evidence'); expect(factors).toContain('volatile');
  });
});

describe('deterministic recovery and authorization', () => {
  test('all four options are generated with failed constraints and evidence', () => {
    const s = fresh(); runScenario(s, 'A', analyst); const plans = generatePlans(s, s.incidents[0]!.id, analyst);
    expect(new Set(plans.map(p => p.type)).size).toBe(4);
    expect(plans.some(p => !p.feasible && p.reasons.length > 0)).toBe(true);
    expect(plans.every(p => p.evidenceIds.length > 0 && Number.isInteger(p.costCents))).toBe(true);
  });
  test('confirmation, separation of duties and supplier role guard leave stock unchanged', () => {
    const s = fresh(); runScenario(s, 'A', analyst); const plans = generatePlans(s, s.incidents[0]!.id, analyst); const p = plans.find(x => x.type === 'alternative_supplier' && x.feasible)!;
    expect(p).toBeDefined(); const before = JSON.stringify(s);
    rejects(() => decidePlan(s, p.id, { action: 'approve' }, procurement), 400); expect(JSON.stringify(s)).toBe(before);
    rejects(() => decidePlan(s, p.id, { action: 'approve', confirmed: true }, analyst), 403);
    rejects(() => decidePlan(s, p.id, { action: 'approve', confirmed: true }, manager), 403);
    rejects(() => generatePlans(s, s.incidents[0]!.id, partner), 403);
  });
  test('modifying a plan preserves prior version in audit and rejects bad quantities', () => {
    const s = fresh(); runScenario(s, 'A', analyst); const p = generatePlans(s, s.incidents[0]!.id, analyst).find(x => x.type === 'alternative_supplier')!;
    rejects(() => decidePlan(s, p.id, { action: 'modify', quantity: -1 }, analyst), 400);
    const v = p.version; decidePlan(s, p.id, { action: 'modify', quantity: 25 }, analyst);
    expect(p.version).toBe(v + 1); expect(p.status).toBe('proposed'); expect(p.approver).toBeUndefined();
    expect(s.decisions.some(d => d.action === 'plan_modified' && (d.before as { version: number }).version === v)).toBe(true);
  });
  test('competing plans revalidate finite stock before execution', () => {
    const s = fresh(); ingestEvent(s, event(s, 'late', 'supplier_delay', s.suppliers.find(x => x.tier === 2)!.id, { delayHours: 48 }), analyst);
    const plans = generatePlans(s, s.incidents[0]!.id, analyst); const p = plans.find(x => x.type === 'reallocate' && x.feasible)!;
    expect(p).toBeDefined(); const competitor = structuredClone(p); competitor.id = 'competing-plan'; s.plans.push(competitor);
    const source = s.lots.find(x => x.id === p.sourceId)!; const starting = source.quantity;
    decidePlan(s, p.id, { action: 'approve', confirmed: true }, manager);
    expect(p.status).toBe('awaiting_second_approval');
    const admin: Actor = { ...analyst, id: 'admin-1', role: 'admin' };
    decidePlan(s, p.id, { action: 'approve', confirmed: true }, admin);
    expect(p.status).toBe('executed'); expect(source.quantity).toBe(starting - p.quantity);
    rejects(() => decidePlan(s, competitor.id, { action: 'approve', confirmed: true }, manager), 409);
    expect(source.quantity).toBeGreaterThanOrEqual(source.reserved);
  });
  test('held and disputed stock are excluded and only warehouse/admin can dispose', () => {
    const s = fresh(); runScenario(s, 'B', analyst); const lot = s.lots.find(l => l.status === 'held')!; expect(lot).toBeDefined();
    rejects(() => setLotDisposition(s, lot.id, 'available', analyst), 403);
    setLotDisposition(s, lot.id, 'available', warehouse); expect(lot.status).toBe('available');
    lot.status = 'disputed'; rejects(() => setLotDisposition(s, lot.id, 'available', warehouse), 409);
  });
  test('administrator cannot approve their own proposal', () => {
    const s = fresh(); const admin: Actor = { ...analyst, id: 'admin-1', role: 'admin' }; runScenario(s, 'A', admin);
    const plan = generatePlans(s, s.incidents[0]!.id, admin).find(p => p.feasible)!;
    rejects(() => decidePlan(s, plan.id, { action: 'approve', confirmed: true }, admin), 403);
  });
  test('modifier cannot self-approve a revised plan', () => {
    const s = fresh(); runScenario(s, 'A', analyst);
    const plan = generatePlans(s, s.incidents[0]!.id, analyst).find(p => p.feasible && p.type !== 'alternative_supplier')!;
    expect(plan.createdBy).toBe(analyst.id);

    // Manager modifies the plan
    decidePlan(s, plan.id, { action: 'modify', quantity: Math.max(1, plan.quantity - 1) }, manager);
    expect(plan.lastModifiedBy).toBe(manager.id);

    // Manager cannot self-approve their own modification
    rejects(() => decidePlan(s, plan.id, { action: 'approve', confirmed: true }, manager), 403);

    // Administrator (different actor who did not modify) provides first approval
    const adminActor: Actor = { ...analyst, id: 'admin-actor', role: 'admin' };
    decidePlan(s, plan.id, { action: 'approve', confirmed: true }, adminActor);
    expect(plan.status).toBe('awaiting_second_approval');

    // Second independent manager provides second approval
    const manager2: Actor = { ...analyst, id: 'manager-2', role: 'manager' };
    decidePlan(s, plan.id, { action: 'approve', confirmed: true }, manager2);
    expect(plan.status).toBe('executed');
  });
  test('condition reading events are rejected as unsupported', () => {
    const s = fresh(); const lot = s.lots[0]!;
    const result = ingestEvent(s, event(s, 'unknown-policy', 'condition_reading' as any, lot.id, { temperature: 37, durationMinutes: 25 }), analyst);
    expect(result.status).toBe('invalid');
  });
});

describe('document review and collaboration', () => {
  test('document mismatch remains a claim until explicit authorized confirmation', () => {
    const s = fresh(); const sh = s.shipments[0]!; const quantity = sh.quantity;
    const doc = inspectDocument(s, 'manifest.txt', `Shipment: ${sh.id}\nQuantity: ${quantity + 7}\nDate: 2026-10-30`, analyst);
    expect(doc.status).toBe('mismatch'); expect(sh.quantity).toBe(quantity);
    rejects(() => resolveDocument(s, doc.id, partner), 403);
    resolveDocument(s, doc.id, warehouse); expect(doc.status).toBe('confirmed'); expect(sh.quantity).toBe(quantity);
    expect(doc.issues.length).toBeGreaterThan(0);
  });
  test('scanned/empty text needs review and never invents extraction certainty', () => {
    const s = fresh(); const doc = inspectDocument(s, 'scan.pdf', '', analyst); expect(doc.status).toBe('review'); expect(doc.confidence).toBe(0);
  });
  test('partners may complete only their owned incident-scoped tasks', () => {
    const s = fresh(); runScenario(s, 'A', analyst); const task = s.tasks.find(t => t.ownerId === partner.id)!;
    setTaskStatus(s, task.id, 'done', partner); expect(task.status).toBe('done');
    rejects(() => setTaskStatus(s, s.tasks.find(t => t.orgId === 'focal')!.id, 'done', partner), 403);
  });
});
