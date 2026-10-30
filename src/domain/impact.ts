import type { Impact, Shipment, State } from '../shared/types';
import { upstreamPaths } from './common';

export function shipmentAccounting(state: State, shipment: Shipment): { physicalReceived: number; expedited: number; receivedQuantity: number; availableShipment: number } {
  const deliveryEvents = state.events.filter(e => e.entityId === shipment.id && e.type === 'shipment_status' && e.status === 'accepted' && e.payload.status === 'delivered');
  const expeditePlans = state.plans.filter(p => p.type === 'expedite' && p.sourceId === shipment.id && p.status === 'executed');

  const items: Array<{ id: string; type: 'expedite' | 'receipt'; time: number; value: number }> = [];

  for (const e of deliveryEvents) {
    const cumulative = typeof e.payload.quantity === 'number' ? e.payload.quantity : shipment.quantity;
    items.push({ id: e.id, type: 'receipt', time: Date.parse(e.time) || 0, value: cumulative });
  }

  for (const p of expeditePlans) {
    const dec = state.decisions.find(d => d.action === 'plan_executed' && d.entityId === p.id);
    const time = dec ? (Date.parse(dec.at) || 0) : (Date.parse(state.clock) || 0);
    items.push({ id: p.id, type: 'expedite', time, value: p.quantity });
  }

  const getOrder = (item: { type: 'expedite' | 'receipt'; id: string }) => {
    let decIdx = -1;
    if (item.type === 'expedite') {
      decIdx = state.decisions.findIndex(d => d.action === 'plan_executed' && d.entityId === item.id);
    } else {
      decIdx = state.decisions.findIndex(d => d.evidenceIds?.includes(item.id));
    }
    return decIdx === -1 ? Number.MAX_SAFE_INTEGER : decIdx;
  };

  items.sort((a, b) => (a.time - b.time) || (getOrder(a) - getOrder(b)));

  let physicalReceived = 0;
  let expedited = 0;
  let maxCumulative = 0;

  for (const item of items) {
    if (item.type === 'expedite') {
      expedited += item.value;
    } else {
      maxCumulative = Math.max(maxCumulative, item.value);
      const targetPhysical = Math.max(0, maxCumulative - expedited);
      const delta = Math.max(0, targetPhysical - physicalReceived);
      physicalReceived += delta;
    }
  }

  const received = Math.min(shipment.quantity, physicalReceived + expedited);
  const available = shipment.status === 'delivered' ? 0 : Math.max(0, shipment.quantity - received);

  return { physicalReceived, expedited, receivedQuantity: received, availableShipment: available };
}

export function receivedQuantity(state: State, shipment: Shipment): number {
  return shipmentAccounting(state, shipment).receivedQuantity;
}
export function availableShipment(state: State, shipment: Shipment): number {
  return shipmentAccounting(state, shipment).availableShipment;
}
export function getImpact(state: State): Impact[] {
  const priority = { critical: 3, high: 2, normal: 1 };
  const inventory = new Map(state.warehouses.map(w => [w.id, new Map<string, number>()]));
  for (const lot of state.lots) {
    if (lot.status !== 'available' || state.warehouses.find(w => w.id === lot.warehouseId)?.status !== 'online') continue;
    const items = inventory.get(lot.warehouseId)!; items.set(lot.itemId, (items.get(lot.itemId) ?? 0) + Math.max(0, lot.quantity - lot.reserved));
  }
  const inbound = new Map(state.shipments.map(s => [s.id, availableShipment(state, s)]));
  const results: Impact[] = [];
  const orders = [...state.orders].filter(o => o.status !== 'fulfilled' && o.fulfilled < o.quantity).sort((a, b) => priority[b.priority] - priority[a.priority] || Date.parse(a.deadline) - Date.parse(b.deadline) || a.id.localeCompare(b.id));
  for (const order of orders) {
    const needed = Math.max(0, order.quantity - order.fulfilled); let missing = needed;
    const items = inventory.get(order.warehouseId); const covered = Math.min(missing, items?.get(order.itemId) ?? 0);
    missing -= covered; items?.set(order.itemId, (items.get(order.itemId) ?? 0) - covered);
    const shipments = state.shipments.filter(s => s.itemId === order.itemId && s.warehouseId === order.warehouseId);
    const receiver = state.warehouses.find(w => w.id === order.warehouseId);
    for (const shipment of [...shipments].sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta))) {
      if (receiver?.status !== 'online' || Date.parse(shipment.eta) > Date.parse(order.deadline)) continue;
      const take = Math.min(missing, inbound.get(shipment.id) ?? 0); missing -= take; inbound.set(shipment.id, (inbound.get(shipment.id) ?? 0) - take);
    }
    const incidents = state.incidents.filter(i => i.status !== 'resolved' && i.affectedOrderIds.includes(order.id));
    if (!missing && !incidents.length) continue;
    const hoursRemaining = Math.round((Date.parse(order.deadline) - Date.parse(state.clock)) / 3_600_000 * 10) / 10;
    let score = Math.round(missing / Math.max(1, needed) * 40) + (order.priority === 'critical' ? 30 : order.priority === 'high' ? 20 : 5) + (hoursRemaining <= 24 ? 20 : hoursRemaining <= 48 ? 10 : 0);
    const factors = [`${missing} units uncovered after usable local stock, hard reservations and on-time inbound allocation`, `${order.priority} priority; ${hoursRemaining} hours to deadline`, `Penalty exposure ${order.penaltyCents} cents`];
    score += Math.min(10, Math.floor(order.penaltyCents / 100000));
    if (receiver?.status !== 'online') factors.push(receiver ? `${receiver.name} receiving/stock access blocked by outage` : 'Warehouse reference missing; coverage cannot be established');
    const blocked = state.lots.filter(l => l.itemId === order.itemId && l.warehouseId === order.warehouseId && l.status !== 'available');
    if (blocked.length) factors.push(`${blocked.reduce((n, l) => n + l.quantity, 0)} units excluded: quarantined or disputed lots`);
    const paths: string[] = [];
    for (const shipment of shipments) {
      paths.push(...upstreamPaths(state, shipment.supplierId).map(path => `${[...path].reverse().join(' → ')} → ${shipment.id} → ${order.warehouseId} → ${order.id}`));
      if (!state.suppliers.some(s => s.id === shipment.supplierId)) factors.push(`${shipment.id}: supplier reference missing; upstream exposure unknown`);
      if (!state.dependencies.some(d => d.parentId === shipment.supplierId)) factors.push(`${shipment.id}: undeclared upstream links; supplier independence unknown`);
      if (state.dependencies.some(d => d.parentId === shipment.supplierId && !d.verified)) factors.push(`${shipment.id}: upstream dependency is a partner declaration, verification pending`);
      if (!shipment.etaHistory.length) { factors.push(`${shipment.id}: insufficient ETA evidence; confidence unknown`); score += 5; }
      else {
        const revisionHours = shipment.etaHistory.map(r => Date.parse(r.eta) / 3_600_000);
        const spread = Math.max(...revisionHours) - Math.min(...revisionHours);
        // Stability describes successive forecasts, not a calibrated arrival probability.
        const prior = shipment.etaHistory.filter(r => r.source !== 'Synthetic supplier-delay scenario' && r.source !== 'supplier delay rule');
        const priorHours = prior.map(r => Date.parse(r.eta) / 3_600_000);
        const volatile = priorHours.length >= 2 && Math.max(...priorHours) - Math.min(...priorHours) > 6;
        factors.push(`${shipment.id}: ${volatile ? 'volatile' : shipment.etaHistory.length < 2 ? 'insufficient ETA evidence' : 'stable'} forecast history (${Math.round(spread)}h revision range); heuristic evidence only`);
        if (volatile) score += 10;
        const latest = Math.max(...shipment.etaHistory.map(r => Date.parse(r.at)));
        if (Date.parse(state.clock) - latest > 12 * 3_600_000) { factors.push(`${shipment.id}: stale ETA evidence, last update more than 12h ago`); score += 5; }
      }
      if (Date.parse(shipment.eta) > Date.parse(order.deadline)) factors.push(`${shipment.id} latest ETA misses customer deadline`);
    }
    if (!shipments.length) factors.push('Inbound evidence missing; shortage assessed from known stock only');
    if (incidents.length > 1) { factors.push(`${incidents.length} compound disruptions overlap this order; exposure counted once`); score += 5 * (incidents.length - 1); }
    if (state.integrationOutage) factors.push(`${state.queue.length} queued source updates; integration unavailable, trusted facts may be stale`);
    results.push({ orderId: order.id, incidentIds: incidents.map(i => i.id), shortage: missing, score: Math.min(100, score), factors, paths: [...new Set(paths)], hoursRemaining });
  }
  return results.sort((a, b) => b.score - a.score || a.hoursRemaining - b.hoursRemaining || a.orderId.localeCompare(b.orderId));
}
