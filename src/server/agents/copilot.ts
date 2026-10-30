import type {
  ActionCard,
  Actor,
  AgentExecutionLog,
  ChatMessage,
  Incident,
  Lot,
  Order,
  PlanType,
  RawEvent,
  RecoveryPlan,
  Shipment,
  SimulationDiff,
  State,
  Supplier,
  Warehouse,
} from '../../shared/types';
import type { Repository } from '../repository';
import { upstreamPaths } from '../../domain/common';
import { getImpact } from '../../domain/impact';
import { DeterministicTemplatePlanner, evaluateCandidateConstraints } from '../../domain/plans';
import { callAgentLLM } from './llm';
import { simulateWhatIfScenario, type WhatIfParams } from './simulation';

export interface CopilotChatRequest {
  message: string;
  history?: ChatMessage[];
  currentContext?: {
    page?: string;
    entityId?: string;
  };
}

/**
 * Deep-link formatter: wraps recognized entity IDs in markdown links:
 * [Entity-ID](app://entityType/id)
 */
export function formatDeepLinks(text: string, state: State): string {
  // Collect all known entity IDs with their type
  const entityMap = new Map<string, string>();
  for (const o of state.orders) entityMap.set(o.id, 'orders');
  for (const i of state.incidents) entityMap.set(i.id, 'incidents');
  for (const s of state.shipments) entityMap.set(s.id, 'shipments');
  for (const l of state.lots) entityMap.set(l.id, 'lots');
  for (const w of state.warehouses) entityMap.set(w.id, 'warehouses');
  for (const s of state.suppliers) entityMap.set(s.id, 'suppliers');
  for (const p of state.plans) entityMap.set(p.id, 'plans');

  let result = text;

  // Replace exact known IDs not already inside a markdown link
  for (const [id, type] of entityMap.entries()) {
    const escaped = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Ensure not preceded by '[' and not followed by ']('
    const regex = new RegExp(`(?<!\\[)\\b(${escaped})\\b(?!\\]\\()`, 'g');
    result = result.replace(regex, `[$1](app://${type}/$1)`);
  }

  // Also catch generic patterns like ORD-102, INC-101, SHP-01, LOT-01, WH-01, SUP-01, and order-xxx, shipment-xxx, etc.
  const patterns: [RegExp, string][] = [
    [/(?<!\[)\b((?:ORD|order)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'orders'],
    [/(?<!\[)\b((?:INC|incident)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'incidents'],
    [/(?<!\[)\b((?:SHP|shipment)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'shipments'],
    [/(?<!\[)\b((?:LOT|lot)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'lots'],
    [/(?<!\[)\b((?:WH|warehouse)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'warehouses'],
    [/(?<!\[)\b((?:SUP|supplier)-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'suppliers'],
    [/(?<!\[)\b(plan-[A-Za-z0-9_-]+)\b(?!\s*\]|\s*\()/gi, 'plans'],
  ];

  for (const [re, type] of patterns) {
    result = result.replace(re, match => `[${match}](app://${type}/${match})`);
  }

  return result;
}

// -------------------------------------------------------------
// Deterministic Tools Available to Copilot
// -------------------------------------------------------------

export async function runSimulateWhatIfTool(
  state: State,
  params: WhatIfParams
): Promise<SimulationDiff> {
  return simulateWhatIfScenario(state, params);
}

export function runQueryEntitiesTool(
  state: State,
  actor: Actor,
  params: {
    entityType: 'orders' | 'shipments' | 'lots' | 'suppliers' | 'warehouses' | 'incidents' | 'tasks';
    filters?: Record<string, unknown>;
  }
): Record<string, unknown>[] {
  const isPartner = actor.orgId !== 'focal';

  if (isPartner) {
    if (params.entityType === 'orders' || params.entityType === 'lots' || params.entityType === 'warehouses') {
      throw new Error(`Access denied: Partner organization (${actor.orgId}) cannot access internal ${params.entityType}.`);
    }
    if (params.entityType === 'incidents') {
      return state.incidents.filter(i => i.memberOrgIds.includes(actor.orgId)) as unknown as Record<string, unknown>[];
    }
    if (params.entityType === 'tasks') {
      return state.tasks.filter(t => t.orgId === actor.orgId) as unknown as Record<string, unknown>[];
    }
    if (params.entityType === 'suppliers') {
      return state.suppliers.filter(s => s.orgId === actor.orgId) as unknown as Record<string, unknown>[];
    }
    if (params.entityType === 'shipments') {
      const partnerSupplierIds = new Set(state.suppliers.filter(s => s.orgId === actor.orgId).map(s => s.id));
      return state.shipments.filter(s => partnerSupplierIds.has(s.supplierId)) as unknown as Record<string, unknown>[];
    }
  }

  const list = state[params.entityType] as unknown as Record<string, unknown>[];
  if (!params.filters || Object.keys(params.filters).length === 0) {
    return list;
  }

  return list.filter(item => {
    for (const [k, v] of Object.entries(params.filters!)) {
      if (item[k] !== v) return false;
    }
    return true;
  });
}

export function runGetIncidentDossierTool(
  state: State,
  actor: Actor,
  incidentId: string
): {
  incident: Incident;
  triggeringEvents: RawEvent[];
  upstreamDependencies: string[][];
  affectedOrders: Array<{ id: string; customer: string; priority: string; deadline: string; shortage?: number }>;
  activePlans: RecoveryPlan[];
} {
  const incident = state.incidents.find(i => i.id === incidentId);
  if (!incident) {
    throw new Error(`Incident "${incidentId}" not found.`);
  }

  const isPartner = actor.orgId !== 'focal';
  if (isPartner && !incident.memberOrgIds.includes(actor.orgId)) {
    throw new Error(`Access denied: Incident "${incidentId}" is not shared with partner organization "${actor.orgId}".`);
  }

  const triggeringEvents = state.events.filter(e => e.entityId === incident.entityId);
  const upstream = upstreamPaths(state, incident.entityId);

  // Filter affected orders respecting RBAC
  const affectedOrders: Array<{ id: string; customer: string; priority: string; deadline: string; shortage?: number }> = [];
  if (!isPartner) {
    const impacts = getImpact(state);
    for (const orderId of incident.affectedOrderIds) {
      const order = state.orders.find(o => o.id === orderId);
      if (order) {
        const impact = impacts.find(i => i.orderId === order.id);
        affectedOrders.push({
          id: order.id,
          customer: order.customer,
          priority: order.priority,
          deadline: order.deadline,
          shortage: impact?.shortage,
        });
      }
    }
  }

  const activePlans = isPartner ? [] : state.plans.filter(p => p.incidentId === incident.id);

  return {
    incident,
    triggeringEvents,
    upstreamDependencies: upstream,
    affectedOrders,
    activePlans,
  };
}

export function runProposeRecoveryActionTool(params: {
  cardType: 'plan_action_prompt' | 'lot_hold_prompt' | 'filter_prompt';
  title: string;
  detail: string;
  risk?: 'routine' | 'high';
  cost?: number;
  planId?: string;
  incidentId?: string;
  lotId?: string;
  targetStatus?: string;
  buttonLabel: string;
}): ActionCard {
  return {
    id: `card-${crypto.randomUUID()}`,
    cardType: params.cardType,
    title: params.title,
    detail: params.detail,
    risk: params.risk,
    cost: params.cost,
    planId: params.planId,
    incidentId: params.incidentId,
    lotId: params.lotId,
    targetStatus: params.targetStatus,
    buttonLabel: params.buttonLabel,
  };
}

// -------------------------------------------------------------
// Persona System Instructions
// -------------------------------------------------------------

function buildPersonaInstructions(actor: Actor): string {
  const roleName = actor.role.toUpperCase();
  const orgName = actor.orgId;

  let roleGuidance = '';
  switch (actor.role) {
    case 'warehouse':
      roleGuidance =
        'Focus on physical warehouse operations: lot status (available, held, disputed), bay storage, on-hand vs reserved quantities, and quality holds.';
      break;
    case 'procurement':
      roleGuidance =
        'Focus on supplier management: lead times, tier-1 and tier-2 vendor relationships, alternate sourcing options, budget/cost impact, and supplier remaining capacity.';
      break;
    case 'manager':
      roleGuidance =
        'Focus on governance and supply chain risk policy: dual approvals required for high-risk plans (cost >= $2,000 or customer order penalty >= $5,000), break-glass execution requirements, SLA compliance, and cross-functional coordination.';
      break;
    case 'analyst':
      roleGuidance =
        'Focus on analytical rigor: impact risk scores (0.0 to 10.0), five factor score breakdowns (uncovered demand 3.0, deadline pressure 2.0, recovery feasibility 2.0, cascading exposure 1.5, business consequence 1.5), bottleneck drivers, and cascading graph topology.';
      break;
    case 'viewer':
    default:
      roleGuidance =
        'Focus on shared cross-organization incident tracking, assigned task completion, and collaborative milestone updates.';
      break;
  }

  const rbacGuidance =
    actor.orgId !== 'focal'
      ? `STRICT RBAC GUARDRAIL: The user is a Partner Viewer belonging to organization "${actor.orgId}". They are strictly permitted to view only shared incidents where memberOrgIds contains "${actor.orgId}" and tasks assigned to their organization. If the user asks about internal financial costs, unshared customer orders, or warehouse inventory lots, you MUST politely refuse and cite partner access boundaries.`
      : 'Full focal organization access authorized.';

  return `You are DisruptionIQ Copilot, an expert autonomous AI supply-chain assistant.
Current User: ${actor.name} (${actor.email})
Role: ${roleName} | Organization: ${orgName}
${roleGuidance}
${rbacGuidance}

Response Formatting Rules:
- Support deep links using markdown: [Entity-ID](app://entityType/id), e.g. [ORD-102](app://orders/ORD-102) or [INC-101](app://incidents/INC-101).
- Be concise, professional, and operationally grounded.
- Never invent fictitious inventory or unlisted dependencies.`;
}

// -------------------------------------------------------------
// Intent Detection & Deterministic Fallback Handler
// -------------------------------------------------------------

interface DetectedIntent {
  kind: 'partner_refusal' | 'what_if_simulation' | 'incident_dossier' | 'propose_action' | 'query_entities' | 'general';
  entityType?: 'shipment' | 'supplier' | 'warehouse' | 'lot';
  entityId?: string;
  incidentId?: string;
  delta?: {
    delayHours?: number;
    status?: string;
    quantity?: number;
  };
  queryType?: 'orders' | 'shipments' | 'lots' | 'suppliers' | 'warehouses' | 'incidents' | 'tasks';
}

function detectIntent(message: string, currentContext: CopilotChatRequest['currentContext'], state: State, actor: Actor): DetectedIntent {
  const isPartner = actor.orgId !== 'focal';
  const lower = message.toLowerCase();

  // 1. Partner boundary check
  if (isPartner) {
    const asksForCosts = /\b(cost|price|pricing|financial|margin|penalty|budget|revenue|cents|dollar)\b/i.test(lower);
    const asksForOrders = /\b(order|orders|customer|customers)\b/i.test(lower);
    const asksForLots = /\b(lot|lots|inventory|stock\s*count|warehouse\s*stock)\b/i.test(lower);
    const asksForWarehouses = /\b(warehouse|warehouses)\b/i.test(lower);
    const asksForInternal = /\b(internal|unshared|focal|all\s+incidents)\b/i.test(lower);

    const orderMatches = message.match(/order-[\w-]+|ORD-[\w-]+/gi);
    const lotMatches = message.match(/lot-[\w-]+|LOT-[\w-]+/gi);
    const whMatches = message.match(/warehouse-[\w-]+|WH-[\w-]+/gi);
    const incMatches = message.match(/incident-[\w-]+|scenario-[\w-]+|INC-[\w-]+/gi);

    let unsharedIncidentRequested = false;
    if (incMatches) {
      for (const incId of incMatches) {
        const inc = state.incidents.find(i => i.id.toLowerCase() === incId.toLowerCase());
        if (inc && !inc.memberOrgIds.includes(actor.orgId)) {
          unsharedIncidentRequested = true;
          break;
        }
      }
    }

    if (asksForCosts || asksForOrders || asksForLots || asksForWarehouses || asksForInternal || orderMatches || lotMatches || whMatches || unsharedIncidentRequested) {
      return { kind: 'partner_refusal' };
    }
  }

  // 2. What-If Simulation Intent
  const isWhatIf = /\b(what\s+if|simulate|simulating|simulation|hypothetical|delay\s+by|outage\s+on|if\s+we\s+delay)\b/i.test(lower);
  if (isWhatIf) {
    // Find target entity
    let entityId: string | undefined = undefined;
    let entityType: 'shipment' | 'supplier' | 'warehouse' | 'lot' | undefined = undefined;

    // Check shipments in state or regex
    for (const s of state.shipments) {
      if (lower.includes(s.id.toLowerCase())) {
        entityId = s.id;
        entityType = 'shipment';
        break;
      }
    }
    if (!entityId) {
      for (const w of state.warehouses) {
        if (lower.includes(w.id.toLowerCase()) || lower.includes(w.name.toLowerCase())) {
          entityId = w.id;
          entityType = 'warehouse';
          break;
        }
      }
    }
    if (!entityId) {
      for (const l of state.lots) {
        if (lower.includes(l.id.toLowerCase())) {
          entityId = l.id;
          entityType = 'lot';
          break;
        }
      }
    }
    if (!entityId) {
      for (const sup of state.suppliers) {
        if (lower.includes(sup.id.toLowerCase()) || lower.includes(sup.name.toLowerCase())) {
          entityId = sup.id;
          entityType = 'supplier';
          break;
        }
      }
    }

    // Generic pattern fallback
    if (!entityId) {
      const shpMatch = message.match(/\b(SHP-[\w-]+|shipment-[\w-]+)\b/i);
      const whMatch = message.match(/\b(WH-[\w-]+|warehouse-[\w-]+)\b/i);
      const lotMatch = message.match(/\b(LOT-[\w-]+|lot-[\w-]+)\b/i);
      const supMatch = message.match(/\b(SUP-[\w-]+|supplier-[\w-]+)\b/i);

      if (shpMatch) {
        entityId = shpMatch[1];
        entityType = 'shipment';
      } else if (whMatch) {
        entityId = whMatch[1];
        entityType = 'warehouse';
      } else if (lotMatch) {
        entityId = lotMatch[1];
        entityType = 'lot';
      } else if (supMatch) {
        entityId = supMatch[1];
        entityType = 'supplier';
      } else if (currentContext?.entityId) {
        entityId = currentContext.entityId;
        if (state.shipments.some(s => s.id === entityId)) entityType = 'shipment';
        else if (state.warehouses.some(w => w.id === entityId)) entityType = 'warehouse';
        else if (state.lots.some(l => l.id === entityId)) entityType = 'lot';
        else if (state.suppliers.some(s => s.id === entityId)) entityType = 'supplier';
      }
    }

    if (entityId && entityType) {
      const delta: { delayHours?: number; status?: string; quantity?: number } = {};

      const delayMatch = message.match(/(\d+)\s*(?:hour|hr|h)\s*(?:delay)?/i) || message.match(/delay.*?(\d+)/i);
      if (delayMatch) {
        delta.delayHours = parseInt(delayMatch[1], 10);
      }

      if (/\boutage\b/i.test(lower)) delta.status = 'outage';
      else if (/\bonline\b/i.test(lower)) delta.status = 'online';
      else if (/\bheld\b/i.test(lower) || /\bhold\b/i.test(lower)) delta.status = 'held';
      else if (/\bavailable\b/i.test(lower)) delta.status = 'available';
      else if (/\bdisputed\b/i.test(lower)) delta.status = 'disputed';

      const qtyMatch = message.match(/(?:quantity|qty)\s*(?:to|=)?\s*(\d+)/i);
      if (qtyMatch) {
        delta.quantity = parseInt(qtyMatch[1], 10);
      }

      // Default if delay specified without hours
      if (entityType === 'shipment' && delta.delayHours === undefined && delta.status === undefined) {
        delta.delayHours = 24;
      }
      if (entityType === 'warehouse' && !delta.status) {
        delta.status = 'outage';
      }
      if (entityType === 'lot' && !delta.status) {
        delta.status = 'held';
      }

      return {
        kind: 'what_if_simulation',
        entityType,
        entityId,
        delta,
      };
    }
  }

  // 3. Incident Dossier Intent
  let foundIncidentId: string | undefined = undefined;
  for (const inc of state.incidents) {
    if (lower.includes(inc.id.toLowerCase())) {
      foundIncidentId = inc.id;
      break;
    }
  }
  if (!foundIncidentId && currentContext?.entityId && state.incidents.some(i => i.id === currentContext.entityId)) {
    foundIncidentId = currentContext.entityId;
  }
  if (!foundIncidentId) {
    const incMatch = message.match(/\b(INC-[\w-]+|incident-[\w-]+|scenario-[\w-]+)\b/i);
    if (incMatch) {
      foundIncidentId = incMatch[1];
    }
  }

  const isDossierRequest = /\b(root\s*cause|dossier|evidence|investigate|why\s+did|incident\s+details)\b/i.test(lower);
  if (foundIncidentId && (isDossierRequest || /\bincident\b/i.test(lower))) {
    return {
      kind: 'incident_dossier',
      incidentId: foundIncidentId,
    };
  }

  // 4. Propose recovery action intent
  if (/\b(propose|recommend|suggest|recovery\s+action|action\s+card|mitigate|resolution)\b/i.test(lower)) {
    return {
      kind: 'propose_action',
      incidentId: foundIncidentId,
    };
  }

  // 5. Query Entities Intent
  if (/\b(list|show|view|find|query|all)\s+(orders?|shipments?|lots?|suppliers?|warehouses?|tasks?)\b/i.test(lower)) {
    if (/\border/i.test(lower)) return { kind: 'query_entities', queryType: 'orders' };
    if (/\bshipment/i.test(lower)) return { kind: 'query_entities', queryType: 'shipments' };
    if (/\blot/i.test(lower)) return { kind: 'query_entities', queryType: 'lots' };
    if (/\bsupplier/i.test(lower)) return { kind: 'query_entities', queryType: 'suppliers' };
    if (/\bwarehouse/i.test(lower)) return { kind: 'query_entities', queryType: 'warehouses' };
    if (/\btask/i.test(lower)) return { kind: 'query_entities', queryType: 'tasks' };
  }

  return { kind: 'general' };
}

// -------------------------------------------------------------
// Core Copilot Chat Handler
// -------------------------------------------------------------

export async function handleCopilotChat(
  actor: Actor,
  req: CopilotChatRequest,
  repo: Repository
): Promise<ChatMessage> {
  const startTime = performance.now();
  const state = await repo.read();
  const accessedEntities = new Set<string>();

  // Determine intent
  const intent = detectIntent(req.message, req.currentContext, state, actor);

  let replyContent = '';
  let actionCards: ActionCard[] | undefined = undefined;
  let simulationResult: SimulationDiff | undefined = undefined;
  let summary = '';
  let status: 'success' | 'fallback' = 'fallback';
  let model = 'deterministic-copilot';

  // ---------------------------------------------------------
  // Case A: Partner Refusal (Boundary Guardrail)
  // ---------------------------------------------------------
  if (intent.kind === 'partner_refusal') {
    const sharedIncidents = state.incidents.filter(i => i.memberOrgIds.includes(actor.orgId));
    const sharedIds = sharedIncidents.map(i => i.id).join(', ') || 'none';
    for (const inc of sharedIncidents) accessedEntities.add(inc.id);

    replyContent =
      `As a Partner Viewer representing organization "${actor.orgId}", your access is strictly scoped to shared collaborative incidents and tasks assigned to your organization. ` +
      `You do not have authorization to view internal financial costs, unshared customer orders, or warehouse inventory lots due to partner data boundaries.\n\n` +
      `Shared incidents available to your organization: ${sharedIds ? formatDeepLinks(sharedIds, state) : 'None currently active'}.\n` +
      `Please coordinate updates via your assigned partner tasks.`;

    summary = `Partner access refused for sensitive entity/cost query by actor ${actor.id}.`;
  }

  // ---------------------------------------------------------
  // Case B: What-If Simulation Request
  // ---------------------------------------------------------
  else if (intent.kind === 'what_if_simulation' && intent.entityId && intent.entityType) {
    accessedEntities.add(intent.entityId);

    const diff = await runSimulateWhatIfTool(state, {
      entityType: intent.entityType,
      entityId: intent.entityId,
      delta: intent.delta || {},
    });

    simulationResult = diff;

    // Role-specific commentary
    let roleCommentary = '';
    if (actor.role === 'manager') {
      roleCommentary =
        `\n\n**Governance & Approval Notice**: Any proposed recovery exceeding $2,000 or linked to high-penalty orders requires dual manager authorization prior to execution.`;
    } else if (actor.role === 'procurement') {
      roleCommentary =
        `\n\n**Procurement Context**: Alternative sourcing leads and supplier capacity should be verified before confirming expedited freight.`;
    } else if (actor.role === 'warehouse') {
      roleCommentary =
        `\n\n**Warehouse Operations Notice**: Verify physical bay space and existing lot holds before reallocating reserve stock.`;
    } else if (actor.role === 'analyst') {
      roleCommentary =
        `\n\n**Analytical Assessment**: Newly impacted orders will shift deadline pressure and cascading exposure factor scores.`;
    }

    const breachSummary =
      diff.newlyBreachedOrders.length > 0
        ? diff.newlyBreachedOrders
            .map(o => `• ${o.orderId} (${o.customer}): deadline in ${o.hoursToDeadline}h`)
            .join('\n')
        : 'None (no new order deadlines breached).';

    for (const o of diff.newlyBreachedOrders) {
      accessedEntities.add(o.orderId);
    }

    replyContent =
      `### What-If Simulation Results: ${diff.scenarioDescription}\n\n` +
      `• **Exposed Orders**: Baseline ${diff.baselineExposedOrders} → Simulated ${diff.simulatedExposedOrders} ` +
      `(${diff.deltaExposedOrders >= 0 ? `+${diff.deltaExposedOrders}` : diff.deltaExposedOrders})\n` +
      `• **Total Demand Shortage**: Baseline ${diff.baselineTotalShortage} units → Simulated ${diff.simulatedTotalShortage} units ` +
      `(${diff.deltaShortage >= 0 ? `+${diff.deltaShortage}` : diff.deltaShortage})\n` +
      `• **Feasible Recovery Options**: ${diff.feasibleRecoveryCount} candidate path(s) verified on-time\n` +
      `• **Recommended Plan Type**: ${diff.recommendedPlanType ? `\`${diff.recommendedPlanType}\`` : 'None feasible'}\n\n` +
      `**Newly Breached Orders**:\n${breachSummary}${roleCommentary}`;

    // Attach Action Card if feasible options exist
    if (diff.feasibleRecoveryCount > 0 && diff.recommendedPlanType) {
      actionCards = [
        runProposeRecoveryActionTool({
          cardType: 'plan_action_prompt',
          title: `Initiate ${diff.recommendedPlanType.toUpperCase()} Recovery`,
          detail: `Simulation demonstrates ${diff.feasibleRecoveryCount} feasible recovery path(s). Recommended resolution type: ${diff.recommendedPlanType}.`,
          risk: 'routine',
          buttonLabel: `Explore ${diff.recommendedPlanType}`,
        }),
      ];
    }

    summary = `What-If simulation on ${intent.entityType} ${intent.entityId}: delta shortage ${diff.deltaShortage}, ${diff.feasibleRecoveryCount} feasible plans.`;
  }

  // ---------------------------------------------------------
  // Case C: Incident Dossier Request
  // ---------------------------------------------------------
  else if (intent.kind === 'incident_dossier' && intent.incidentId) {
    accessedEntities.add(intent.incidentId);

    try {
      const dossier = runGetIncidentDossierTool(state, actor, intent.incidentId);
      accessedEntities.add(dossier.incident.entityId);
      for (const o of dossier.affectedOrders) accessedEntities.add(o.id);
      for (const p of dossier.activePlans) accessedEntities.add(p.id);

      const eventsSummary =
        dossier.triggeringEvents.length > 0
          ? dossier.triggeringEvents.map(e => `• Event ${e.id} (${e.type}): ${JSON.stringify(e.payload)}`).join('\n')
          : 'No triggering events found directly matching entity.';

      const ordersSummary =
        dossier.affectedOrders.length > 0
          ? dossier.affectedOrders.map(o => `• ${o.id} (${o.customer}): priority ${o.priority}, shortage: ${o.shortage ?? 'unspecified'}`).join('\n')
          : actor.orgId !== 'focal'
            ? 'Customer order details are restricted by partner access boundaries.'
            : 'No downstream orders currently affected.';

      const upstreamSummary =
        dossier.upstreamDependencies.length > 0
          ? dossier.upstreamDependencies.map(p => p.join(' → ')).join(' | ')
          : 'Direct tier-1 entity (no deeper upstream nodes).';

      replyContent =
        `### Incident Dossier: ${dossier.incident.id} ("${dossier.incident.title}")\n\n` +
        `• **Status**: ${dossier.incident.status.toUpperCase()} | **Disrupted Entity**: ${dossier.incident.entityId}\n` +
        `• **Upstream Dependency Tree**: ${upstreamSummary}\n\n` +
        `**Root-Cause Operational Claims**:\n${eventsSummary}\n\n` +
        `**Downstream Exposure**:\n${ordersSummary}\n\n` +
        `• **Active Recovery Plans**: ${dossier.activePlans.length} plan(s) recorded in state.`;

      if (dossier.activePlans.length > 0) {
        const topPlan = dossier.activePlans[0];
        actionCards = [
          runProposeRecoveryActionTool({
            cardType: 'plan_action_prompt',
            title: `Review Plan ${topPlan.id}`,
            detail: `${topPlan.type.toUpperCase()} recovery: ${topPlan.quantity} units, cost $${(topPlan.costCents / 100).toFixed(2)}.`,
            risk: topPlan.riskLevel || 'routine',
            cost: topPlan.costCents,
            planId: topPlan.id,
            incidentId: dossier.incident.id,
            buttonLabel: 'Review & Authorize',
          }),
        ];
      }

      summary = `Incident dossier retrieved for ${dossier.incident.id}: ${dossier.affectedOrders.length} affected orders.`;
    } catch (err) {
      replyContent = (err as Error).message;
      summary = `Incident dossier access error: ${(err as Error).message}`;
    }
  }

  // ---------------------------------------------------------
  // Case D: Propose Recovery Action
  // ---------------------------------------------------------
  else if (intent.kind === 'propose_action') {
    const plans = actor.orgId === 'focal' ? state.plans : [];
    const openImpacts = actor.orgId === 'focal' ? getImpact(state).filter(i => i.shortage > 0) : [];

    if (plans.length > 0) {
      const p = plans[0];
      accessedEntities.add(p.id);
      accessedEntities.add(p.incidentId);
      accessedEntities.add(p.orderId);

      replyContent =
        `A recovery option is available for incident ${p.incidentId}: ` +
        `**Plan ${p.id}** (${p.type}) for order ${p.orderId}. ` +
        `Quantity: ${p.quantity} units, arrives at ${p.arrivesAt}, cost: $${(p.costCents / 100).toFixed(2)}. ` +
        `Status: \`${p.status}\`, Risk Level: \`${p.riskLevel || 'routine'}\`.`;

      actionCards = [
        runProposeRecoveryActionTool({
          cardType: 'plan_action_prompt',
          title: `Authorize Recovery Plan ${p.id}`,
          detail: `${p.type.toUpperCase()}: ${p.quantity} units for order ${p.orderId}. Feasible: ${p.feasible}.`,
          risk: p.riskLevel || 'routine',
          cost: p.costCents,
          planId: p.id,
          incidentId: p.incidentId,
          buttonLabel: 'Authorize Plan',
        }),
      ];
    } else if (openImpacts.length > 0) {
      const top = openImpacts[0];
      accessedEntities.add(top.orderId);
      replyContent =
        `Order ${top.orderId} has an uncovered shortage of ${top.shortage} units (Impact Score: ${top.score.toFixed(1)}). ` +
        `Generate deterministic recovery options from the Operations panel to compare candidate paths.`;

      actionCards = [
        runProposeRecoveryActionTool({
          cardType: 'filter_prompt',
          title: `Focus on Order ${top.orderId}`,
          detail: `Shortage: ${top.shortage} units. Primary bottleneck drivers: ${(top.drivers || []).join(', ') || 'Demand pressure'}.`,
          buttonLabel: 'Inspect Order',
        }),
      ];
    } else {
      replyContent =
        `All active customer orders are currently covered by available inventory and scheduled shipments. No urgent recovery actions required.`;
    }

    summary = `Proposed recovery actions: ${actionCards ? actionCards.length : 0} action card(s) emitted.`;
  }

  // ---------------------------------------------------------
  // Case E: Query Entities
  // ---------------------------------------------------------
  else if (intent.kind === 'query_entities' && intent.queryType) {
    try {
      const items = runQueryEntitiesTool(state, actor, { entityType: intent.queryType });
      const sample = items.slice(0, 5);
      for (const item of sample) {
        if (typeof item.id === 'string') accessedEntities.add(item.id);
      }

      const formattedSample = sample
        .map(item => `• **${item.id || 'Item'}**: ${JSON.stringify(item)}`)
        .join('\n');

      replyContent =
        `Found ${items.length} ${intent.queryType} matching your permissions:\n\n` +
        `${formattedSample}${items.length > 5 ? `\n...and ${items.length - 5} more.` : ''}`;

      summary = `Queried ${intent.queryType}: ${items.length} records returned.`;
    } catch (err) {
      replyContent = (err as Error).message;
      summary = `Query error: ${(err as Error).message}`;
    }
  }

  // ---------------------------------------------------------
  // Case F: General / Conversational Query
  // ---------------------------------------------------------
  else {
    const isPartner = actor.orgId !== 'focal';
    const sharedIncidents = state.incidents.filter(i => isPartner ? i.memberOrgIds.includes(actor.orgId) : true);
    for (const inc of sharedIncidents) accessedEntities.add(inc.id);

    replyContent =
      `Hello ${actor.name}. You are currently connected to DisruptionIQ as **${actor.role.toUpperCase()}** (${actor.orgId}).\n\n` +
      `Workspace Status Overview:\n` +
      `• **Active Incidents**: ${sharedIncidents.length} incident(s) visible\n` +
      `• **Simulation Clock**: ${state.clock}\n` +
      `• **Integration Status**: ${state.integrationOutage ? 'Outage active (events queued)' : 'All feeds online'}\n\n` +
      `You can ask me to run What-If simulations (e.g. *"What if shipment-atlas is delayed by 24 hours?"*), inspect incident root cause (e.g. *"Tell me about the active incident"*), or query operational entities.`;

    summary = `General status overview provided to ${actor.role} (${actor.orgId}).`;
  }

  // ---------------------------------------------------------
  // Grounded LLM Enhancement (if configured)
  // ---------------------------------------------------------
  const systemPrompt = buildPersonaInstructions(actor);
  const llmRes = await callAgentLLM({
    systemPrompt,
    userPrompt: JSON.stringify({
      userMessage: req.message,
      chatHistory: req.history ? req.history.slice(-3) : [],
      currentContext: req.currentContext,
      intentDetected: intent.kind,
      deterministicFactBase: replyContent,
      simulationResult,
    }),
  });

  if (llmRes && intent.kind !== 'partner_refusal') {
    replyContent = llmRes.text;
    status = 'success';
    model = llmRes.model;
  }

  // Apply deep linking to the formatted text
  replyContent = formatDeepLinks(replyContent, state);

  const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

  // Build final ChatMessage
  const responseMessage: ChatMessage = {
    id: `msg-${crypto.randomUUID()}`,
    role: 'assistant',
    content: replyContent,
    timestamp: state.clock || new Date().toISOString(),
    actionCards,
    simulationResult,
  };

  // Save Agent Execution Log
  const log: AgentExecutionLog = {
    id: crypto.randomUUID(),
    timestamp: state.clock || new Date().toISOString(),
    agent: 'copilot',
    feature: 'chat',
    action: 'conversational_query',
    accessedEntities: Array.from(accessedEntities),
    actorId: actor.id,
    summary: summary.slice(0, 500),
    status,
    latencyMs,
    model,
  };

  await repo.saveAgentLog(log);

  return responseMessage;
}
