import type { EvidenceConfidence, FactorScoreBreakdown, Impact, RiskBand, Shipment, State } from '../shared/types';
import { upstreamPaths } from './common';
import { DeterministicTemplatePlanner, evaluateCandidateConstraints } from './plans';

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
    const items = inventory.get(lot.warehouseId)!;
    items.set(lot.itemId, (items.get(lot.itemId) ?? 0) + Math.max(0, lot.quantity - lot.reserved));
  }
  const inbound = new Map(state.shipments.map(s => [s.id, availableShipment(state, s)]));
  const results: Impact[] = [];
  const orders = [...state.orders]
    .filter(o => o.status !== 'fulfilled' && o.fulfilled < o.quantity)
    .sort((a, b) => priority[b.priority] - priority[a.priority] || Date.parse(a.deadline) - Date.parse(b.deadline) || a.id.localeCompare(b.id));

  const planner = new DeterministicTemplatePlanner();

  for (const order of orders) {
    const needed = Math.max(0, order.quantity - order.fulfilled);
    let missing = needed;
    const items = inventory.get(order.warehouseId);
    const covered = Math.min(missing, items?.get(order.itemId) ?? 0);
    missing -= covered;
    items?.set(order.itemId, (items.get(order.itemId) ?? 0) - covered);

    const shipments = state.shipments.filter(s => s.itemId === order.itemId && s.warehouseId === order.warehouseId);
    const receiver = state.warehouses.find(w => w.id === order.warehouseId);

    for (const shipment of [...shipments].sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta))) {
      if (receiver?.status !== 'online' || Date.parse(shipment.eta) > Date.parse(order.deadline)) continue;
      const take = Math.min(missing, inbound.get(shipment.id) ?? 0);
      missing -= take;
      inbound.set(shipment.id, (inbound.get(shipment.id) ?? 0) - take);
    }

    const incidents = state.incidents.filter(i => i.status !== 'resolved' && i.affectedOrderIds.includes(order.id));
    if (!missing && !incidents.length) continue;

    const exposureRatio = missing / Math.max(1, needed);
    const hoursRemaining = Math.round(((Date.parse(order.deadline) - Date.parse(state.clock)) / 3_600_000) * 10) / 10;

    // Component 1: Uncovered demand (0.0 to 3.0)
    const rawUncovered = Math.round(3.0 * exposureRatio * 10) / 10;

    // Component 2: Deadline pressure (0.0 to 2.0)
    let deadlineMult = 0.05;
    if (hoursRemaining <= 12) deadlineMult = 1.0;
    else if (hoursRemaining <= 24) deadlineMult = 0.75;
    else if (hoursRemaining <= 72) deadlineMult = 0.4;
    else if (hoursRemaining <= 168) deadlineMult = 0.2;
    const rawDeadline = Math.round(2.0 * exposureRatio * deadlineMult * 10) / 10;

    // Component 3: Recovery feasibility (0.0 to 2.0)
    let recoveryTier = 2.0;
    let recoveryDetail = 'No recovery candidates pass deterministic constraints';
    if (missing <= 0) {
      recoveryTier = 0.0;
      recoveryDetail = 'Order demand fully covered by inventory and inbound shipments';
    } else {
      const candidates = planner.generateCandidates(state, '', order.id, missing);
      let onTimeCount = 0;
      let resourcePassCount = 0;

      for (const candidate of candidates) {
        const evalResult = evaluateCandidateConstraints(state, {
          orderId: order.id,
          type: candidate.type,
          sourceId: candidate.sourceId,
          quantity: candidate.quantity,
        });

        if (evalResult.feasible && evalResult.onTime) {
          onTimeCount++;
        }
        const nonDeadlineReasons = evalResult.reasons.filter(r => !r.includes('misses deadline'));
        if (nonDeadlineReasons.length === 0) {
          resourcePassCount++;
        }
      }

      if (onTimeCount >= 2) {
        recoveryTier = 0.0;
        recoveryDetail = `${onTimeCount} feasible on-time recovery candidates available`;
      } else if (onTimeCount === 1) {
        recoveryTier = 0.5;
        recoveryDetail = 'Exactly one feasible on-time recovery candidate available';
      } else if (resourcePassCount > 0) {
        recoveryTier = 1.5;
        recoveryDetail = 'Recovery candidates exist but none arrive before deadline';
      } else {
        recoveryTier = 2.0;
        recoveryDetail = 'No candidates pass deterministic resource constraints';
      }
    }
    const rawRecovery = Math.round(recoveryTier * exposureRatio * 10) / 10;

    // Component 4: Cascading exposure (0.0 to 1.5)
    let hasSharedUpstream = false;
    for (const shipment of shipments) {
      const upPaths = upstreamPaths(state, shipment.supplierId);
      for (const p of upPaths) {
        for (const ancestor of p) {
          if (ancestor !== shipment.supplierId) {
            const isShared = state.suppliers.some(s => s.id !== shipment.supplierId && upstreamPaths(state, s.id).some(op => op.includes(ancestor)));
            if (isShared) {
              hasSharedUpstream = true;
              break;
            }
          }
        }
      }
    }
    const linkedActiveIncidentCount = hasSharedUpstream ? Math.max(incidents.length, 2) : incidents.length;
    const rawCascading = Math.round(Math.min(1.5, 0.5 * linkedActiveIncidentCount) * exposureRatio * 10) / 10;

    // Component 5: Business consequence (0.0 to 1.5)
    const priorityBase = order.priority === 'critical' ? 0.9 : order.priority === 'high' ? 0.6 : 0.2;
    const penaltyCents = typeof order.penaltyCents === 'number' ? order.penaltyCents : 0;
    const HIGH_RISK_PENALTY_CENTS = 500000;
    const penaltyComponent = 0.6 * Math.min(1, penaltyCents / HIGH_RISK_PENALTY_CENTS);
    const businessBase = Math.min(1.5, priorityBase + penaltyComponent);
    const rawBusiness = Math.round(businessBase * exposureRatio * 10) / 10;

    // Final score and risk band
    const totalRaw = rawUncovered + rawDeadline + rawRecovery + rawCascading + rawBusiness;
    const score = Math.round(Math.min(10.0, Math.max(0.0, totalRaw)) * 10) / 10;
    const band: RiskBand = score >= 9.0 ? 'critical' : score >= 7.0 ? 'high' : score >= 4.0 ? 'moderate' : 'low';

    // Factor breakdown
    const factorScores: FactorScoreBreakdown = {
      uncoveredDemand: {
        name: 'Uncovered demand',
        score: rawUncovered,
        maxScore: 3.0,
        thresholdCrossed: missing > 0,
        detail: `${missing} of ${needed} unfulfilled units uncovered (${Math.round(exposureRatio * 100)}%)`,
      },
      deadlinePressure: {
        name: 'Deadline pressure',
        score: rawDeadline,
        maxScore: 2.0,
        thresholdCrossed: hoursRemaining <= 24 && missing > 0,
        detail: hoursRemaining <= 0 ? 'Deadline passed' : `${hoursRemaining}h to deadline`,
      },
      recoveryFeasibility: {
        name: 'Recovery feasibility',
        score: rawRecovery,
        maxScore: 2.0,
        thresholdCrossed: recoveryTier >= 1.5 && missing > 0,
        detail: recoveryDetail,
      },
      cascadingExposure: {
        name: 'Cascading exposure',
        score: rawCascading,
        maxScore: 1.5,
        thresholdCrossed: linkedActiveIncidentCount >= 2 && missing > 0,
        detail: `${linkedActiveIncidentCount} active disruption vectors affecting order`,
      },
      businessConsequence: {
        name: 'Business consequence',
        score: rawBusiness,
        maxScore: 1.5,
        thresholdCrossed: (order.priority === 'critical' || penaltyCents >= 250000) && missing > 0,
        detail: `${order.priority} priority SLA (${penaltyCents} cents penalty)`,
      },
    };

    // Drivers (max 2)
    const candidateDrivers: { label: string; weight: number }[] = [];
    if (missing > 0) {
      if (exposureRatio >= 0.5) {
        candidateDrivers.push({ label: `Critical shortage (${Math.round(exposureRatio * 100)}% uncovered)`, weight: rawUncovered + 1.2 });
      } else {
        candidateDrivers.push({ label: `Demand shortage (${missing} units)`, weight: rawUncovered });
      }
    }
    if (receiver?.status !== 'online') {
      candidateDrivers.push({ label: `Warehouse outage (${receiver?.name || order.warehouseId})`, weight: 3.5 });
    }
    if (hoursRemaining <= 12 && missing > 0) {
      candidateDrivers.push({ label: `Imminent deadline (${Math.max(0, Math.round(hoursRemaining))}h remaining)`, weight: rawDeadline + 0.9 });
    } else if (hoursRemaining <= 24 && missing > 0) {
      candidateDrivers.push({ label: `Deadline pressure (${Math.round(hoursRemaining)}h remaining)`, weight: rawDeadline + 0.3 });
    }
    if (recoveryTier === 2.0 && missing > 0) {
      candidateDrivers.push({ label: 'No feasible recovery options', weight: rawRecovery + 0.5 });
    } else if (recoveryTier === 1.5 && missing > 0) {
      candidateDrivers.push({ label: 'All recovery options miss deadline', weight: rawRecovery });
    }
    if (linkedActiveIncidentCount >= 2 && missing > 0) {
      candidateDrivers.push({ label: `Cascading disruption (${linkedActiveIncidentCount} vectors)`, weight: rawCascading });
    }
    if (order.priority === 'critical' && missing > 0) {
      candidateDrivers.push({ label: 'Critical priority customer SLA', weight: rawBusiness });
    } else if (penaltyCents >= 250000 && missing > 0) {
      candidateDrivers.push({ label: `High penalty exposure ($${Math.round(penaltyCents / 100000)}k)`, weight: rawBusiness });
    }

    const drivers = candidateDrivers
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map(d => d.label);

    // Confidence and confidence reasons
    const lowReasons: string[] = [];
    const mediumReasons: string[] = [];

    const carrierConn = state.integrations?.find(i => i.kind === 'carrier');
    const warehouseConn = state.integrations?.find(i => i.kind === 'warehouse');

    if (carrierConn && carrierConn.status !== 'online' && shipments.length > 0) {
      lowReasons.push(`Carrier integration is ${carrierConn.status}; inbound tracking unverified`);
    }
    if (warehouseConn && warehouseConn.status !== 'online') {
      lowReasons.push(`Warehouse WMS integration is ${warehouseConn.status}`);
    }
    if (!receiver) {
      lowReasons.push('Warehouse reference missing; location coverage cannot be established');
    }

    const disputedLots = state.lots.filter(l => l.itemId === order.itemId && l.warehouseId === order.warehouseId && l.status === 'disputed');
    if (disputedLots.length > 0) {
      lowReasons.push(`${disputedLots.length} disputed inventory lots require reconciliation`);
    }

    // Build paths and check shipment evidence
    const paths: string[] = [];
    const factors: string[] = [
      `${missing} units uncovered after usable local stock, hard reservations and on-time inbound allocation`,
      `${order.priority} priority; ${hoursRemaining} hours to deadline`,
      `Penalty exposure ${penaltyCents} cents`,
    ];

    if (receiver?.status !== 'online') {
      factors.push(receiver ? `${receiver.name} receiving/stock access blocked by outage` : 'Warehouse reference missing; coverage cannot be established');
    }
    const blockedLots = state.lots.filter(l => l.itemId === order.itemId && l.warehouseId === order.warehouseId && l.status !== 'available');
    if (blockedLots.length) {
      factors.push(`${blockedLots.reduce((n, l) => n + l.quantity, 0)} units excluded: held or disputed lots`);
    }

    for (const shipment of shipments) {
      paths.push(...upstreamPaths(state, shipment.supplierId).map(path => `${[...path].reverse().join(' → ')} → ${shipment.id} → ${order.warehouseId} → ${order.id}`));
      if (!state.suppliers.some(s => s.id === shipment.supplierId)) {
        lowReasons.push(`${shipment.id}: supplier reference missing; upstream exposure unknown`);
        factors.push(`${shipment.id}: supplier reference missing; upstream exposure unknown`);
      }
      if (!shipment.etaHistory.length) {
        mediumReasons.push(`${shipment.id}: insufficient ETA evidence; confidence unknown`);
        factors.push(`${shipment.id}: insufficient ETA evidence; confidence unknown`);
      } else {
        const revisionHours = shipment.etaHistory.map(r => Date.parse(r.eta) / 3_600_000);
        const spread = Math.max(...revisionHours) - Math.min(...revisionHours);
        const prior = shipment.etaHistory.filter(r => r.source !== 'Synthetic supplier-delay scenario' && r.source !== 'supplier delay rule');
        const priorHours = prior.map(r => Date.parse(r.eta) / 3_600_000);
        const volatile = priorHours.length >= 2 && Math.max(...priorHours) - Math.min(...priorHours) > 6;
        const msg = `${shipment.id}: ${volatile ? 'volatile' : shipment.etaHistory.length < 2 ? 'insufficient ETA evidence' : 'stable'} forecast history (${Math.round(spread)}h revision range); heuristic evidence only`;
        factors.push(msg);
        if (volatile) {
          mediumReasons.push(`${shipment.id}: volatile forecast history (${Math.round(spread)}h revision spread)`);
        } else if (shipment.etaHistory.length < 2) {
          mediumReasons.push(`${shipment.id}: insufficient ETA evidence (${shipment.etaHistory.length} revision)`);
        }
        const latest = Math.max(...shipment.etaHistory.map(r => Date.parse(r.at)));
        if (Date.parse(state.clock) - latest > 12 * 3_600_000) {
          mediumReasons.push(`${shipment.id}: stale ETA evidence, last update >12h ago`);
          factors.push(`${shipment.id}: stale ETA evidence, last update more than 12h ago`);
        }
      }
      if (Date.parse(shipment.eta) > Date.parse(order.deadline)) {
        factors.push(`${shipment.id} latest ETA misses customer deadline`);
      }
      if (state.dependencies.some(d => d.parentId === shipment.supplierId && !d.verified)) {
        mediumReasons.push(`${shipment.id}: upstream dependency is unverified partner declaration`);
        factors.push(`${shipment.id}: upstream dependency is a partner declaration, verification pending`);
      }
    }

    if (incidents.length > 1) {
      factors.push(`${incidents.length} compound disruptions overlap this order; exposure counted once`);
    }

    let confidence: EvidenceConfidence = 'high';
    const confidenceReasons: string[] = [];

    if (lowReasons.length > 0) {
      confidence = 'low';
      confidenceReasons.push(...lowReasons);
      if (mediumReasons.length > 0) confidenceReasons.push(...mediumReasons);
    } else if (mediumReasons.length > 0) {
      confidence = 'medium';
      confidenceReasons.push(...mediumReasons);
    } else {
      confidence = 'high';
      confidenceReasons.push('Authoritative inventory and on-time shipment evidence reconciled');
    }

    results.push({
      orderId: order.id,
      incidentIds: incidents.map(i => i.id),
      shortage: missing,
      score,
      band,
      drivers,
      factorScores,
      confidence,
      confidenceReasons,
      paths: [...new Set(paths)],
      hoursRemaining,
      factors,
    });
  }

  return results.sort((a, b) => b.score - a.score || a.hoursRemaining - b.hoursRemaining || a.orderId.localeCompare(b.orderId));
}
