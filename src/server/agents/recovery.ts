import type { RecoveryPlan, State, AgentExecutionLog } from '../../shared/types';
import type { Repository } from '../repository';
import { callAgentLLM } from './llm';

export interface RecoveryAdvisorInput {
  incidentId: string;
  plans: RecoveryPlan[];
  state: State;
  repo: Repository;
}

export async function runRecoveryAdvisorAgent(input: {
  incidentId: string;
  plans: RecoveryPlan[];
  state: State;
  repo: Repository;
}): Promise<AgentExecutionLog> {
  const startTime = performance.now();

  const plans =
    input.plans.length > 0
      ? input.plans
      : input.state.plans.filter(p => p.incidentId === input.incidentId);

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
  const skuInventorySummary = input.state.lots
    .filter(l => itemIds.includes(l.itemId))
    .map(l => ({
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

  // Deterministic trade-off synthesis and critique
  const feasible = candidatePlans.filter(p => p.feasible);
  const rejected = candidatePlans.filter(p => !p.feasible);

  const feasibleSummary =
    feasible.length > 0
      ? feasible
          .map(
            p =>
              `Plan ${p.id} [${p.type}]: source ${p.sourceId}, qty ${p.quantity}, arrives ${p.arrivesAt}, cost $${(
                p.costCents / 100
              ).toFixed(2)}, risk ${p.riskLevel || 'routine'}`
          )
          .join('; ')
      : 'None';

  const rejectedSummary =
    rejected.length > 0
      ? rejected
          .map(p => `Plan ${p.id} [${p.type}]: rejected due to ${p.reasons.join(', ')}`)
          .join('; ')
      : 'None';

  const bestFeasible = [...feasible].sort((a, b) => {
    const timeDiff = Date.parse(a.arrivesAt) - Date.parse(b.arrivesAt);
    if (timeDiff !== 0) return timeDiff;
    return a.costCents - b.costCents;
  })[0];

  const recommendation = bestFeasible
    ? `Recommend advancing Plan ${bestFeasible.id} (${bestFeasible.type}) arriving ${bestFeasible.arrivesAt} with cost $${(
        bestFeasible.costCents / 100
      ).toFixed(2)}.`
    : 'No feasible recovery plan options identified. Re-evaluate supplier lead times or manual inventory re-allocation.';

  const fallbackSummary =
    `Recovery critique for incident ${input.incidentId}: Evaluated ${candidatePlans.length} candidate recovery plan(s) (${feasible.length} feasible, ${rejected.length} rejected). ` +
    `Feasible options: ${feasibleSummary}. ` +
    `Constraint failures: ${rejectedSummary}. ` +
    `Synthesis: ${recommendation}`;

  let summary = fallbackSummary;
  let status: 'success' | 'fallback' = 'fallback';
  let model = 'deterministic-advisor';

  // Grounded LLM reasoning when API key is provided
  const llmRes = await callAgentLLM({
    systemPrompt:
      'You are the DisruptionIQ Recovery Advisor Agent. Synthesize trade-offs between candidate recovery plans for an operational incident. Critique feasible versus rejected options, compare costs, arrival deadlines, and operational risks (routine vs high risk dual approval). Recommend the optimal recovery path strictly based on the provided facts.',
    userPrompt: JSON.stringify({
      incidentId: input.incidentId,
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
