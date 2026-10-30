import { describe, expect, test } from 'bun:test';
import { createSeedState } from '../src/domain/seed';
import { ingestEvent, replayQueue } from '../src/domain/events';
import type { Actor, EventInput } from '../src/shared/types';

const analyst: Actor = { id: 'analyst-1', name: 'Analyst', email: 'a@test', role: 'analyst', orgId: 'focal' };
const manager: Actor = { id: 'manager-1', name: 'Manager', email: 'm@test', role: 'manager', orgId: 'focal' };

describe('integration-specific continuity inbox and resilience', () => {
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
