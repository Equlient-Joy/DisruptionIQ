import type { Actor, PlanAction, PlanType, RecoveryPlan, State } from '../shared/types';
import { atHours, audit, DomainError, find, integer, nextId, requireFocal, sourceEvidence, upstreamPaths, validTime } from './common';
import { availableShipment, getImpact } from './impact';

interface Constraints { arrivesAt: string; costCents: number; reasons: string[] }
function constraints(state: State, plan: RecoveryPlan): Constraints {
  const reasons: string[] = []; const order = state.orders.find(o => o.id === plan.orderId);
  let arrivesAt = atHours(state, 8); let costCents = 0;
  if (!order) return { arrivesAt, costCents, reasons: ['Order reference missing; feasibility cannot be established'] };
  if (!integer(plan.quantity) || plan.quantity <= 0) reasons.push('Quantity must be a positive safe integer');
  if (plan.quantity > order.quantity - order.fulfilled) reasons.push(`Only ${order.quantity - order.fulfilled} unfulfilled order units remain`);
  const warehouse = state.warehouses.find(w => w.id === order.warehouseId);
  if (!warehouse || !integer(warehouse.capacity)) reasons.push('Receiving capacity evidence missing');
  else {
    if (warehouse.status !== 'online') reasons.push(`${warehouse.name} is in outage; receiving unavailable`);
    if (warehouse.capacity < plan.quantity) reasons.push(`Receiving capacity ${warehouse.capacity} units is below requested ${plan.quantity}`);
  }
  if (plan.type === 'reallocate' || plan.type === 'split_order') {
    const lot = state.lots.find(l => l.id === plan.sourceId);
    if (!lot) reasons.push('Source lot evidence missing');
    else {
      const sourceWarehouse = state.warehouses.find(w => w.id === lot.warehouseId);
      if (lot.itemId !== order.itemId) reasons.push('Source item does not match customer order');
      if (lot.status !== 'available') reasons.push(`Lot ${lot.id} is ${lot.status}; stock excluded`);
      if (sourceWarehouse?.status !== 'online') reasons.push(`Source warehouse ${lot.warehouseId} is unavailable`);
      if (!integer(lot.quantity) || !integer(lot.reserved)) reasons.push('Usable stock and hard commitments evidence missing');
      else if (lot.quantity - lot.reserved < plan.quantity) reasons.push(`Only ${Math.max(0, lot.quantity - lot.reserved)} usable units after ${lot.reserved} hard commitments`);
      arrivesAt = atHours(state, lot.warehouseId === order.warehouseId ? 2 : plan.type === 'split_order' ? 6 : 8);
      costCents = plan.quantity * (plan.type === 'split_order' ? 650 : 400);
    }
    if (plan.type === 'split_order' && plan.quantity >= order.quantity - order.fulfilled) reasons.push('Split recovery must leave a positive remainder for a later leg');
  } else if (plan.type === 'expedite') {
    const shipment = state.shipments.find(s => s.id === plan.sourceId);
    if (!shipment) reasons.push('Shipment evidence missing');
    else {
      if (shipment.itemId !== order.itemId) reasons.push('Shipment item does not match customer order');
      if (!validTime(shipment.eta) || !shipment.etaHistory.length) reasons.push('ETA or transit evidence missing; express feasibility unknown');
      if (shipment.status === 'scheduled' || shipment.status === 'delivered') reasons.push('Express route requires an outstanding shipment already in transit');
      const available = availableShipment(state, shipment);
      if (available < plan.quantity) reasons.push(`Only ${available} uncommitted shipment units remain`);
      // Fictional booked express service has an eight-hour floor and saves at most 36h.
      arrivesAt = validTime(shipment.eta) ? new Date(Math.max(Date.parse(state.clock) + 8 * 3_600_000, Date.parse(shipment.eta) - 36 * 3_600_000)).toISOString() : state.clock;
      if (shipment.lotId && state.lots.find(l => l.id === shipment.lotId)?.status !== 'available') reasons.push('Linked shipment lot is under quality hold or disputed');
      costCents = plan.quantity * 2400;
    }
  } else if (plan.type === 'alternative_supplier') {
    const supplier = state.suppliers.find(s => s.id === plan.sourceId);
    if (!supplier) reasons.push('Alternate supplier evidence missing');
    else {
      if (!supplier.approved) reasons.push(`${supplier.name} is not an approved supplier`);
      if (!supplier.components.includes(order.itemId)) reasons.push('Supplier is not eligible for the order item');
      if (!integer(supplier.capacity) || !integer(supplier.minOrder) || !integer(supplier.unitCostCents) || !integer(supplier.leadHours)) reasons.push('Supplier capacity, minimum, price or lead-time evidence missing');
      if (plan.quantity < supplier.minOrder) reasons.push(`Minimum order ${supplier.minOrder} exceeds requested ${plan.quantity}`);
      if (supplier.capacity < plan.quantity) reasons.push(`Supplier remaining capacity ${supplier.capacity} is below requested ${plan.quantity}`);
      const upstream = new Set(upstreamPaths(state, supplier.id).flat());
      const disrupted = state.incidents.filter(i => i.type === 'supplier_delay' && i.status === 'active' && upstream.has(i.entityId));
      const delay = disrupted.reduce((n, i) => Math.max(n, ...state.events.filter(e => e.entityId === i.entityId && e.type === 'supplier_delay' && e.status === 'accepted').map(e => typeof e.payload.delayHours === 'number' ? e.payload.delayHours : 0)), 0);
      arrivesAt = integer(supplier.leadHours) ? atHours(state, supplier.leadHours + delay) : state.clock; costCents = integer(supplier.unitCostCents) ? plan.quantity * supplier.unitCostCents : 0;
      if (disrupted.length) reasons.push('Alternate source shares an active disrupted upstream dependency');
    }
  } else reasons.push('Unsupported recovery type');
  if (!Number.isSafeInteger(costCents) || costCents < 0) reasons.push('Cost exceeds safe integer minor-unit bounds');
  if (!validTime(order.deadline) || !validTime(arrivesAt)) reasons.push('Deadline or arrival evidence missing');
  else if (Date.parse(arrivesAt) > Date.parse(order.deadline)) reasons.push(`Arrival ${arrivesAt} misses deadline ${order.deadline}`);
  return { arrivesAt, costCents, reasons };
}
export function generatePlans(state: State, incidentId: string, actor: Actor): RecoveryPlan[] {
  requireFocal(actor, ['analyst', 'manager', 'procurement', 'admin']); const incident = find(state.incidents, incidentId, 'Incident');
  if (incident.status === 'resolved') throw new DomainError('Resolved incidents do not need new recovery plans', 409);
  const plans: RecoveryPlan[] = [];
  for (const impact of getImpact(state).filter(i => incident.affectedOrderIds.includes(i.orderId) && i.shortage > 0)) {
    const order = find(state.orders, impact.orderId, 'Order'); const quantity = impact.shortage;
    const sources: { type: PlanType; sourceId: string; quantity: number }[] = [];
    const lots = state.lots.filter(l => l.itemId === order.itemId && l.warehouseId !== order.warehouseId);
    for (const lot of lots) sources.push({ type: 'reallocate', sourceId: lot.id, quantity }, { type: 'split_order', sourceId: lot.id, quantity: Math.max(1, Math.min(Math.ceil(quantity / 2), Math.max(1, lot.quantity - lot.reserved))) });
    for (const shipment of state.shipments.filter(s => s.itemId === order.itemId && s.warehouseId === order.warehouseId)) sources.push({ type: 'expedite', sourceId: shipment.id, quantity });
    for (const supplier of state.suppliers.filter(s => s.tier === 1 && s.components.includes(order.itemId))) sources.push({ type: 'alternative_supplier', sourceId: supplier.id, quantity });
    for (const source of sources) {
      const evidenceIds = [...new Set([incident.id, order.id, source.sourceId, ...sourceEvidence(state, [incident.entityId, source.sourceId, ...state.shipments.filter(s => s.warehouseId === order.warehouseId).map(s => s.supplierId)])])];
      const plan: RecoveryPlan = { id: nextId(state, 'plan'), incidentId, orderId: order.id, ...source, arrivesAt: state.clock, costCents: 0, feasible: false, reasons: [], status: 'proposed', createdBy: actor.id, version: 1, rationale: 'Deterministic candidate grounded in current source evidence; awaiting independent human review', evidenceIds, inventoryVersion: state.version };
      const result = constraints(state, plan); Object.assign(plan, result, { feasible: !result.reasons.length });
      plan.rationale = `${plan.type}: ${plan.quantity} units for ${order.customer}; ${plan.feasible ? 'current constraints pass' : result.reasons.join('; ')}. Arrival is simulated; no external booking. Split options cover only their stated first leg.`;
      state.plans.push(plan); plans.push(plan); audit(state, actor, 'plan_proposed', plan.id, plan.rationale, evidenceIds, undefined, plan);
    }
  }
  return plans.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.costCents - b.costCents);
}
export function decidePlan(state: State, id: string, action: PlanAction, actor: Actor): RecoveryPlan {
  const plan = find(state.plans, id, 'Plan');
  if (!action || !['approve', 'reject', 'modify'].includes(action.action)) throw new DomainError('Unknown plan action');
  if (action.action === 'approve') {
    requireFocal(actor, plan.type === 'alternative_supplier' ? ['procurement', 'admin'] : ['manager', 'admin']);
    if (actor.id === plan.createdBy || (plan.lastModifiedBy && actor.id === plan.lastModifiedBy)) throw new DomainError('Self-approval is prohibited, including administrators', 403);
    if (action.confirmed !== true) throw new DomainError('Explicit confirmation is required before simulated execution', 400);
  } else requireFocal(actor, ['analyst', 'manager', 'procurement', 'admin']);
  if (plan.status === 'executed' || plan.status === 'approved' || plan.status === 'rejected') throw new DomainError(`A ${plan.status} plan cannot be changed`, 409);
  const before = structuredClone(plan);
  if (action.action === 'reject') { plan.status = 'rejected'; audit(state, actor, 'plan_rejected', id, 'Human reviewer rejected this proposal', plan.evidenceIds, before, plan); return plan; }
  if (action.action === 'modify') {
    if (!integer(action.quantity) || action.quantity <= 0) throw new DomainError('Modified quantity must be a positive safe integer');
    plan.quantity = action.quantity; plan.version += 1; delete plan.approver; plan.status = 'proposed';
    plan.lastModifiedBy = actor.id;
    const result = constraints(state, plan); Object.assign(plan, result, { feasible: !result.reasons.length, inventoryVersion: state.version });
    plan.rationale = `Modified by ${actor.name}; previous approval invalidated. ${plan.feasible ? 'Current constraints pass' : plan.reasons.join('; ')}`;
    audit(state, actor, 'plan_modified', id, plan.rationale, plan.evidenceIds, before, plan); return plan;
  }
  const result = constraints(state, plan);
  if (result.reasons.length) {
    // Preserve the failed validation as evidence without consuming any operational resource.
    Object.assign(plan, result, { feasible: false, status: 'stale' });
    audit(state, actor, 'plan_revalidation_failed', id, result.reasons.join('; '), plan.evidenceIds, before, plan);
    throw new DomainError(`Plan no longer feasible: ${result.reasons.join('; ')}`, 409);
  }
  const order = find(state.orders, plan.orderId, 'Order'); const warehouse = find(state.warehouses, order.warehouseId, 'Warehouse');
  const operationBefore = { order: structuredClone(order), warehouse: structuredClone(warehouse), source: structuredClone([...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId)) };
  Object.assign(plan, result, { feasible: true, status: 'approved', approver: actor.id, inventoryVersion: state.version });
  audit(state, actor, 'plan_approved', id, 'Independent approval and explicit execution confirmation received; current rules revalidated', plan.evidenceIds, before, plan);
  if (plan.type === 'reallocate' || plan.type === 'split_order') { const lot = find(state.lots, plan.sourceId, 'Lot'); lot.quantity -= plan.quantity; lot.version += 1; }
  if (plan.type === 'alternative_supplier') find(state.suppliers, plan.sourceId, 'Supplier').capacity -= plan.quantity;
  warehouse.capacity -= plan.quantity; order.fulfilled += plan.quantity; order.status = order.fulfilled >= order.quantity ? 'fulfilled' : 'recovering'; plan.status = 'executed';
  if (plan.type === 'expedite') { const shipment = find(state.shipments, plan.sourceId, 'Shipment'); if (availableShipment(state, shipment) === 0) shipment.status = 'delivered'; }
  const incident = find(state.incidents, plan.incidentId, 'Incident'); incident.status = incident.affectedOrderIds.every(oid => state.orders.find(o => o.id === oid)?.status === 'fulfilled') ? 'resolved' : 'recovering';
  audit(state, actor, 'plan_executed', id, `Simulated ${plan.type}: ${plan.quantity} units allocated, projected arrival ${plan.arrivesAt}; finite resources consumed`, plan.evidenceIds, operationBefore, { order, warehouse, plan, source: [...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId) });
  state.notifications.push({ id: nextId(state, 'notification'), at: state.clock, incidentId: incident.id, message: `Recovery confirmed for ${order.customer}: ${plan.quantity} units (${order.status})`, read: false, orgId: 'focal' });
  return plan;
}
