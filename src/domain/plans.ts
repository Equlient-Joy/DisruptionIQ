import type { Actor, PlanAction, PlanRisk, PlanType, RecoveryCandidate, RecoveryPlan, RecoveryPlanner, State } from '../shared/types';
import { atHours, audit, DomainError, find, integer, nextId, requireFocal, sourceEvidence, upstreamPaths, validTime } from './common';
import { availableShipment, getImpact } from './impact';

export const HIGH_RISK_COST_CENTS = typeof process !== 'undefined' && process.env?.HIGH_RISK_COST_CENTS ? Number(process.env.HIGH_RISK_COST_CENTS) : 200_000;
export const HIGH_RISK_PENALTY_CENTS = typeof process !== 'undefined' && process.env?.HIGH_RISK_PENALTY_CENTS ? Number(process.env.HIGH_RISK_PENALTY_CENTS) : 500_000;

export function classifyPlanRisk(
  state: State,
  candidate: { orderId: string; type: PlanType; sourceId: string; quantity: number; costCents: number; riskLevel?: PlanRisk },
): PlanRisk {
  if (candidate.riskLevel) return candidate.riskLevel;

  // 1. Plan type changes to an alternative supplier
  if (candidate.type === 'alternative_supplier') return 'high';

  // 2. Incremental cost >= HIGH_RISK_COST_CENTS
  if (candidate.costCents >= HIGH_RISK_COST_CENTS) return 'high';

  // 3. Linked order penalty >= HIGH_RISK_PENALTY_CENTS
  const order = state.orders.find(o => o.id === candidate.orderId);
  if (order && typeof order.penaltyCents === 'number' && order.penaltyCents >= HIGH_RISK_PENALTY_CENTS) {
    return 'high';
  }

  // 4. Linked impact score is >= 7.0 or evidence confidence is 'low'
  const impacts = getImpact(state);
  const impact = impacts.find(i => i.orderId === candidate.orderId);
  if (impact) {
    if (impact.score >= 7.0) return 'high';
    if (impact.confidence === 'low') return 'high';
  }

  // 5. Execution consumes at least 50% of the source's currently usable stock/capacity
  if (candidate.type === 'reallocate' || candidate.type === 'split_order') {
    const lot = state.lots.find(l => l.id === candidate.sourceId);
    if (lot) {
      const usable = Math.max(0, lot.quantity - lot.reserved);
      if (usable <= 0 || candidate.quantity >= 0.5 * usable) return 'high';
    }
  } else if (candidate.type === 'expedite') {
    const shipment = state.shipments.find(s => s.id === candidate.sourceId);
    if (shipment) {
      const avail = availableShipment(state, shipment);
      if (avail <= 0 || candidate.quantity >= 0.5 * avail) return 'high';
    }
  }

  return 'routine';
}

export interface FeasibilityResult {
  arrivesAt: string;
  costCents: number;
  feasible: boolean;
  onTime: boolean;
  reasons: string[];
}

export function evaluateCandidateConstraints(
  state: State,
  candidate: { orderId: string; type: PlanType; sourceId: string; quantity: number },
  orderDeadline?: string,
): FeasibilityResult {
  const reasons: string[] = [];
  const order = state.orders.find(o => o.id === candidate.orderId);
  let arrivesAt = atHours(state, 8);
  let costCents = 0;

  if (!order) {
    return { arrivesAt, costCents, feasible: false, onTime: false, reasons: ['Order reference missing; feasibility cannot be established'] };
  }

  const deadline = orderDeadline || order.deadline;
  const remaining = order.quantity - order.fulfilled;

  if (!integer(candidate.quantity) || candidate.quantity <= 0) {
    reasons.push('Quantity must be a positive safe integer');
  }
  if (candidate.quantity > remaining) {
    reasons.push(`Only ${remaining} unfulfilled order units remain`);
  }

  const warehouse = state.warehouses.find(w => w.id === order.warehouseId);
  if (!warehouse || !integer(warehouse.capacity)) {
    reasons.push('Receiving capacity evidence missing');
  } else {
    if (warehouse.status !== 'online') reasons.push(`${warehouse.name} is in outage; receiving unavailable`);
    if (warehouse.capacity < candidate.quantity) reasons.push(`Receiving capacity ${warehouse.capacity} units is below requested ${candidate.quantity}`);
  }

  if (candidate.type === 'reallocate' || candidate.type === 'split_order') {
    const lot = state.lots.find(l => l.id === candidate.sourceId);
    if (!lot) {
      reasons.push('Source lot evidence missing');
    } else {
      const sourceWarehouse = state.warehouses.find(w => w.id === lot.warehouseId);
      if (lot.itemId !== order.itemId) reasons.push('Source item does not match customer order');
      if (lot.status !== 'available') reasons.push(`Lot ${lot.id} is ${lot.status}; stock excluded`);
      if (sourceWarehouse?.status !== 'online') reasons.push(`Source warehouse ${lot.warehouseId} is unavailable`);
      if (!integer(lot.quantity) || !integer(lot.reserved)) {
        reasons.push('Usable stock and hard commitments evidence missing');
      } else if (lot.quantity - lot.reserved < candidate.quantity) {
        reasons.push(`Only ${Math.max(0, lot.quantity - lot.reserved)} usable units after ${lot.reserved} hard commitments`);
      }
      arrivesAt = atHours(state, lot.warehouseId === order.warehouseId ? 2 : candidate.type === 'split_order' ? 6 : 8);
      costCents = candidate.quantity * (candidate.type === 'split_order' ? 650 : 400);
    }
    if (candidate.type === 'split_order' && candidate.quantity >= remaining) {
      reasons.push('Split recovery must leave a positive remainder for a later leg');
    }
  } else if (candidate.type === 'expedite') {
    const shipment = state.shipments.find(s => s.id === candidate.sourceId);
    if (!shipment) {
      reasons.push('Shipment evidence missing');
    } else {
      if (shipment.itemId !== order.itemId) reasons.push('Shipment item does not match customer order');
      if (!validTime(shipment.eta) || !shipment.etaHistory.length) reasons.push('ETA or transit evidence missing; express feasibility unknown');
      if (shipment.status === 'scheduled' || shipment.status === 'delivered') reasons.push('Express route requires an outstanding shipment already in transit');
      const available = availableShipment(state, shipment);
      if (available < candidate.quantity) reasons.push(`Only ${available} uncommitted shipment units remain`);
      arrivesAt = validTime(shipment.eta) ? new Date(Math.max(Date.parse(state.clock) + 8 * 3_600_000, Date.parse(shipment.eta) - 36 * 3_600_000)).toISOString() : state.clock;
      if (shipment.lotId && state.lots.find(l => l.id === shipment.lotId)?.status !== 'available') reasons.push('Linked shipment lot is under quality hold or disputed');
      costCents = candidate.quantity * 2400;
    }
  } else if (candidate.type === 'alternative_supplier') {
    const supplier = state.suppliers.find(s => s.id === candidate.sourceId);
    if (!supplier) {
      reasons.push('Alternate supplier evidence missing');
    } else {
      if (!supplier.approved) reasons.push(`${supplier.name} is not an approved supplier`);
      if (!supplier.components.includes(order.itemId)) reasons.push('Supplier is not eligible for the order item');
      if (!integer(supplier.capacity) || !integer(supplier.minOrder) || !integer(supplier.unitCostCents) || !integer(supplier.leadHours)) {
        reasons.push('Supplier capacity, minimum, price or lead-time evidence missing');
      }
      if (candidate.quantity < supplier.minOrder) reasons.push(`Minimum order ${supplier.minOrder} exceeds requested ${candidate.quantity}`);
      if (supplier.capacity < candidate.quantity) reasons.push(`Supplier remaining capacity ${supplier.capacity} is below requested ${candidate.quantity}`);
      const upstream = new Set(upstreamPaths(state, supplier.id).flat());
      const disrupted = state.incidents.filter(i => i.type === 'supplier_delay' && i.status === 'active' && upstream.has(i.entityId));
      const delay = disrupted.reduce((n, i) => Math.max(n, ...state.events.filter(e => e.entityId === i.entityId && e.type === 'supplier_delay' && e.status === 'accepted').map(e => typeof e.payload.delayHours === 'number' ? e.payload.delayHours : 0)), 0);
      arrivesAt = integer(supplier.leadHours) ? atHours(state, supplier.leadHours + delay) : state.clock;
      costCents = integer(supplier.unitCostCents) ? candidate.quantity * supplier.unitCostCents : 0;
      if (disrupted.length) reasons.push('Alternate source shares an active disrupted upstream dependency');
    }
  } else {
    reasons.push('Unsupported recovery type');
  }

  if (!Number.isSafeInteger(costCents) || costCents < 0) reasons.push('Cost exceeds safe integer minor-unit bounds');

  const onTime = validTime(deadline) && validTime(arrivesAt) && Date.parse(arrivesAt) <= Date.parse(deadline);
  if (!validTime(deadline) || !validTime(arrivesAt)) {
    reasons.push('Deadline or arrival evidence missing');
  } else if (Date.parse(arrivesAt) > Date.parse(deadline)) {
    reasons.push(`Arrival ${arrivesAt} misses deadline ${deadline}`);
  }

  return { arrivesAt, costCents, feasible: reasons.length === 0, onTime, reasons };
}

export class DeterministicTemplatePlanner implements RecoveryPlanner {
  readonly name = 'DeterministicTemplatePlanner';

  generateCandidates(state: State, _incidentId: string, orderId: string, shortage?: number): RecoveryCandidate[] {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return [];
    const quantity = shortage !== undefined ? shortage : Math.max(0, order.quantity - order.fulfilled);
    if (quantity <= 0) return [];

    const candidates: RecoveryCandidate[] = [];
    const lots = state.lots.filter(l => l.itemId === order.itemId && l.warehouseId !== order.warehouseId);
    for (const lot of lots) {
      candidates.push({ type: 'reallocate', sourceId: lot.id, quantity });
      candidates.push({
        type: 'split_order',
        sourceId: lot.id,
        quantity: Math.max(1, Math.min(Math.ceil(quantity / 2), Math.max(1, lot.quantity - lot.reserved))),
      });
    }
    for (const shipment of state.shipments.filter(s => s.itemId === order.itemId && s.warehouseId === order.warehouseId)) {
      candidates.push({ type: 'expedite', sourceId: shipment.id, quantity });
    }
    for (const supplier of state.suppliers.filter(s => s.tier === 1 && s.components.includes(order.itemId))) {
      candidates.push({ type: 'alternative_supplier', sourceId: supplier.id, quantity });
    }
    return candidates;
  }
}

export const defaultRecoveryPlanner = new DeterministicTemplatePlanner();

export function constraints(state: State, plan: RecoveryPlan): FeasibilityResult {
  return evaluateCandidateConstraints(state, plan);
}

export function generatePlans(state: State, incidentId: string, actor: Actor, planner: RecoveryPlanner = defaultRecoveryPlanner): RecoveryPlan[] {
  requireFocal(actor, ['analyst', 'manager', 'procurement', 'admin']);
  const incident = find(state.incidents, incidentId, 'Incident');
  if (incident.status === 'resolved') throw new DomainError('Resolved incidents do not need new recovery plans', 409);
  const plans: RecoveryPlan[] = [];

  for (const impact of getImpact(state).filter(i => incident.affectedOrderIds.includes(i.orderId) && i.shortage > 0)) {
    const order = find(state.orders, impact.orderId, 'Order');
    const sources = planner.generateCandidates(state, incidentId, order.id, impact.shortage);

    for (const source of sources) {
      const evidenceIds = [...new Set([
        incident.id,
        order.id,
        source.sourceId,
        ...sourceEvidence(state, [
          incident.entityId,
          source.sourceId,
          ...state.shipments.filter(s => s.warehouseId === order.warehouseId).map(s => s.supplierId),
        ]),
      ])];

      const plan: RecoveryPlan = {
        id: nextId(state, 'plan'),
        incidentId,
        orderId: order.id,
        ...source,
        arrivesAt: state.clock,
        costCents: 0,
        feasible: false,
        reasons: [],
        status: 'proposed',
        createdBy: actor.id,
        version: 1,
        approvals: [],
        rationale: 'Candidate grounded in current source evidence; awaiting review',
        evidenceIds,
        inventoryVersion: state.version,
      };

      const result = evaluateCandidateConstraints(state, plan);
      Object.assign(plan, result, { feasible: result.feasible });
      plan.riskLevel = classifyPlanRisk(state, plan);
      plan.rationale = `${plan.type}: ${plan.quantity} units for ${order.customer}; [${plan.riskLevel.toUpperCase()} RISK]; ${plan.feasible ? 'current constraints pass' : result.reasons.join('; ')}. Arrival is simulated; no external booking. Split options cover only their stated first leg.`;

      state.plans.push(plan);
      plans.push(plan);
      audit(state, actor, 'plan_proposed', plan.id, plan.rationale, evidenceIds, undefined, plan);
    }
  }
  return plans.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.costCents - b.costCents);
}

function executePlanAtomic(
  state: State,
  plan: RecoveryPlan,
  actor: Actor,
  before: RecoveryPlan,
  operationBefore: { order: unknown; warehouse: unknown; source: unknown },
  actionType: 'plan_approved' | 'plan_break_glass_executed',
  actionDetail: string,
) {
  const order = find(state.orders, plan.orderId, 'Order');
  const warehouse = find(state.warehouses, order.warehouseId, 'Warehouse');

  if (plan.type === 'reallocate' || plan.type === 'split_order') {
    const lot = find(state.lots, plan.sourceId, 'Lot');
    lot.quantity -= plan.quantity;
    lot.version += 1;
  }
  if (plan.type === 'alternative_supplier') {
    find(state.suppliers, plan.sourceId, 'Supplier').capacity -= plan.quantity;
  }
  warehouse.capacity -= plan.quantity;
  order.fulfilled += plan.quantity;
  order.status = order.fulfilled >= order.quantity ? 'fulfilled' : 'recovering';
  plan.status = 'executed';

  if (plan.type === 'expedite') {
    const shipment = find(state.shipments, plan.sourceId, 'Shipment');
    if (availableShipment(state, shipment) === 0) shipment.status = 'delivered';
  }

  const incident = state.incidents.find(i => i.id === plan.incidentId);
  if (incident) {
    incident.status = incident.affectedOrderIds.every(oid => state.orders.find(o => o.id === oid)?.status === 'fulfilled')
      ? 'resolved'
      : 'recovering';
  }

  audit(state, actor, actionType, plan.id, actionDetail, plan.evidenceIds, before, plan);
  audit(
    state,
    actor,
    'plan_executed',
    plan.id,
    `Simulated ${plan.type}: ${plan.quantity} units allocated, projected arrival ${plan.arrivesAt}; finite resources consumed`,
    plan.evidenceIds,
    operationBefore,
    { order, warehouse, plan, source: [...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId) },
  );

  const notifMessage = plan.breakGlass
    ? `BREAK-GLASS: Plan ${plan.id} executed by administrator ${actor.name} for ${order.customer}. Retrospective review required.`
    : `Recovery confirmed for ${order.customer}: ${plan.quantity} units (${order.status})`;

  state.notifications.push({
    id: nextId(state, 'notification'),
    at: state.clock,
    incidentId: incident?.id,
    message: notifMessage,
    read: false,
    orgId: 'focal',
  });
}

export function decidePlan(state: State, id: string, action: PlanAction, actor: Actor): RecoveryPlan {
  const plan = find(state.plans, id, 'Plan');
  if (!action || !['approve', 'reject', 'modify'].includes(action.action)) throw new DomainError('Unknown plan action');
  if (plan.status === 'executed' || plan.status === 'rejected') throw new DomainError(`A ${plan.status} plan cannot be changed`, 409);

  if (!plan.riskLevel) plan.riskLevel = classifyPlanRisk(state, plan);
  const before = structuredClone(plan);

  if (action.action === 'reject') {
    requireFocal(actor, ['analyst', 'manager', 'procurement', 'admin']);
    plan.status = 'rejected';
    plan.approvals = [];
    audit(state, actor, 'plan_rejected', id, 'Human reviewer rejected this proposal', plan.evidenceIds, before, plan);
    return plan;
  }

  if (action.action === 'modify') {
    requireFocal(actor, ['analyst', 'manager', 'procurement', 'admin']);
    if (!integer(action.quantity) || action.quantity <= 0) throw new DomainError('Modified quantity must be a positive safe integer');
    plan.quantity = action.quantity;
    plan.version += 1;
    delete plan.approver;
    plan.approvals = [];
    delete plan.breakGlass;
    plan.status = 'proposed';
    plan.lastModifiedBy = actor.id;
    const result = constraints(state, plan);
    Object.assign(plan, result, { feasible: !result.reasons.length, inventoryVersion: state.version });
    plan.riskLevel = classifyPlanRisk(state, { ...plan, riskLevel: undefined });
    plan.rationale = `Modified by ${actor.name}; previous approvals invalidated. [${plan.riskLevel.toUpperCase()} RISK]. ${plan.feasible ? 'Current constraints pass' : plan.reasons.join('; ')}`;
    audit(state, actor, 'plan_modified', id, plan.rationale, plan.evidenceIds, before, plan);
    return plan;
  }

  // action.action === 'approve'
  // 1. Break-glass emergency bypass
  if (action.breakGlass) {
    if (actor.role !== 'admin' || actor.orgId !== 'focal') {
      throw new DomainError('Break-glass emergency authorization requires administrator access', 403);
    }
    if (action.confirmed !== true) {
      throw new DomainError('Explicit confirmation is required for break-glass execution', 400);
    }
    if (!action.breakGlassReason || typeof action.breakGlassReason !== 'string' || action.breakGlassReason.trim().length < 20) {
      throw new DomainError('A non-trivial justification of at least 20 characters is required for break-glass execution', 400);
    }
    const result = constraints(state, plan);
    if (result.reasons.length) {
      Object.assign(plan, result, { feasible: false, status: 'stale' });
      audit(state, actor, 'plan_revalidation_failed', id, result.reasons.join('; '), plan.evidenceIds, before, plan);
      throw new DomainError(`Plan no longer feasible: ${result.reasons.join('; ')}`, 409);
    }

    const order = find(state.orders, plan.orderId, 'Order');
    const warehouse = find(state.warehouses, order.warehouseId, 'Warehouse');
    const operationBefore = {
      order: structuredClone(order),
      warehouse: structuredClone(warehouse),
      source: structuredClone([...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId)),
    };

    plan.breakGlass = {
      actorId: actor.id,
      at: state.clock,
      reason: action.breakGlassReason.trim(),
      reviewStatus: 'required',
    };
    plan.approvals = [
      ...(plan.approvals || []).filter(a => a.version === plan.version),
      { approverId: actor.id, role: actor.role, at: state.clock, version: plan.version },
    ];
    plan.approver = actor.id;
    Object.assign(plan, result, { feasible: true, status: 'approved', inventoryVersion: state.version });

    executePlanAtomic(
      state,
      plan,
      actor,
      before,
      operationBefore,
      'plan_break_glass_executed',
      `Break-glass executed by admin ${actor.name}: ${action.breakGlassReason.trim()}`,
    );
    return plan;
  }

  // 2. Regular authorization
  requireFocal(actor, plan.type === 'alternative_supplier' ? ['procurement', 'admin'] : ['manager', 'admin']);

  if (plan.riskLevel === 'routine') {
    if (action.confirmed !== true) {
      throw new DomainError('Explicit confirmation is required before simulated execution', 400);
    }
    const result = constraints(state, plan);
    if (result.reasons.length) {
      Object.assign(plan, result, { feasible: false, status: 'stale' });
      audit(state, actor, 'plan_revalidation_failed', id, result.reasons.join('; '), plan.evidenceIds, before, plan);
      throw new DomainError(`Plan no longer feasible: ${result.reasons.join('; ')}`, 409);
    }

    const order = find(state.orders, plan.orderId, 'Order');
    const warehouse = find(state.warehouses, order.warehouseId, 'Warehouse');
    const operationBefore = {
      order: structuredClone(order),
      warehouse: structuredClone(warehouse),
      source: structuredClone([...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId)),
    };

    plan.approvals = [
      ...(plan.approvals || []).filter(a => a.version === plan.version),
      { approverId: actor.id, role: actor.role, at: state.clock, version: plan.version },
    ];
    plan.approver = actor.id;
    Object.assign(plan, result, { feasible: true, status: 'approved', inventoryVersion: state.version });

    executePlanAtomic(
      state,
      plan,
      actor,
      before,
      operationBefore,
      'plan_approved',
      'Routine plan approved; current rules revalidated',
    );
    return plan;
  }

  // 3. High-risk authorization
  if (actor.id === plan.createdBy || (plan.lastModifiedBy && actor.id === plan.lastModifiedBy)) {
    throw new DomainError('Self-approval is prohibited for high-risk actions; an independent authorized approver is required', 403);
  }

  const existingApprovals = (plan.approvals || []).filter(a => a.version === plan.version);
  if (existingApprovals.some(a => a.approverId === actor.id)) {
    throw new DomainError('An independent second approver is required; the same reviewer cannot approve twice', 400);
  }

  if (existingApprovals.length === 0) {
    // First high-risk approval
    if (action.confirmed !== true) {
      throw new DomainError('Explicit confirmation is required before recording approval', 400);
    }
    const result = constraints(state, plan);
    if (result.reasons.length) {
      Object.assign(plan, result, { feasible: false, status: 'stale' });
      audit(state, actor, 'plan_revalidation_failed', id, result.reasons.join('; '), plan.evidenceIds, before, plan);
      throw new DomainError(`Plan no longer feasible: ${result.reasons.join('; ')}`, 409);
    }

    plan.approvals = [
      ...existingApprovals,
      { approverId: actor.id, role: actor.role, at: state.clock, version: plan.version },
    ];
    plan.status = 'awaiting_second_approval';
    audit(
      state,
      actor,
      'plan_first_approval',
      id,
      `First independent approval recorded by ${actor.name}; awaiting second approval before execution`,
      plan.evidenceIds,
      before,
      plan,
    );
    state.notifications.push({
      id: nextId(state, 'notification'),
      at: state.clock,
      incidentId: plan.incidentId,
      message: `High-risk recovery plan ${plan.id} received first approval from ${actor.name}. Second approval required.`,
      read: false,
      orgId: 'focal',
    });
    return plan;
  }

  // Second high-risk approval -> execution
  if (action.confirmed !== true) {
    throw new DomainError('Explicit confirmation is required before simulated execution', 400);
  }
  const result = constraints(state, plan);
  if (result.reasons.length) {
    Object.assign(plan, result, { feasible: false, status: 'stale' });
    audit(state, actor, 'plan_revalidation_failed', id, result.reasons.join('; '), plan.evidenceIds, before, plan);
    throw new DomainError(`Plan no longer feasible: ${result.reasons.join('; ')}`, 409);
  }

  const order = find(state.orders, plan.orderId, 'Order');
  const warehouse = find(state.warehouses, order.warehouseId, 'Warehouse');
  const operationBefore = {
    order: structuredClone(order),
    warehouse: structuredClone(warehouse),
    source: structuredClone([...state.lots, ...state.shipments, ...state.suppliers].find(s => s.id === plan.sourceId)),
  };

  plan.approvals = [
    ...existingApprovals,
    { approverId: actor.id, role: actor.role, at: state.clock, version: plan.version },
  ];
  plan.approver = actor.id;
  Object.assign(plan, result, { feasible: true, status: 'approved', inventoryVersion: state.version });

  executePlanAtomic(
    state,
    plan,
    actor,
    before,
    operationBefore,
    'plan_approved',
    'Second independent approval and explicit confirmation received; current rules revalidated',
  );
  return plan;
}
