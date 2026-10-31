import type { Impact, Shipment, State } from '../shared/types';

export type SupplySituation = 'broken' | 'delayed' | 'affected' | 'unaffected';
export interface SupplyNodeStatus { situation: SupplySituation; reasons: string[]; rootIds: string[] }
export interface SupplyCascade { rootId: string; rootName: string; itemId: string; supplierIds: string[]; orderIds: string[]; paths: string[][]; verified: boolean }
export const supplySituationLabels: Record<SupplySituation, string> = { broken: 'Commitment broken', delayed: 'Delayed', affected: 'Affected downstream', unaffected: 'Unaffected' };
export const supplySituationColors: Record<SupplySituation, string> = { broken: '#dc3545', delayed: '#dba51b', affected: '#229c69', unaffected: '#94a3b8' };

export function upstreamSupplierIds(state: State, supplierId: string, itemId: string): Set<string> {
  const ids = new Set([supplierId]); const queue = [supplierId];
  while (queue.length) { const current = queue.shift()!; for (const edge of state.dependencies) if (edge.parentId === current && edge.itemId === itemId && !ids.has(edge.childId)) { ids.add(edge.childId); queue.push(edge.childId); } }
  return ids;
}

/** Keep confirmed upstream shortfalls out of projected, not-yet-dispatched inbound supply. */
export function upstreamShipmentQuota(state: State, shipment: Shipment): number {
  if (shipment.status !== 'scheduled') return shipment.quantity;
  const ancestors = upstreamSupplierIds(state, shipment.supplierId, shipment.itemId);
  let quota = shipment.quantity;
  for (const supplier of state.suppliers) if (ancestors.has(supplier.id)) for (const c of supplier.commitments || []) {
    if (c.itemId !== shipment.itemId || c.status === 'fulfilled') continue;
    const ratio = c.status === 'broken' && c.confirmedQuantity >= c.expectedQuantity ? 0 : c.confirmedQuantity / c.expectedQuantity;
    if (c.status === 'broken' || ratio < 1) quota = Math.min(quota, Math.floor(shipment.quantity * Math.max(0, ratio)));
  }
  return quota;
}

export function assessSupplyNetwork(state: State, impacts: Impact[]) {
  const nodes: Record<string, SupplyNodeStatus> = {};
  const cascades: SupplyCascade[] = [];
  const rank: Record<SupplySituation, number> = { unaffected: 0, affected: 1, delayed: 2, broken: 3 };
  const put = (key: string, situation: SupplySituation, reason: string, rootId = key) => {
    const node = nodes[key] ||= { situation: 'unaffected', reasons: [], rootIds: [] };
    if (node.situation === 'unaffected' && situation !== 'unaffected') node.reasons = [];
    if (rank[situation] > rank[node.situation]) node.situation = situation;
    if (!node.reasons.includes(reason)) node.reasons.push(reason);
    if (situation !== 'unaffected' && !node.rootIds.includes(rootId)) node.rootIds.push(rootId);
  };
  const shortages = new Set(impacts.filter(x => x.shortage > 0).map(x => x.orderId));
  const openOrders = state.orders.filter(x => x.status !== 'fulfilled' && x.fulfilled < x.quantity);
  type Root = { id: string; name: string; item: string; situation: 'broken' | 'delayed'; reason: string; kind: 'supplier' | 'warehouse'; shipmentId?: string };
  const roots: Root[] = [];
  for (const supplier of state.suppliers) {
    put(`supplier:${supplier.id}`, 'unaffected', 'No current disruption recorded; missing relationships are not assumed healthy');
    for (const c of supplier.commitments || []) {
      const reason = `${c.confirmedQuantity} of ${c.expectedQuantity} ${c.itemId} units confirmed; due ${c.dueAt}`;
      if (c.status === 'broken' || c.confirmedQuantity < c.expectedQuantity) roots.push({ id: supplier.id, name: supplier.name, item: c.itemId, kind: 'supplier', situation: 'broken', reason });
      else if (c.status === 'delayed') roots.push({ id: supplier.id, name: supplier.name, item: c.itemId, kind: 'supplier', situation: 'delayed', reason });
    }
    for (const incident of state.incidents.filter(x => x.entityId === supplier.id && x.status !== 'resolved' && x.type === 'supplier_delay')) {
      const item = state.events.find(x => x.status === 'accepted' && x.entityId === supplier.id && x.type === 'supplier_commitment')?.payload.itemId;
      for (const component of supplier.components.filter(x => !item || x === item)) roots.push({ id: supplier.id, name: supplier.name, item: component, kind: 'supplier', situation: 'delayed', reason: incident.title });
    }
  }
  for (const warehouse of state.warehouses) {
    put(`warehouse:${warehouse.id}`, 'unaffected', 'No current direct failure or traced upstream impact');
    if (warehouse.status === 'outage') for (const item of new Set(openOrders.filter(x => x.warehouseId === warehouse.id).map(x => x.itemId))) roots.push({ id: warehouse.id, name: warehouse.name, item, kind: 'warehouse', situation: 'broken', reason: 'Warehouse outage prevents stock access and receiving commitments' });
  }
  for (const customer of new Set(state.orders.map(x => x.customer))) put(`customer:${customer}`, 'unaffected', 'No current uncovered demand traced to a disruption');
  for (const incident of state.incidents.filter(x => x.status !== 'resolved' && ['stock_shortage', 'stock_conflict'].includes(x.type))) {
    const lot = state.lots.find(x => x.id === incident.entityId);
    if (lot && impacts.some(x => x.shortage > 0 && x.incidentIds.includes(incident.id))) roots.push({ id: lot.warehouseId, name: state.warehouses.find(x => x.id === lot.warehouseId)?.name || lot.warehouseId, item: lot.itemId, kind: 'warehouse', situation: 'broken', reason: incident.title });
  }
  for (const shipment of state.shipments.filter(x => x.status !== 'delivered')) {
    const relevant = openOrders.some(x => x.warehouseId === shipment.warehouseId && x.itemId === shipment.itemId);
    if (!relevant) continue;
    const ancestors = upstreamSupplierIds(state, shipment.supplierId, shipment.itemId);
    const inherited = roots.some(x => x.kind === 'supplier' && x.item === shipment.itemId && ancestors.has(x.id));
    if (inherited) continue;
    const late = shipment.status === 'delayed' || Date.parse(shipment.eta) > Date.parse(shipment.baselineEta);
    const missed = Date.parse(shipment.eta) < Date.parse(state.clock) && openOrders.some(x => x.warehouseId === shipment.warehouseId && x.itemId === shipment.itemId && shortages.has(x.id) && Date.parse(x.deadline) < Date.parse(state.clock));
    if (late || missed) roots.push({ id: shipment.supplierId, name: state.suppliers.find(x => x.id === shipment.supplierId)?.name || shipment.supplierId, item: shipment.itemId, kind: 'supplier', situation: missed ? 'broken' : 'delayed', reason: missed ? `${shipment.id}: required delivery deadline passed with uncovered demand` : `${shipment.id}: ETA delayed beyond its baseline`, shipmentId: shipment.id });
  }
  const distinctRoots = new Map<string, Root>();
  for (const root of roots) { const key = `${root.kind}:${root.id}:${root.item}:${root.shipmentId || ''}`; const existing = distinctRoots.get(key); if (!existing || rank[root.situation] > rank[existing.situation]) distinctRoots.set(key, root); }
  for (const root of distinctRoots.values()) {
    const rootKey = `${root.kind}:${root.id}`;
    put(rootKey, root.situation, root.reason, rootKey);
    if (root.kind === 'warehouse') {
      for (const order of openOrders.filter(x => x.warehouseId === root.id && x.itemId === root.item && shortages.has(x.id))) put(`customer:${order.customer}`, 'affected', `Affected by ${root.name}: ${root.reason}`, rootKey);
      continue;
    }
    const paths = new Map<string, string[][]>([[root.id, [[root.id]]]]);
    const queue: string[][] = [[root.id]];
    while (queue.length) { const path = queue.shift()!; const last = path.at(-1)!;
      for (const edge of state.dependencies.filter(x => x.childId === last && x.itemId === root.item)) {
        if (path.includes(edge.parentId)) continue;
        const next = [...path, edge.parentId]; paths.set(edge.parentId, [...(paths.get(edge.parentId) || []), next]); queue.push(next);
      }
    }
    const affectedSuppliers = new Set<string>(); const orderIds = new Set<string>(); const traced: string[][] = [];
    let verified = true;
    for (const ship of state.shipments.filter(x => x.status !== 'delivered' && x.itemId === root.item && paths.has(x.supplierId) && (!root.shipmentId || root.shipmentId === x.id))) {
      const orders = openOrders.filter(x => x.warehouseId === ship.warehouseId && x.itemId === root.item && shortages.has(x.id));
      if (!orders.length) continue;
      for (const path of paths.get(ship.supplierId)!) {
        for (const id of path.slice(1)) { affectedSuppliers.add(id); put(`supplier:${id}`, 'affected', `Upstream ${root.name}: ${root.reason}`, rootKey); }
        for (let i = 1; i < path.length; i++) if (!state.dependencies.find(x => x.childId === path[i - 1] && x.parentId === path[i] && x.itemId === root.item)?.verified) verified = false;
        put(`warehouse:${ship.warehouseId}`, 'affected', `${root.name} affects ${ship.id} and its receiving commitments`, rootKey);
        for (const order of orders) { orderIds.add(order.id); put(`customer:${order.customer}`, 'affected', `${root.name} disruption reaches ${order.id}`, rootKey); traced.push([...path, ship.warehouseId, order.customer]); }
      }
    }
    if (affectedSuppliers.size && orderIds.size) cascades.push({ rootId: root.id, rootName: root.name, itemId: root.item, supplierIds: [...affectedSuppliers], orderIds: [...orderIds], paths: traced, verified });
  }
  for (const impact of impacts.filter(x => x.shortage > 0)) {
    const order = state.orders.find(x => x.id === impact.orderId);
    if (order && nodes[`customer:${order.customer}`]?.situation === 'unaffected') {
      put(`warehouse:${order.warehouseId}`, 'broken', `${order.id}: ${impact.shortage} required units have no usable stock or on-time incoming supply`);
      put(`customer:${order.customer}`, 'affected', `${impact.shortage} units uncovered for ${order.id}`, `warehouse:${order.warehouseId}`);
    }
  }
  return { nodes, cascades };
}
