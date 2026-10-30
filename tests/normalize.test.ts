import { describe, expect, test } from 'bun:test';
import { normalizeState, defaultIntegrations } from '../src/domain/normalize';
import type { Lot, RecoveryPlan, Decision } from '../src/shared/types';

describe('state normalization', () => {
  test('fresh empty state normalizes and supplies default integrations', () => {
    const raw = {
      version: 1,
      clock: '2026-10-31T00:00:00.000Z',
      suppliers: [],
      dependencies: [],
      warehouses: [],
      lots: [],
      shipments: [],
      orders: [],
      events: [],
      incidents: [],
      plans: [],
      decisions: [],
      tasks: [],
      documents: [],
      notifications: [],
    };
    const state = normalizeState(raw);
    expect(state.version).toBe(1);
    expect(state.clock).toBe('2026-10-31T00:00:00.000Z');
    expect(state.integrations).toHaveLength(5);
    expect(state.integrations.every(i => i.status === 'online')).toBe(true);
    expect(state.lots).toHaveLength(0);
  });

  test('migrates quarantined lot status to held', () => {
    const raw = {
      version: 1,
      clock: '2026-10-31T00:00:00.000Z',
      lots: [
        { id: 'lot-1', itemId: 'item-1', name: 'Batch 1', warehouseId: 'w-1', quantity: 50, reserved: 10, status: 'quarantined', version: 1 },
        { id: 'lot-2', itemId: 'item-1', name: 'Batch 2', warehouseId: 'w-1', quantity: 30, reserved: 0, status: 'available', version: 1 },
        { id: 'lot-3', itemId: 'item-1', name: 'Batch 3', warehouseId: 'w-1', quantity: 20, reserved: 0, status: 'disputed', version: 1 },
      ],
    };
    const state = normalizeState(raw);
    expect(state.lots[0]!.status).toBe('held');
    expect(state.lots[1]!.status).toBe('available');
    expect(state.lots[2]!.status).toBe('disputed');
  });

  test('removes cold-chain readings and active condition events while preserving historical decisions', () => {
    const raw = {
      version: 2,
      clock: '2026-10-31T00:00:00.000Z',
      readings: [
        { id: 'r-1', lotId: 'lot-1', at: '2026-10-31T00:00:00.000Z', temperature: 35, threshold: 30, durationMinutes: 20 },
      ],
      events: [
        { id: 'ev-normal', source: 'test', type: 'supplier_delay', entityId: 'sup-1', time: '2026-10-31T00:00:00.000Z', payload: { delayHours: 12 }, status: 'accepted', message: 'ok' },
        { id: 'ev-cold', source: 'test', type: 'condition_reading', entityId: 'lot-1', time: '2026-10-31T00:00:00.000Z', payload: { temperature: 35 }, status: 'accepted', message: 'excursion' },
      ],
      incidents: [
        { id: 'inc-delay', type: 'supplier_delay', entityId: 'sup-1', title: 'Delay', description: 'delay', status: 'active', createdAt: '2026-10-31T00:00:00.000Z', memberOrgIds: ['focal'], affectedOrderIds: [], alertCount: 1 },
        { id: 'inc-cold', type: 'condition_excursion', entityId: 'lot-1', title: 'Excursion', description: 'hot', status: 'active', createdAt: '2026-10-31T00:00:00.000Z', memberOrgIds: ['focal'], affectedOrderIds: [], alertCount: 1 },
      ],
      decisions: [
        { id: 'dec-1', at: '2026-10-31T00:00:00.000Z', actorId: 'admin-1', action: 'quality_quarantine', entityId: 'lot-1', detail: 'Temperature excursion quarantine', evidenceIds: ['ev-cold'], ruleVersion: '1.0' },
      ],
    };
    const state = normalizeState(raw);
    expect((state as any).readings).toBeUndefined();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.id).toBe('ev-normal');
    expect(state.incidents).toHaveLength(1);
    expect(state.incidents[0]!.id).toBe('inc-delay');
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]!.action).toBe('quality_quarantine');
  });

  test('translates legacy integrationOutage flag into carrier integration status', () => {
    const raw = {
      version: 1,
      clock: '2026-10-31T00:00:00.000Z',
      integrationOutage: true,
    };
    const state = normalizeState(raw);
    const carrier = state.integrations.find(i => i.kind === 'carrier');
    expect(carrier).toBeDefined();
    expect(carrier!.status).toBe('offline');
    const warehouse = state.integrations.find(i => i.kind === 'warehouse');
    expect(warehouse!.status).toBe('online');
  });

  test('normalizes legacy plan approver into approvals array', () => {
    const raw = {
      version: 3,
      clock: '2026-10-31T00:00:00.000Z',
      plans: [
        {
          id: 'plan-1',
          incidentId: 'inc-1',
          orderId: 'ord-1',
          type: 'reallocate',
          quantity: 20,
          sourceId: 'lot-1',
          arrivesAt: '2026-10-31T06:00:00.000Z',
          costCents: 8000,
          feasible: true,
          reasons: [],
          status: 'executed',
          createdBy: 'analyst-1',
          version: 1,
          approver: 'manager-1',
          rationale: 'test',
          evidenceIds: [],
          inventoryVersion: 1,
        },
      ],
      incidents: [
        { id: 'inc-1', type: 'supplier_delay', entityId: 'sup-1', title: 'Delay', description: 'delay', status: 'active', createdAt: '2026-10-31T00:00:00.000Z', memberOrgIds: ['focal'], affectedOrderIds: ['ord-1'], alertCount: 1 },
      ],
    };
    const state = normalizeState(raw);
    expect(state.plans).toHaveLength(1);
    const plan = state.plans[0]!;
    expect(plan.riskLevel).toBe('routine');
    expect(plan.approvals).toBeDefined();
    expect(plan.approvals![0]!.approverId).toBe('manager-1');
  });
});
