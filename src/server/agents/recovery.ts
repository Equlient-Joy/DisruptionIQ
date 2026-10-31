import type { RecoveryPlan, State, AgentExecutionLog, PlanType } from '../../shared/types';
import type { Repository } from '../repository';
import { defaultRecoveryPlanner, evaluateCandidateConstraints, classifyPlanRisk } from '../../domain/plans';
import { callAgentLLM } from './llm';

export interface RecoveryAdvisorInput {
  incidentId: string;
  plans: RecoveryPlan[];
  state: State;
  repo: Repository;
}

export const FOUR_RECOVERY_STRATEGIES: {
  type: PlanType;
  name: string;
  description: string;
}[] = [
  {
    type: 'reallocate',
    name: 'Inventory Reallocation',
    description: 'Transfer uncommitted stock from another warehouse',
  },
  {
    type: 'expedite',
    name: 'Shipment Expediting',
    description: 'Fast-track in-transit shipment with express freight',
  },
  {
    type: 'alternative_supplier',
    name: 'Alternative Suppliers',
    description: 'Source component from approved Tier 1 suppliers',
  },
  {
    type: 'split_order',
    name: 'Split Orders',
    description: 'Split demand into immediate partial leg and deferred second leg',
  },
];

export async function runRecoveryAdvisorAgent(input: {
  incidentId: string;
  plans: RecoveryPlan[];
  state: State;
  repo: Repository;
}): Promise<AgentExecutionLog> {
  const startTime = performance.now();

  let plans =
    input.plans.length > 0
      ? input.plans
      : input.state.plans.filter(p => p.incidentId === input.incidentId);

  // If no plans pre-exist for this incident, generate candidates across all 4 strategies
  if (plans.length === 0) {
    const incident = input.state.incidents.find(i => i.id === input.incidentId);
    if (incident) {
      const generated: RecoveryPlan[] = [];
      for (const orderId of incident.affectedOrderIds) {
        const order = input.state.orders.find(o => o.id === orderId);
        if (order) {
          const shortage = Math.max(0, order.quantity - order.fulfilled);
          const candidates = defaultRecoveryPlanner.generateCandidates(input.state, incident.id, order.id, shortage);
          for (const cand of candidates) {
            const evalRes = evaluateCandidateConstraints(input.state, {
              orderId: order.id,
              type: cand.type,
              sourceId: cand.sourceId,
              quantity: cand.quantity,
            });
            generated.push({
              id: `plan-gen-${cand.type}-${cand.sourceId}`,
              incidentId: incident.id,
              orderId: order.id,
              type: cand.type,
              sourceId: cand.sourceId,
              quantity: cand.quantity,
              arrivesAt: evalRes.arrivesAt,
              costCents: evalRes.costCents,
              feasible: evalRes.feasible && evalRes.onTime,
              reasons: evalRes.reasons,
              status: 'proposed',
              createdBy: 'advisor',
              version: 1,
              rationale: `${cand.type} recovery candidate`,
              evidenceIds: [incident.id, order.id, cand.sourceId],
              inventoryVersion: input.state.version,
              riskLevel: classifyPlanRisk(input.state, {
                orderId: order.id,
                type: cand.type,
                sourceId: cand.sourceId,
                quantity: cand.quantity,
                costCents: evalRes.costCents,
              }),
            });
          }
        }
      }
      if (generated.length > 0) plans = generated;
    }
  }

  // Scoped data extraction (Least Privilege Principle)
  const candidatePlans = plans.map(p => ({
    id: p.id,
    type: p.type,
    orderId: p.orderId,
    sourceId: p.sourceId,
    quantity: p.quantity,
    arrivesAt: p.arrivesAt,
    costCents: p.costCents,
    feasible: p.feasible,
    reasons: p.reasons,
    riskLevel: p.riskLevel,
    status: p.status,
  }));

  const orderIds = Array.from(new Set(plans.map(p => p.orderId)));
  const targetOrders = input.state.orders
    .filter(o => orderIds.includes(o.id))
    .map(o => ({
      id: o.id,
      customer: o.customer,
      itemId: o.itemId,
      quantity: o.quantity,
      fulfilled: o.fulfilled,
      deadline: o.deadline,
      priority: o.priority,
    }));

  const itemIds = Array.from(new Set(targetOrders.map(o => o.itemId)));
  let lots = input.state.lots.filter(l => itemIds.includes(l.itemId));
  if (lots.length === 0 && itemIds.length > 0) {
    try {
      for (const itemId of itemIds) {
        const dbLots = await input.repo.searchTable('inventory_lots', itemId);
        for (const row of dbLots) {
          const lot = row.data || row;
          if (lot?.id && !lots.some(l => l.id === lot.id)) {
            lots.push(lot);
          }
        }
      }
    } catch {
      // Graceful fallback
    }
  }

  const skuInventorySummary = lots.map(l => ({
    id: l.id,
    itemId: l.itemId,
    warehouseId: l.warehouseId,
    quantity: l.quantity,
    reserved: l.reserved,
    available: Math.max(0, l.quantity - l.reserved),
    status: l.status,
  }));

  const accessedEntities = Array.from(
    new Set([
      input.incidentId,
      ...plans.map(p => p.id),
      ...targetOrders.map(o => o.id),
      ...skuInventorySummary.map(l => l.id),
    ])
  );

  // Group candidate plans across the FOUR Canonical Recovery Strategies:
  // 1. Inventory Reallocation ('reallocate')
  // 2. Shipment Expediting ('expedite')
  // 3. Alternative Suppliers ('alternative_supplier')
  // 4. Split Orders ('split_order')
  const strategyAnalysis = FOUR_RECOVERY_STRATEGIES.map(strat => {
    const plansForStrat = candidatePlans.filter(p => p.type === strat.type);
    const viablePlans = plansForStrat.filter(p => p.feasible);
    const bestPlan = [...viablePlans].sort((a, b) => {
      const timeDiff = Date.parse(a.arrivesAt) - Date.parse(b.arrivesAt);
      if (timeDiff !== 0) return timeDiff;
      return a.costCents - b.costCents;
    })[0];
    const failureReasons = Array.from(
      new Set(plansForStrat.filter(p => !p.feasible).flatMap(p => p.reasons))
    );

    return {
      type: strat.type,
      name: strat.name,
      description: strat.description,
      candidateCount: plansForStrat.length,
      viableCount: viablePlans.length,
      isViable: viablePlans.length > 0,
      bestPlan,
      failureReasons,
    };
  });

  const feasible = candidatePlans.filter(p => p.feasible);
  const rejected = candidatePlans.filter(p => !p.feasible);
  const viableStrategies = strategyAnalysis.filter(s => s.isViable);
  const allStrategiesInfeasible = viableStrategies.length === 0;

  let fallbackSummary = '';

  if (!allStrategiesInfeasible) {
    // Problem can be resolved using at least one of the 4 standard strategies
    const bestFeasible = [...feasible].sort((a, b) => {
      const timeDiff = Date.parse(a.arrivesAt) - Date.parse(b.arrivesAt);
      if (timeDiff !== 0) return timeDiff;
      return a.costCents - b.costCents;
    })[0];

    const strategyComparison = strategyAnalysis
      .map(s => {
        if (s.isViable && s.bestPlan) {
          return `[${s.name}]: VIABLE (${s.viableCount} option(s), earliest arrival ${s.bestPlan.arrivesAt}, cost $${(s.bestPlan.costCents / 100).toFixed(2)}, risk ${s.bestPlan.riskLevel || 'routine'})`;
        }
        return `[${s.name}]: INFEASIBLE (${s.candidateCount} candidate(s); ${s.failureReasons.join(', ') || 'No qualifying inventory or supplier sources'})`;
      })
      .join('; ');

    const bestStratName = FOUR_RECOVERY_STRATEGIES.find(s => s.type === bestFeasible.type)?.name || bestFeasible.type;
    const recommendation = `Recommend advancing Plan ${bestFeasible.id} under strategy "${bestStratName}" arriving ${bestFeasible.arrivesAt} with cost $${(bestFeasible.costCents / 100).toFixed(2)}.`;

    fallbackSummary =
      `Recovery critique for incident ${input.incidentId}: Evaluated ${candidatePlans.length} candidate recovery plan(s) (${feasible.length} feasible, ${rejected.length} rejected) across four recovery strategies. ` +
      `Strategy comparison: ${strategyComparison}. ` +
      `Synthesis: ${recommendation}`;
  } else {
    // None of the 4 standard strategies can solve the problem:
    // User requires an explicit WARNING that the 4 recommended strategies are not working,
    // plus suggested alternative solutions.
    const warningText =
      `WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption.`;

    const strategyFailureSummary = strategyAnalysis
      .map(s => `[${s.name}]: Failed (${s.candidateCount} evaluated; ${s.failureReasons.join(', ') || 'No qualifying sources available'})`)
      .join('; ');

    const suggestedAlternativeSolutions = [
      'Customer delivery deadline renegotiation / SLA grace window extension',
      'Factory production re-sequencing to assemble product lines not dependent on the disrupted component',
      'Emergency sourcing and fast-track qualification of non-tier-1 or spot-market suppliers',
      'Customer waiver for partial order fulfillment with remainder fulfilled on next production cycle',
      'Post-arrival manufacturing overtime / extra shifts to compress final assembly cycle',
    ];

    fallbackSummary =
      `Recovery critique for incident ${input.incidentId}: Evaluated ${candidatePlans.length} candidate recovery plan(s) (${feasible.length} feasible, ${rejected.length} rejected). ` +
      `${warningText} ` +
      `Strategy failure breakdown: ${strategyFailureSummary}. ` +
      `Suggested alternative solutions: ${suggestedAlternativeSolutions.map((sol, i) => `${i + 1}. ${sol}`).join(' | ')}`;
  }

  let summary = fallbackSummary;
  let status: 'success' | 'fallback' = 'fallback';
  let model = 'deterministic-advisor';

  // Grounded LLM reasoning when API key is provided
  const systemPrompt =
    `You are the DisruptionIQ Recovery Advisor Agent.\n` +
    `Your mandate is to evaluate and solve supply chain disruptions using the FOUR canonical recovery strategies:\n` +
    `1. Inventory Reallocation (reallocate): Moving unreserved stock from another warehouse.\n` +
    `2. Shipment Expediting (expedite): Accelerating in-transit shipments via air or express freight.\n` +
    `3. Alternative Suppliers (alternative_supplier): Sourcing components from approved Tier 1 suppliers.\n` +
    `4. Split Orders (split_order): Fulfilling immediate critical demand partially and deferring the remainder.\n\n` +
    `EVALUATION & COMPARISON RULES:\n` +
    `- Compare candidates across all four strategies, analyzing cost, arrival timeline against order deadline, operational feasibility, and governance risk level (routine vs high-risk dual manager approval).\n` +
    `- If one or more strategies are viable, compare their trade-offs and recommend the optimal recovery plan.\n` +
    `- MANDATORY WARNING REQUIREMENT: If NONE of the four recommended strategies can solve the disruption (i.e. all candidates are infeasible, lack stock, miss deadlines, or exceed capacity), you MUST start your response with:\n` +
    `"WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption."\n` +
    `Detail why each strategy failed and suggest alternative operational solutions beyond the 4 standard strategies (e.g. customer delivery deadline renegotiation, production re-sequencing, emergency supplier qualification, partial fulfillment waiver, manufacturing overtime).`;

  const llmRes = await callAgentLLM({
    systemPrompt,
    userPrompt: JSON.stringify({
      incidentId: input.incidentId,
      fourStrategiesAnalysis: strategyAnalysis,
      allStrategiesInfeasible,
      candidatePlans,
      targetOrders,
      skuInventorySummary,
    }),
  });

  if (llmRes) {
    summary = llmRes.text;
    status = 'success';
    model = llmRes.model;
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

  const log: AgentExecutionLog = {
    id: crypto.randomUUID(),
    timestamp: input.state.clock || new Date().toISOString(),
    agent: 'advisor',
    feature: 'plans',
    action: 'critique_recovery_options',
    accessedEntities,
    summary,
    status,
    latencyMs,
    model,
  };

  await input.repo.saveAgentLog(log);
  return log;
}
