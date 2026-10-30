import type { Actor, EventInput, Lot, RawEvent, State } from '../shared/types';
import { audit, incident, integer, nextId, requireFocal, sourceEvidence, upstreamPaths, validTime } from './common';
import { receivedQuantity, shipmentAccounting } from './impact';

const types = new Set(['supplier_delay', 'shipment_eta', 'stock_count', 'warehouse_outage', 'condition_reading', 'shipment_status']);
const statuses = new Set(['scheduled', 'in_transit', 'delayed', 'delivered']);
const meanings = new Set(['on_hand', 'dispatched', 'collected', 'received']);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const physicalMeaning = (input: EventInput) => input.payload.meaning ?? 'on_hand';
const ordersForLot = (state: State, entityId: string) => {
  const lot = state.lots.find(l => l.id === entityId); return lot ? state.orders.filter(o => o.itemId === lot.itemId && o.warehouseId === lot.warehouseId).map(o => o.id) : [];
};
function sameScope(a: EventInput, b: EventInput): boolean {
  return a.type === b.type && a.entityId === b.entityId && (a.type !== 'stock_count' || physicalMeaning(a) === physicalMeaning(b));
}
function validation(state: State, input: EventInput): string | undefined {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200 || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 200) return 'Event ID and source are required';
  if (!types.has(input.type) || !validTime(input.time) || typeof input.entityId !== 'string' || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) return 'Invalid event type, timestamp, entity or payload';
  const payload = input.payload;
  if (input.type === 'supplier_delay') {
    if (!state.suppliers.some(s => s.id === input.entityId)) return 'Broken supplier reference; downstream exposure cannot be established';
    if (!integer(payload.delayHours) || payload.delayHours > 8760) return 'Delay must be an integer between 0 and 8760 hours';
  }
  if (input.type === 'warehouse_outage') {
    if (!state.warehouses.some(w => w.id === input.entityId)) return 'Broken warehouse reference; affected stock cannot be established';
    if (payload.status !== undefined && payload.status !== 'online' && payload.status !== 'outage') return 'Warehouse status must be online or outage';
  }
  if (input.type === 'shipment_eta' || input.type === 'shipment_status') {
    const shipment = state.shipments.find(s => s.id === input.entityId); if (!shipment) return 'Broken shipment reference; inventory/order exposure unknown';
    if (input.type === 'shipment_eta' && !validTime(payload.eta)) return 'ETA must be a valid timestamp';
    if (input.type === 'shipment_status') {
      if (typeof payload.status !== 'string' || !statuses.has(payload.status)) return 'Unknown shipment status';
      if (payload.quantity !== undefined && (!integer(payload.quantity) || payload.quantity > shipment.quantity)) return 'Received quantity must be an integer within shipment quantity';
      if (shipment.status === 'delivered' && payload.status !== 'delivered') return 'Impossible transition: a delivered shipment cannot return to transit';
      if (shipment.status !== 'scheduled' && payload.status === 'scheduled') return 'Impossible transition: shipment cannot return to scheduled';
      if (payload.status === 'delivered') {
        const prevEvents = state.events.filter(e => e.entityId === shipment.id && e.type === 'shipment_status' && e.status === 'accepted' && e.payload.status === 'delivered');
        const prevCumulative = prevEvents.reduce((n, e) => Math.max(n, typeof e.payload.quantity === 'number' ? e.payload.quantity : shipment.quantity), 0);
        if (payload.quantity !== undefined && payload.quantity < prevCumulative) return 'Cumulative received quantity cannot decrease';
        if (shipment.lotId) {
          const lot = state.lots.find(l => l.id === shipment.lotId);
          if (!lot) return `Unknown lot ${shipment.lotId}; stock destination lot missing`;
          if (lot.warehouseId !== shipment.warehouseId || lot.itemId !== shipment.itemId) return `Shipment lot ${shipment.lotId} item or warehouse does not match shipment`;
        }
      }
    }
  }
  if (input.type === 'stock_count' || input.type === 'condition_reading') {
    const lot = state.lots.find(l => l.id === input.entityId); if (!lot) return 'Broken sensor/lot reference; precise affected stock unknown';
    if (payload.warehouseId !== undefined && payload.warehouseId !== lot.warehouseId) return 'Quantity location conflicts with linked lot warehouse';
    if (payload.itemId !== undefined && payload.itemId !== lot.itemId) return 'Quantity item conflicts with linked lot item';
    if (payload.unit !== undefined && payload.unit !== 'units') return 'Only integer unit quantities are supported; conversion evidence required';
    if (input.type === 'stock_count') {
      if (!integer(payload.quantity)) return 'Stock quantity must be a nonnegative safe integer';
      if (!meanings.has(String(physicalMeaning(input)))) return 'Quantity meaning must be on_hand, dispatched, collected or received';
      if (physicalMeaning(input) === 'on_hand' && payload.quantity < lot.reserved) return 'Count below hard reservations; manual reconciliation required';
    } else {
      if (lot.itemId !== 'controller') return `Condition policy missing for item ${lot.itemId}; acceptable condition and quality exposure cannot be established`;
      if (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature) || typeof payload.durationMinutes !== 'number' || !Number.isFinite(payload.durationMinutes) || payload.durationMinutes < 0) return 'Condition reading requires finite temperature and nonnegative duration';
    }
  }
  return undefined;
}
export function ingestEvent(state: State, input: EventInput, actor: Actor): RawEvent {
  requireFocal(actor, ['analyst', 'manager', 'warehouse', 'admin']);
  const raw: RawEvent = { ...structuredClone(input), receivedAt: state.clock, status: 'accepted', message: 'Accepted source evidence' };
  const invalid = validation(state, input);
  if (invalid) { raw.status = 'invalid'; raw.message = invalid; }
  else {
    const priorId = state.events.find(e => e.id === input.id && e.source === input.source && e.status !== 'queued');
    if (priorId) {
      if (canonical({ type: priorId.type, entityId: priorId.entityId, time: priorId.time, payload: priorId.payload }) === canonical({ type: input.type, entityId: input.entityId, time: input.time, payload: input.payload })) { raw.status = 'duplicate'; raw.message = 'Idempotency key already processed; no operational effect'; }
      else { raw.status = 'conflict'; raw.message = 'Idempotency key reused with different evidence; no operational effect'; }
    } else if (state.integrationOutage) { raw.status = 'queued'; raw.message = 'Durably queued during simulated integration outage'; state.queue.push(structuredClone(input)); }
    else {
      const accepted = state.events.filter(e => e.status === 'accepted' && sameScope(e, input));
      const seedTime = input.type === 'shipment_eta' ? Math.max(-Infinity, ...state.shipments.find(s => s.id === input.entityId)!.etaHistory.map(r => Date.parse(r.at))) : -Infinity;
      let latestTime = Math.max(seedTime, -Infinity, ...accepted.map(e => Date.parse(e.time)));
      if (input.type === 'stock_count') {
        const lotMutations = state.decisions.filter(d =>
          (d.entityId === input.entityId || d.evidenceIds?.includes(input.entityId)) &&
          ['plan_executed', 'lot_disposition', 'stock_reconciled', 'stock_disputed', 'shipment_receipt'].includes(d.action)
        );
        const decisionTime = Math.max(-Infinity, ...lotMutations.map(d => Date.parse(d.at)));
        latestTime = Math.max(latestTime, decisionTime);
      }
      if (Date.parse(input.time) < latestTime) { raw.status = 'stale'; raw.message = 'Older effective-time evidence preserved; newer trusted fact remains unchanged'; }
      else {
        const contradiction = accepted.find(e => Date.parse(e.time) === Date.parse(input.time) && (input.type === 'stock_count' ? e.payload.quantity !== input.payload.quantity : canonical(e.payload) !== canonical(input.payload)));
        if (contradiction && (input.type !== 'stock_count' || physicalMeaning(input) === 'on_hand')) { raw.status = 'conflict'; raw.message = 'Same entity, quantity meaning and effective time contradict accepted evidence'; }
      }
    }
  }
  state.events.push(raw);
  if (raw.status === 'accepted') {
    if (Date.parse(input.time) > Date.parse(state.clock)) state.clock = new Date(input.time).toISOString();
    applyAccepted(state, input, actor);
  } else if (raw.status === 'conflict' && input.type === 'stock_count' && physicalMeaning(input) === 'on_hand') {
    const lot = state.lots.find(l => l.id === input.entityId);
    if (lot) { const before = structuredClone(lot); lot.status = 'disputed'; lot.version += 1; audit(state, actor, 'stock_disputed', lot.id, raw.message, sourceEvidence(state, [lot.id]), before, lot); incident(state, actor, 'stock_conflict', lot.id, 'Physical stock claims conflict', raw.message, ordersForLot(state, lot.id), input.id); }
  }
  audit(state, actor, `event_${raw.status}`, input.entityId, raw.message, [input.id], undefined, raw);
  return raw;
}
function applyAccepted(state: State, input: EventInput, actor: Actor): void {
  const payload = input.payload;
  if (input.type === 'supplier_delay') {
    const supplier = state.suppliers.find(s => s.id === input.entityId)!;
    const shipments = state.shipments.filter(s => s.status !== 'delivered' && upstreamPaths(state, s.supplierId).some(p => p.includes(supplier.id)));
    for (const shipment of shipments) {
      const eta = new Date(Date.parse(shipment.baselineEta) + (payload.delayHours as number) * 3_600_000).toISOString();
      const newer = shipment.etaHistory.some(r => Date.parse(r.at) > Date.parse(input.time));
      if (!newer) { shipment.eta = eta; shipment.status = payload.delayHours ? 'delayed' : 'in_transit'; shipment.etaHistory.push({ eta, at: input.time, source: 'supplier delay rule' }); }
    }
    const affected = state.orders.filter(o => shipments.some(s => s.warehouseId === o.warehouseId && s.itemId === o.itemId)).map(o => o.id);
    if (payload.delayHours) incident(state, actor, 'supplier_delay', supplier.id, `${supplier.name} delay propagates downstream`, `${payload.delayHours}h delay over declared supplier dependencies; unverified links remain declarations`, affected, input.id);
  } else if (input.type === 'shipment_eta') {
    const shipment = state.shipments.find(s => s.id === input.entityId)!; shipment.eta = new Date(payload.eta as string).toISOString(); shipment.etaHistory.push({ eta: shipment.eta, at: input.time, source: input.source });
    const affected = state.orders.filter(o => o.warehouseId === shipment.warehouseId && o.itemId === shipment.itemId && Date.parse(o.deadline) < Date.parse(shipment.eta)).map(o => o.id);
    if (affected.length) { shipment.status = 'delayed'; incident(state, actor, 'late_shipment', shipment.id, `${shipment.id} misses order deadline`, 'Latest ETA exceeds customer deadline', affected, input.id); }
  } else if (input.type === 'warehouse_outage') {
    const warehouse = state.warehouses.find(w => w.id === input.entityId)!; warehouse.status = payload.status === 'online' ? 'online' : 'outage';
    if (warehouse.status === 'outage') incident(state, actor, 'warehouse_outage', warehouse.id, `${warehouse.name} unavailable`, 'Stock access and receiving capacity blocked until service restored', state.orders.filter(o => o.warehouseId === warehouse.id).map(o => o.id), input.id);
    else state.incidents.filter(i => i.type === 'warehouse_outage' && i.entityId === warehouse.id).forEach(i => { i.status = 'resolved'; });
  } else if (input.type === 'stock_count') {
    const lot = state.lots.find(l => l.id === input.entityId)!;
    if (physicalMeaning(input) === 'on_hand') { const before = structuredClone(lot); lot.quantity = payload.quantity as number; lot.version += 1; audit(state, actor, 'stock_reconciled', lot.id, 'Physical on-hand count accepted; disposition is preserved', [input.id], before, lot); incident(state, actor, 'stock_shortage', lot.id, 'Stock count changed order coverage', 'Physical count requires downstream coverage reassessment', ordersForLot(state, lot.id), input.id); }
    else audit(state, actor, 'lifecycle_claim_recorded', lot.id, `${physicalMeaning(input)} quantity is a lifecycle claim, not physical on-hand stock`, [input.id]);
  } else if (input.type === 'condition_reading') {
    const lot = state.lots.find(l => l.id === input.entityId)!;
    state.readings.push({ id: nextId(state, 'reading'), lotId: lot.id, at: input.time, temperature: payload.temperature as number, threshold: 30, durationMinutes: payload.durationMinutes as number });
    if ((payload.temperature as number) > 30 && (payload.durationMinutes as number) >= 15) {
      const before = structuredClone(lot); lot.status = lot.status === 'disputed' ? 'disputed' : 'quarantined'; lot.version += 1;
      audit(state, actor, 'quality_quarantine', lot.id, 'Fictional controller policy: temperature >30°C for at least 15 minutes blocks usable stock', [input.id], before, lot);
      incident(state, actor, 'condition_excursion', lot.id, 'Condition excursion blocks controller stock', 'Quality hold requires authorized warehouse disposition; synthetic thresholds are demonstration policy', ordersForLot(state, lot.id), input.id);
    }
  } else if (input.type === 'shipment_status') {
    const shipment = state.shipments.find(s => s.id === input.entityId)!;
    if (payload.status === 'delivered') {
      const cumulative = payload.quantity === undefined ? shipment.quantity : payload.quantity as number;
      const stateBefore = { ...state, events: state.events.filter(e => e !== state.events[state.events.length - 1]) };
      const beforeAccounting = shipmentAccounting(stateBefore, shipment);
      const afterAccounting = shipmentAccounting(state, shipment);
      const delta = Math.max(0, afterAccounting.physicalReceived - beforeAccounting.physicalReceived);
      let lot: Lot;
      if (!shipment.lotId) {
        lot = { id: `lot-received-${shipment.id}`, itemId: shipment.itemId, name: `Received ${shipment.id}`, warehouseId: shipment.warehouseId, quantity: 0, reserved: 0, status: 'available', version: 1 };
        shipment.lotId = lot.id;
        state.lots.push(lot);
      } else {
        lot = state.lots.find(l => l.id === shipment.lotId)!;
      }
      lot.quantity += delta;
      lot.version += 1;
      shipment.status = afterAccounting.receivedQuantity >= shipment.quantity ? 'delivered' : 'in_transit';
      audit(state, actor, 'shipment_receipt', shipment.id, `${delta} newly received units; cumulative receipt ${cumulative}, partial receipts do not double count`, [input.id], undefined, { lot: structuredClone(lot), cumulative });
    } else shipment.status = payload.status as typeof shipment.status;
  }
}
export function replayQueue(state: State, actor: Actor): void {
  requireFocal(actor, ['analyst', 'manager', 'admin']); const queue = [...state.queue]; state.integrationOutage = false; state.queue = [];
  audit(state, actor, 'integration_restored', 'integration', `Replaying ${queue.length} durable events with original effective times`, queue.map(e => e.id));
  for (const input of queue) ingestEvent(state, input, actor);
}
