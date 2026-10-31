import type { LotStatus, PlanType, Shipment, SimulationDiff, State } from '../../shared/types';
import { getImpact } from '../../domain/impact';
import { DeterministicTemplatePlanner, evaluateCandidateConstraints } from '../../domain/plans';

export interface WhatIfParams {
  entityType: 'shipment' | 'supplier' | 'warehouse' | 'lot';
  entityId: string;
  delta: {
    delayHours?: number;
    status?: string;
    quantity?: number;
  };
}

/**
 * Deterministic What-If Simulation Engine
 * Runs completely in-memory on a structuredClone of the state.
 * Never mutates real operational state or database records.
 */
export async function simulateWhatIfScenario(
  state: State,
  params: WhatIfParams
): Promise<SimulationDiff> {
  // 1. In-memory deep clone to guarantee zero state mutation
  const clonedState: State = structuredClone(state);

  // 2. Build scenario description and apply synthetic change to cloned state
  const deltaParts: string[] = [];
  if (params.delta.delayHours !== undefined) {
    deltaParts.push(`delay +${params.delta.delayHours}h`);
  }
  if (params.delta.status !== undefined) {
    deltaParts.push(`status = ${params.delta.status}`);
  }
  if (params.delta.quantity !== undefined) {
    deltaParts.push(`qty = ${params.delta.quantity}`);
  }

  let scenarioDescription = `${params.entityType.toUpperCase()} ${params.entityId}`;
  if (deltaParts.length > 0) {
    scenarioDescription += ` (${deltaParts.join(', ')})`;
  } else {
    scenarioDescription += ' (no delta)';
  }

  // 3. Apply changes based on entityType
  if (params.entityType === 'shipment') {
    const shipment = clonedState.shipments.find(s => s.id === params.entityId);
    if (shipment) {
      if (params.delta.delayHours !== undefined && params.delta.delayHours !== 0) {
        const currentEtaMs = Date.parse(shipment.eta) || Date.parse(clonedState.clock);
        const newEta = new Date(currentEtaMs + params.delta.delayHours * 3_600_000).toISOString();
        shipment.eta = newEta;
        shipment.etaHistory.push({
          eta: newEta,
          at: clonedState.clock,
          source: 'what_if_simulation',
        });
        if (params.delta.delayHours > 0 && shipment.status === 'scheduled') {
          shipment.status = 'delayed';
        }
      }
      if (params.delta.status) {
        shipment.status = params.delta.status as Shipment['status'];
      }
      if (params.delta.quantity !== undefined) {
        shipment.quantity = params.delta.quantity;
      }
    }
  } else if (params.entityType === 'warehouse') {
    const warehouse = clonedState.warehouses.find(w => w.id === params.entityId);
    if (warehouse) {
      if (params.delta.status) {
        warehouse.status = params.delta.status as 'online' | 'outage';
      }
      if (params.delta.quantity !== undefined) {
        warehouse.capacity = params.delta.quantity;
      }
    }
  } else if (params.entityType === 'lot') {
    const lot = clonedState.lots.find(l => l.id === params.entityId);
    if (lot) {
      if (params.delta.status) {
        lot.status = params.delta.status as LotStatus;
      }
      if (params.delta.quantity !== undefined) {
        lot.quantity = params.delta.quantity;
      }
    }
  } else if (params.entityType === 'supplier') {
    const supplier = clonedState.suppliers.find(s => s.id === params.entityId);
    if (supplier) {
      if (params.delta.delayHours !== undefined && params.delta.delayHours !== 0) {
        supplier.leadHours = supplier.leadHours + params.delta.delayHours;
        // Also apply ETA delay to any active inbound shipments from this supplier
        for (const s of clonedState.shipments.filter(sh => sh.supplierId === supplier.id && sh.status !== 'delivered')) {
          const currentEtaMs = Date.parse(s.eta) || Date.parse(clonedState.clock);
          const newEta = new Date(currentEtaMs + params.delta.delayHours * 3_600_000).toISOString();
          s.eta = newEta;
          s.etaHistory.push({
            eta: newEta,
            at: clonedState.clock,
            source: 'what_if_simulation',
          });
        }
      }
      if (params.delta.status) {
        if (['outage', 'inactive', 'unapproved', 'disrupted'].includes(params.delta.status)) {
          supplier.approved = false;
        } else if (['online', 'approved', 'active'].includes(params.delta.status)) {
          supplier.approved = true;
        }
      }
      if (params.delta.quantity !== undefined) {
        supplier.capacity = params.delta.quantity;
      }
    }
  }

  // 4. Re-evaluate impact with pure getImpact(simulatedState) vs getImpact(state)
  const baselineImpacts = getImpact(state);
  const simulatedImpacts = getImpact(clonedState);

  // Baseline metrics
  const baselineExposedImpacts = baselineImpacts.filter(i => i.shortage > 0);
  const baselineExposedOrders = baselineExposedImpacts.length;
  const baselineTotalShortage = baselineImpacts.reduce((sum, i) => sum + i.shortage, 0);

  // Simulated metrics
  const simulatedExposedImpacts = simulatedImpacts.filter(i => i.shortage > 0);
  const simulatedExposedOrders = simulatedExposedImpacts.length;
  const simulatedTotalShortage = simulatedImpacts.reduce((sum, i) => sum + i.shortage, 0);

  // Diff deltas
  const deltaExposedOrders = simulatedExposedOrders - baselineExposedOrders;
  const deltaShortage = simulatedTotalShortage - baselineTotalShortage;

  // Identify newly breached orders (orders where baseline shortage was 0 or not exposed, but simulated shortage > 0)
  const baselineMap = new Map(baselineImpacts.map(i => [i.orderId, i]));
  const newlyBreachedOrders: { orderId: string; customer: string; hoursToDeadline: number }[] = [];

  for (const sim of simulatedExposedImpacts) {
    const base = baselineMap.get(sim.orderId);
    if (!base || base.shortage === 0) {
      const order = clonedState.orders.find(o => o.id === sim.orderId);
      const hoursToDeadline = sim.hoursRemaining !== undefined
        ? sim.hoursRemaining
        : order
          ? Math.round(((Date.parse(order.deadline) - Date.parse(clonedState.clock)) / 3_600_000) * 10) / 10
          : 0;

      newlyBreachedOrders.push({
        orderId: sim.orderId,
        customer: order?.customer || 'Unknown Customer',
        hoursToDeadline,
      });
    }
  }

  // 5. Evaluate feasible recovery options for simulated shortages across the FOUR canonical strategies
  const planner = new DeterministicTemplatePlanner();
  let feasibleRecoveryCount = 0;
  const feasibleOptions: { type: PlanType; costCents: number; arrivesAt: string }[] = [];

  const strategyEvaluations: Record<PlanType, {
    viable: boolean;
    candidateCount: number;
    bestCostCents?: number;
    bestArrivesAt?: string;
    reasons: Set<string>;
  }> = {
    reallocate: { viable: false, candidateCount: 0, reasons: new Set() },
    expedite: { viable: false, candidateCount: 0, reasons: new Set() },
    alternative_supplier: { viable: false, candidateCount: 0, reasons: new Set() },
    split_order: { viable: false, candidateCount: 0, reasons: new Set() },
  };

  for (const sim of simulatedExposedImpacts) {
    const candidates = planner.generateCandidates(clonedState, '', sim.orderId, sim.shortage);
    for (const c of candidates) {
      if (strategyEvaluations[c.type]) {
        strategyEvaluations[c.type].candidateCount++;
      }
      const evalRes = evaluateCandidateConstraints(clonedState, {
        orderId: sim.orderId,
        type: c.type,
        sourceId: c.sourceId,
        quantity: c.quantity,
      });

      if (evalRes.feasible && evalRes.onTime) {
        feasibleRecoveryCount++;
        feasibleOptions.push({
          type: c.type,
          costCents: evalRes.costCents,
          arrivesAt: evalRes.arrivesAt,
        });
        if (strategyEvaluations[c.type]) {
          strategyEvaluations[c.type].viable = true;
          const currentBest = strategyEvaluations[c.type].bestCostCents;
          if (currentBest === undefined || evalRes.costCents < currentBest) {
            strategyEvaluations[c.type].bestCostCents = evalRes.costCents;
            strategyEvaluations[c.type].bestArrivesAt = evalRes.arrivesAt;
          }
        }
      } else if (strategyEvaluations[c.type]) {
        for (const r of evalRes.reasons) strategyEvaluations[c.type].reasons.add(r);
      }
    }
  }

  // Pick recommended plan type: lowest cost feasible candidate
  let recommendedPlanType: string | undefined = undefined;
  if (feasibleOptions.length > 0) {
    feasibleOptions.sort((a, b) => a.costCents - b.costCents || a.type.localeCompare(b.type));
    recommendedPlanType = feasibleOptions[0].type;
  }

  const strategyLabels: Record<PlanType, string> = {
    reallocate: 'Inventory Reallocation',
    expedite: 'Shipment Expediting',
    alternative_supplier: 'Alternative Suppliers',
    split_order: 'Split Orders',
  };

  const strategyComparison = (['reallocate', 'expedite', 'alternative_supplier', 'split_order'] as PlanType[]).map(type => {
    const s = strategyEvaluations[type];
    return {
      strategy: type,
      strategyName: strategyLabels[type],
      feasible: s.viable,
      candidateCount: s.candidateCount,
      bestCostCents: s.bestCostCents,
      bestArrivesAt: s.bestArrivesAt,
      rejectionReasons: Array.from(s.reasons),
    };
  });

  const hasShortage = simulatedExposedImpacts.length > 0 || simulatedTotalShortage > 0;
  const warning =
    feasibleRecoveryCount === 0 && hasShortage
      ? 'WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption.'
      : undefined;

  const suggestedAlternatives =
    feasibleRecoveryCount === 0 && hasShortage
      ? [
          'Renegotiate customer delivery deadline or request SLA grace window',
          'Re-sequence factory production schedules to assemble unaffected product lines',
          'Fast-track emergency qualification of alternate non-tier-1 or spot-market suppliers',
          'Propose partial shipment fulfillment with remaining units backordered',
          'Authorize manufacturing overtime / extra shifts to compress assembly cycle',
        ]
      : undefined;

  return {
    entityType: params.entityType,
    entityId: params.entityId,
    scenarioDescription,
    baselineExposedOrders,
    simulatedExposedOrders,
    deltaExposedOrders,
    baselineTotalShortage,
    simulatedTotalShortage,
    deltaShortage,
    newlyBreachedOrders,
    feasibleRecoveryCount,
    recommendedPlanType,
    strategyComparison,
    warning,
    suggestedAlternatives,
  };
}
