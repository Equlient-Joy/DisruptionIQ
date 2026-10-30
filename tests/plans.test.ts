import { describe, expect, test } from 'bun:test';
import { createSeedState } from '../src/domain/seed';
import { decidePlan, generatePlans } from '../src/domain/plans';
import { DomainError } from '../src/domain/common';
import type { Actor, RecoveryPlan, State } from '../src/shared/types';

const analyst: Actor = { id: 'analyst-1', name: 'Analyst', email: 'a@test', role: 'analyst', orgId: 'focal' };
const manager: Actor = { id: 'manager-1', name: 'Manager 1', email: 'm1@test', role: 'manager', orgId: 'focal' };
const manager2: Actor = { id: 'manager-2', name: 'Manager 2', email: 'm2@test', role: 'manager', orgId: 'focal' };
const admin: Actor = { id: 'admin-1', name: 'Admin', email: 'adm@test', role: 'admin', orgId: 'focal' };
const procurement: Actor = { id: 'procurement-1', name: 'Procurement', email: 'p@test', role: 'procurement', orgId: 'focal' };
const partner: Actor = { id: 'partner-1', name: 'Partner', email: 'part@test', role: 'viewer', orgId: 'partner' };

function rejects(fn: () => unknown, status: number) {
  try {
    fn();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
  }
}

function seedWithIncident(): State {
  const s = createSeedState(new Date('2026-10-30T06:00:00Z'));
  s.incidents.push({
    id: 'inc-1',
    type: 'supplier_delay',
    entityId: 'supplier-core',
    title: 'Test Incident',
    description: 'Test incident description',
    status: 'active',
    createdAt: s.clock,
    memberOrgIds: ['focal'],
    affectedOrderIds: [s.orders[0]!.id],
    alertCount: 1,
  });
  return s;
}

describe('risk-tiered approvals and break-glass execution', () => {
  test('routine self-approval succeeds for authorized manager but rejects unauthorized analyst', () => {
    const s = seedWithIncident();
    const order = s.orders[0]!;
    const lot = s.lots[0]!;
    // Set low penalty and small quantity so it is routine
    order.penaltyCents = 50_000;
    const routinePlan: RecoveryPlan = {
      id: 'plan-routine-1',
      incidentId: 'inc-1',
      orderId: order.id,
      type: 'reallocate',
      quantity: 5, // small: < 50% of lot
      sourceId: lot.id,
      arrivesAt: s.clock,
      costCents: 10_000,
      feasible: true,
      reasons: [],
      status: 'proposed',
      createdBy: manager.id, // proposed by manager
      version: 1,
      rationale: 'Test rationale',
      evidenceIds: [],
      inventoryVersion: s.version,
    };
    s.plans.push(routinePlan);

    // Analyst attempts self-approval or approval: rejected (403)
    const analystPlan = { ...routinePlan, id: 'plan-analyst-1', createdBy: analyst.id };
    s.plans.push(analystPlan);
    rejects(() => decidePlan(s, analystPlan.id, { action: 'approve', confirmed: true }, analyst), 403);

    // Manager self-approves routine action: succeeds alone
    const initialLotQty = lot.quantity;
    const initialFulfilled = order.fulfilled;
    const approved = decidePlan(s, routinePlan.id, { action: 'approve', confirmed: true }, manager);
    expect(approved.status).toBe('executed');
    expect(approved.approver).toBe(manager.id);
    expect(approved.approvals).toHaveLength(1);
    expect(approved.approvals![0].approverId).toBe(manager.id);
    expect(lot.quantity).toBe(initialLotQty - 5);
    expect(order.fulfilled).toBe(initialFulfilled + 5);
  });

  test('first high-risk approval changes NO inventory, order, warehouse, or supplier state', () => {
    const s = seedWithIncident();
    const order = s.orders[0]!;
    const lot = s.lots[0]!;
    order.penaltyCents = 750_000; // high penalty -> high risk

    const highRiskPlan: RecoveryPlan = {
      id: 'plan-hr-1',
      incidentId: 'inc-1',
      orderId: order.id,
      type: 'reallocate',
      quantity: 15,
      sourceId: lot.id,
      arrivesAt: s.clock,
      costCents: 50_000,
      feasible: true,
      reasons: [],
      status: 'proposed',
      createdBy: analyst.id,
      version: 1,
      rationale: 'Test rationale',
      evidenceIds: [],
      inventoryVersion: s.version,
    };
    s.plans.push(highRiskPlan);

    const snapshotBefore = {
      lotQty: lot.quantity,
      orderFulfilled: order.fulfilled,
      warehouseCap: s.warehouses.find(w => w.id === order.warehouseId)!.capacity,
    };

    // First approval by manager
    const result = decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager);
    expect(result.status).toBe('awaiting_second_approval');
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals![0].approverId).toBe(manager.id);

    // Absolutely zero inventory/order/warehouse changes
    expect(lot.quantity).toBe(snapshotBefore.lotQty);
    expect(order.fulfilled).toBe(snapshotBefore.orderFulfilled);
    expect(s.warehouses.find(w => w.id === order.warehouseId)!.capacity).toBe(snapshotBefore.warehouseCap);
  });

  test('creator, modifier, and same actor cannot supply the second approval for high-risk action', () => {
    const s = seedWithIncident();
    const order = s.orders[0]!;
    const lot = s.lots[0]!;
    order.penaltyCents = 750_000;

    const highRiskPlan: RecoveryPlan = {
      id: 'plan-hr-2',
      incidentId: 'inc-1',
      orderId: order.id,
      type: 'reallocate',
      quantity: 15,
      sourceId: lot.id,
      arrivesAt: s.clock,
      costCents: 50_000,
      feasible: true,
      reasons: [],
      status: 'proposed',
      createdBy: analyst.id,
      version: 1,
      rationale: 'Test rationale',
      evidenceIds: [],
      inventoryVersion: s.version,
    };
    s.plans.push(highRiskPlan);

    // Creator cannot give first approval
    rejects(() => decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, analyst), 403);

    // Manager 1 gives first approval
    decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager);
    expect(highRiskPlan.status).toBe('awaiting_second_approval');

    // Manager 1 attempts to approve a second time: rejected (400)
    rejects(() => decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager), 400);

    // Creator attempts to give second approval: rejected (403)
    rejects(() => decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, analyst), 403);

    // Distinct second approver (manager 2) approves: succeeds and executes
    const executed = decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager2);
    expect(executed.status).toBe('executed');
    expect(executed.approvals).toHaveLength(2);
    expect(executed.approvals![0].approverId).toBe(manager.id);
    expect(executed.approvals![1].approverId).toBe(manager2.id);
  });

  test('plan modification invalidates approvals and increments version', () => {
    const s = seedWithIncident();
    const order = s.orders[0]!;
    const lot = s.lots[0]!;
    order.penaltyCents = 750_000;

    const highRiskPlan: RecoveryPlan = {
      id: 'plan-hr-3',
      incidentId: 'inc-1',
      orderId: order.id,
      type: 'reallocate',
      quantity: 15,
      sourceId: lot.id,
      arrivesAt: s.clock,
      costCents: 50_000,
      feasible: true,
      reasons: [],
      status: 'proposed',
      createdBy: analyst.id,
      version: 1,
      rationale: 'Test rationale',
      evidenceIds: [],
      inventoryVersion: s.version,
    };
    s.plans.push(highRiskPlan);

    // First approval recorded
    decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager);
    expect(highRiskPlan.status).toBe('awaiting_second_approval');
    expect(highRiskPlan.approvals).toHaveLength(1);

    // Modification by manager2
    decidePlan(s, highRiskPlan.id, { action: 'modify', quantity: 10 }, manager2);
    expect(highRiskPlan.version).toBe(2);
    expect(highRiskPlan.status).toBe('proposed');
    expect(highRiskPlan.approvals).toHaveLength(0); // Approvals cleared
    expect(highRiskPlan.lastModifiedBy).toBe(manager2.id);

    // Last modifier (manager2) cannot give approval on the new version
    rejects(() => decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager2), 403);

    // Manager 1 can record first approval on version 2
    decidePlan(s, highRiskPlan.id, { action: 'approve', confirmed: true }, manager);
    expect(highRiskPlan.status).toBe('awaiting_second_approval');
    expect(highRiskPlan.approvals![0].version).toBe(2);
  });

  test('break-glass execution requires admin, confirmation, and >= 20 char reason; attaches review status and notification', () => {
    const s = seedWithIncident();
    const order = s.orders[0]!;
    const lot = s.lots[0]!;
    order.penaltyCents = 750_000;

    const highRiskPlan: RecoveryPlan = {
      id: 'plan-hr-bg',
      incidentId: 'inc-1',
      orderId: order.id,
      type: 'reallocate',
      quantity: 15,
      sourceId: lot.id,
      arrivesAt: s.clock,
      costCents: 50_000,
      feasible: true,
      reasons: [],
      status: 'proposed',
      createdBy: analyst.id,
      version: 1,
      rationale: 'Test rationale',
      evidenceIds: [],
      inventoryVersion: s.version,
    };
    s.plans.push(highRiskPlan);

    // Non-admin cannot use break-glass (403)
    rejects(
      () =>
        decidePlan(
          s,
          highRiskPlan.id,
          { action: 'approve', breakGlass: true, breakGlassReason: 'Critical customer line stoppage requires immediate execution.', confirmed: true },
          manager,
        ),
      403,
    );

    // Admin without confirmation rejected (400)
    rejects(
      () =>
        decidePlan(
          s,
          highRiskPlan.id,
          { action: 'approve', breakGlass: true, breakGlassReason: 'Critical customer line stoppage requires immediate execution.' },
          admin,
        ),
      400,
    );

    // Admin with short trivial reason rejected (400)
    rejects(
      () =>
        decidePlan(
          s,
          highRiskPlan.id,
          { action: 'approve', breakGlass: true, breakGlassReason: 'Emergency now', confirmed: true },
          admin,
        ),
      400,
    );

    // Admin with valid break-glass executes immediately
    const reason = 'Emergency line shutdown at customer hospital facility; second manager unreachable.';
    const executed = decidePlan(
      s,
      highRiskPlan.id,
      { action: 'approve', breakGlass: true, breakGlassReason: reason, confirmed: true },
      admin,
    );
    expect(executed.status).toBe('executed');
    expect(executed.breakGlass).toBeDefined();
    expect(executed.breakGlass!.actorId).toBe(admin.id);
    expect(executed.breakGlass!.reason).toBe(reason);
    expect(executed.breakGlass!.reviewStatus).toBe('required');

    // Audit trail records break-glass execution
    expect(s.decisions.some(d => d.action === 'plan_break_glass_executed' && d.entityId === highRiskPlan.id)).toBe(true);

    // Notification created for retrospective review
    expect(s.notifications.some(n => n.message.includes('BREAK-GLASS') && n.message.includes('Retrospective review required'))).toBe(true);
  });
});
