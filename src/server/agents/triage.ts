import type { RawEvent, EventInput, Incident, State, AgentExecutionLog } from '../../shared/types';
import type { Repository } from '../repository';
import { callAgentLLM } from './llm';

export interface TriageAgentInput {
  event: RawEvent | EventInput;
  incident?: Incident;
  state: State;
  repo: Repository;
}

export async function runTriageAgent(input: {
  event: RawEvent | EventInput;
  incident?: Incident;
  state: State;
  repo: Repository;
}): Promise<AgentExecutionLog> {
  const startTime = performance.now();

  // Scoped data extraction (Least Privilege Principle)
  const triggeringEvent = {
    id: input.event.id,
    type: input.event.type,
    entityId: input.event.entityId,
    time: input.event.time,
    payload: input.event.payload,
  };

  const incidentContext = input.incident
    ? {
        id: input.incident.id,
        type: input.incident.type,
        title: input.incident.title,
        description: input.incident.description,
        status: input.incident.status,
        affectedOrderIds: input.incident.affectedOrderIds,
      }
    : null;

  const entityId = input.event.entityId;
  const directDependencies = input.state.dependencies
    .filter(d => d.parentId === entityId || d.childId === entityId || d.itemId === entityId)
    .map(d => ({
      parentId: d.parentId,
      childId: d.childId,
      itemId: d.itemId,
      confidence: d.confidence,
      verified: d.verified,
    }));

  const targetOrderIds = new Set<string>();
  if (input.incident?.affectedOrderIds) {
    for (const oid of input.incident.affectedOrderIds) {
      targetOrderIds.add(oid);
    }
  }
  for (const o of input.state.orders) {
    if (o.warehouseId === entityId || o.itemId === entityId) {
      targetOrderIds.add(o.id);
    }
  }

  const affectedOrders = input.state.orders
    .filter(o => targetOrderIds.has(o.id))
    .map(o => ({
      id: o.id,
      customer: o.customer,
      itemId: o.itemId,
      quantity: o.quantity,
      deadline: o.deadline,
      priority: o.priority,
      status: o.status,
    }));

  const accessedEntities = Array.from(
    new Set(
      [
        input.incident?.id,
        input.event.entityId,
        ...directDependencies.map(d => d.parentId),
        ...directDependencies.map(d => d.childId),
        ...affectedOrders.map(o => o.id),
      ].filter((id): id is string => Boolean(id))
    )
  );

  // Deterministic fallback explanation
  const depsSummary =
    directDependencies.length > 0
      ? directDependencies
          .map(d => `${d.parentId} -> ${d.childId} (item: ${d.itemId}, verified: ${d.verified})`)
          .join('; ')
      : 'No direct tier-1/tier-2 dependencies linked to entity';

  const ordersSummary =
    affectedOrders.length > 0
      ? affectedOrders
          .map(o => `${o.id} (customer: ${o.customer}, deadline: ${o.deadline}, qty: ${o.quantity})`)
          .join(', ')
      : 'None';

  const earliestDeadline =
    affectedOrders.length > 0
      ? [...affectedOrders].map(o => o.deadline).sort()[0]
      : 'None';

  const fallbackSummary =
    `Triage analysis for ${input.event.type} on entity ${input.event.entityId}: ` +
    `${input.incident ? `Correlated to incident ${input.incident.id} ("${input.incident.title}")` : 'Unlinked disruption'}. ` +
    `Direct dependencies: ${depsSummary}. ` +
    `Downstream exposure: ${affectedOrders.length} order(s) [${ordersSummary}]. ` +
    `Earliest deadline pressure: ${earliestDeadline}.`;

  let summary = fallbackSummary;
  let status: 'success' | 'fallback' = 'fallback';
  let model = 'deterministic-triage';

  // Grounded LLM reasoning when API key is provided
  const llmRes = await callAgentLLM({
    systemPrompt:
      'You are the DisruptionIQ Triage Agent. Correlate the root cause of an incoming supply-chain disruption using strictly the provided facts under least-privilege principles. Do not speculate, invent unlisted dependencies or inventory, or introduce penalty costs. Cite specific entity IDs, affected order IDs, and deadlines. Keep your summary concise, factual, and operationally focused.',
    userPrompt: JSON.stringify({
      triggeringEvent,
      incident: incidentContext,
      directDependencies,
      affectedOrders,
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
    agent: 'triage',
    feature: 'incidents',
    action: 'correlate_root_cause',
    accessedEntities,
    summary,
    status,
    latencyMs,
    model,
  };

  await input.repo.saveAgentLog(log);
  return log;
}
