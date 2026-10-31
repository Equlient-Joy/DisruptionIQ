import { describe, expect, test } from 'bun:test';
import { createSeedState } from './fixtures/enterprise';
import { ingestEvent, replayQueue } from '../src/domain/events';
import type { Actor, EventInput } from '../src/shared/types';

const analyst: Actor = { id: 'analyst-1', name: 'Analyst', email: 'a@test', role: 'analyst', orgId: 'focal' };
const manager: Actor = { id: 'manager-1', name: 'Manager', email: 'm@test', role: 'manager', orgId: 'focal' };

describe('integration-specific continuity inbox and resilience', () => {
  test('an older queued physical count cannot erase a later carrier receipt', () => {
    const state=createSeedState(new Date('2026-11-01T00:00:00Z'));
    const lot=state.lots[0]!;const shipment=state.shipments[0]!;shipment.lotId=lot.id;
    state.integrations.find(c=>c.kind==='warehouse')!.status='offline';
    ingestEvent(state,{id:'count-before-receipt',source:'wms',type:'stock_count',entityId:lot.id,time:'2026-11-01T01:00:00Z',payload:{quantity:40,meaning:'on_hand'}},analyst);
    ingestEvent(state,{id:'later-receipt',source:'carrier',type:'shipment_status',entityId:shipment.id,time:'2026-11-01T02:00:00Z',payload:{status:'delivered',quantity:120}},analyst);
    expect(lot.quantity).toBe(160);
    // Old persisted receipt audits have a lot snapshot but no explicit lot evidence ID.
    state.decisions.filter(d=>d.action==='shipment_receipt').forEach(d=>{d.evidenceIds=d.evidenceIds.filter(id=>id!==lot.id);});
    const result=replayQueue(state,manager,{integrationId:'warehouse'});
    expect(result.events[0]!.status).toBe('stale');expect(lot.quantity).toBe(160);
  });
  test('an unknown replay target rejects without consuming any queued events', () => {
    for (const preview of [false, true]) {
      const state = createSeedState();
      state.integrations.find(c => c.kind === 'carrier')!.status = 'offline';
      ingestEvent(state, { id: 'queued', source: 'carrier', type: 'shipment_eta', entityId: state.shipments[0]!.id, time: state.clock, payload: { eta: state.shipments[0]!.eta } }, analyst);
      const before = JSON.stringify(state);
      expect(() => replayQueue(state, manager, { integrationId: 'missing', preview })).toThrow('not found');
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  test('replay reconciles effective times chronologically even when arrivals are reversed', () => {
    const state = createSeedState();
    state.integrations.find(c => c.kind === 'carrier')!.status = 'offline';
    const shipment = state.shipments[0]!;
    const later = new Date(Date.parse(state.clock) + 3600000).toISOString();
    for (const [id, time] of [['later', later], ['earlier', state.clock]]) {
      ingestEvent(state, { id, time, source: 'carrier', type: 'shipment_status', entityId: shipment.id, payload: { status: 'in_transit' } }, analyst);
    }
    const result = replayQueue(state, manager, { integrationId: 'carrier' });
    expect(result.events.map(e => e.id)).toEqual(['earlier', 'later']);
    expect(result.events.map(e => e.status)).toEqual(['accepted', 'accepted']);
  });

  test('replayed stock counts use effective times rather than replay audit timestamps', () => {
    const state = createSeedState(new Date('2026-10-31T10:00:00Z'));
    const lot = state.lots[0]!;
    state.integrations.find(c => c.kind === 'warehouse')!.status = 'offline';
    for (const [id, time, quantity] of [
      ['new-count', '2026-10-31T09:00:00Z', 90],
      ['old-count', '2026-10-31T08:00:00Z', 60],
    ] as const) {
      ingestEvent(state, { id, time, source: 'warehouse', type: 'stock_count', entityId: lot.id, payload: { quantity, meaning: 'on_hand' } }, analyst);
    }
    const preview = replayQueue(state, manager, { integrationId: 'warehouse', preview: true });
    expect(lot.quantity).toBe(40);
    const replay = replayQueue(state, manager, { integrationId: 'warehouse' });
    expect(preview.events.map(e => e.status)).toEqual(['accepted', 'accepted']);
    expect(replay.events.map(e => e.status)).toEqual(['accepted', 'accepted']);
    expect(lot.quantity).toBe(90);
  });

  test('one offline integration does not queue unrelated source events', () => {
    const s = createSeedState(new Date('2026-10-30T06:00:00Z'));
    // Set only carrier integration to offline
    const carrier = s.integrations.find(c => c.kind === 'carrier')!;
    carrier.status = 'offline';
    const supplier = s.integrations.find(c => c.kind === 'supplier')!;
    expect(supplier.status).toBe('online');

    // 1. Ingest carrier event (shipment_eta): must be queued
    const carrierEvent: EventInput = {
      id: 'carrier-ev-1',
      source: 'carrier-api',
      type: 'shipment_eta',
      entityId: s.shipments[0]!.id,
      time: s.clock,
      payload: { eta: new Date(Date.parse(s.clock) + 36 * 3_600_000).toISOString() },
    };
    const carrierRes = ingestEvent(s, carrierEvent, analyst);
    expect(carrierRes.status).toBe('queued');
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]!.id).toBe('carrier-ev-1');

    // 2. Ingest supplier event (supplier_delay): must NOT be queued; it's accepted immediately
    const supplierEvent: EventInput = {
      id: 'supplier-ev-1',
      source: 'supplier-edi',
      type: 'supplier_delay',
      entityId: s.suppliers[0]!.id,
      time: s.clock,
      payload: { delayHours: 12 },
    };
    const supplierRes = ingestEvent(s, supplierEvent, analyst);
    expect(supplierRes.status).toBe('accepted');
    // Queue length still 1 (unrelated source was not queued)
    expect(s.queue).toHaveLength(1);
  });

  test('preview is strictly non-mutating and returns predicted reconciliation results', () => {
    const s = createSeedState(new Date('2026-10-30T06:00:00Z'));
    const carrier = s.integrations.find(c => c.kind === 'carrier')!;
    carrier.status = 'offline';

    const shipment = s.shipments[0]!;
    const originalEta = shipment.eta;
    const newEta = new Date(Date.parse(s.clock) + 50 * 3_600_000).toISOString();

    const carrierEvent: EventInput = {
      id: 'carrier-preview-1',
      source: 'carrier-api',
      type: 'shipment_eta',
      entityId: shipment.id,
      time: s.clock,
      payload: { eta: newEta },
    };
    ingestEvent(s, carrierEvent, analyst);
    expect(s.queue).toHaveLength(1);

    const snapshotBefore = JSON.stringify(s);

    // Call replayQueue with preview: true
    const previewResult = replayQueue(s, manager, { preview: true });
    expect(previewResult.ok).toBe(true);
    expect(previewResult.preview).toBe(true);
    expect(previewResult.replayed).toBe(1);
    expect(previewResult.events).toHaveLength(1);
    expect(previewResult.events[0]!.status).toBe('accepted');

    // State MUST NOT be changed by preview
    expect(JSON.stringify(s)).toBe(snapshotBefore);
    expect(s.queue).toHaveLength(1);
    expect(shipment.eta).toBe(originalEta);
  });

  test('targeted replay applies only the selected integration and leaves others queued', () => {
    const s = createSeedState(new Date('2026-10-30T06:00:00Z'));
    const carrier = s.integrations.find(c => c.kind === 'carrier')!;
    const warehouse = s.integrations.find(c => c.kind === 'warehouse')!;
    carrier.status = 'offline';
    warehouse.status = 'offline';

    // Queue carrier event
    const carrierEvent: EventInput = {
      id: 'carrier-targeted-1',
      source: 'carrier-api',
      type: 'shipment_eta',
      entityId: s.shipments[0]!.id,
      time: s.clock,
      payload: { eta: new Date(Date.parse(s.clock) + 40 * 3_600_000).toISOString() },
    };
    ingestEvent(s, carrierEvent, analyst);

    // Queue warehouse event
    const warehouseEvent: EventInput = {
      id: 'warehouse-targeted-1',
      source: 'wms-cycle',
      type: 'stock_count',
      entityId: s.lots[0]!.id,
      time: s.clock,
      payload: { quantity: s.lots[0]!.quantity, meaning: 'on_hand' },
    };
    ingestEvent(s, warehouseEvent, analyst);

    expect(s.queue).toHaveLength(2);

    // Replay ONLY carrier integration
    const replayRes = replayQueue(s, manager, { integrationId: carrier.id });
    expect(replayRes.ok).toBe(true);
    expect(replayRes.replayed).toBe(1);

    // Carrier is now online, warehouse remains offline
    const updatedCarrier = s.integrations.find(c => c.kind === 'carrier')!;
    expect(updatedCarrier.status).toBe('online');
    expect(warehouse.status).toBe('offline');

    // Queue now holds ONLY the warehouse event
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]!.id).toBe('warehouse-targeted-1');
  });

  test('duplicate and out-of-order replayed events cannot overwrite newer trusted facts', () => {
    const s = createSeedState(new Date('2026-10-30T06:00:00Z'));
    const shipment = s.shipments[0]!;
    const originalTime = s.clock;
    const newerTime = new Date(Date.parse(s.clock) + 7_200_000).toISOString();
    const latestEta = new Date(Date.parse(s.clock) + 90_000_000).toISOString();

    // Accepted newer ETA
    ingestEvent(
      s,
      { id: 'new-eta', source: 'carrier', type: 'shipment_eta', entityId: shipment.id, payload: { eta: latestEta }, time: newerTime },
      analyst,
    );

    // Simulate carrier offline
    const carrier = s.integrations.find(c => c.kind === 'carrier')!;
    carrier.status = 'offline';

    // Queue older baseline ETA with originalTime
    ingestEvent(
      s,
      { id: 'old-eta', source: 'carrier', type: 'shipment_eta', entityId: shipment.id, payload: { eta: shipment.baselineEta }, time: originalTime },
      analyst,
    );

    expect(s.queue).toHaveLength(1);

    // Replay queue
    replayQueue(s, manager, { integrationId: carrier.id });

    // Latest ETA must not be overwritten by older ETA
    expect(shipment.eta).toBe(latestEta);
    expect(s.events.some(e => e.id === 'old-eta' && e.status === 'stale')).toBe(true);
  });
});
