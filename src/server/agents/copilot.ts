import type {
  ActionCard,
  Actor,
  AgentExecutionLog,
  ChatMessage,
  Incident,
  RawEvent,
  RecoveryPlan,
  SimulationDiff,
  State,
} from '../../shared/types';
import type { Repository } from '../repository';
import { upstreamPaths } from '../../domain/common';
import { getImpact } from '../../domain/impact';
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
  if (
    /\b(list|show|view|find|query|all|who|what|which|how\s+many|check|get|describe|status\s+of)\b/i.test(lower) ||
    /\b(orders?|shipments?|lots?|suppliers?|warehouses?|tasks?|inventory)\b/i.test(lower)
  ) {
    if (/\b(orders?)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'orders' };
    if (/\b(shipments?)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'shipments' };
    if (/\b(lots?|inventory|stock)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'lots' };
    if (/\b(suppliers?|vendors?)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'suppliers' };
    if (/\b(warehouses?|hubs?)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'warehouses' };
    if (/\b(tasks?|action\s+items?)\b/i.test(lower)) return { kind: 'query_entities', queryType: 'tasks' };
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

    let recoverySection = '';
    if (diff.feasibleRecoveryCount > 0 && diff.recommendedPlanType) {
      recoverySection =
        `• **Feasible Recovery Options**: ${diff.feasibleRecoveryCount} candidate path(s) verified on-time\n` +
        `• **Recommended Strategy**: \`${diff.recommendedPlanType}\`\n\n`;
    } else if (diff.warning) {
      recoverySection =
        `• **Feasible Recovery Options**: 0 viable paths\n` +
        `• **Recommended Strategy**: None viable\n\n` +
        `> [!WARNING]\n` +
        `> **${diff.warning}**\n\n` +
        `**Suggested Alternative Solutions**:\n` +
        (diff.suggestedAlternatives || [])
          .map((alt, idx) => `  ${idx + 1}. ${alt}`)
          .join('\n') +
        `\n\n`;
    } else {
      recoverySection =
        `• **Feasible Recovery Options**: ${diff.feasibleRecoveryCount} candidate path(s)\n` +
        `• **Recommended Plan Type**: None required\n\n`;
    }

    replyContent =
      `### What-If Simulation Results: ${diff.scenarioDescription}\n\n` +
      `• **Exposed Orders**: Baseline ${diff.baselineExposedOrders} → Simulated ${diff.simulatedExposedOrders} ` +
      `(${diff.deltaExposedOrders >= 0 ? `+${diff.deltaExposedOrders}` : diff.deltaExposedOrders})\n` +
      `• **Total Demand Shortage**: Baseline ${diff.baselineTotalShortage} units → Simulated ${diff.simulatedTotalShortage} units ` +
      `(${diff.deltaShortage >= 0 ? `+${diff.deltaShortage}` : diff.deltaShortage})\n` +
      recoverySection +
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
    } else if (diff.warning) {
      actionCards = [
        runProposeRecoveryActionTool({
          cardType: 'filter_prompt',
          title: 'Renegotiate Customer SLA',
          detail: 'The 4 standard recovery strategies cannot resolve shortage. Review customer contract delivery grace terms.',
          risk: 'high',
          buttonLabel: 'Review Customer SLA',
        }),
        runProposeRecoveryActionTool({
          cardType: 'filter_prompt',
          title: 'Emergency Sourcing Review',
          detail: 'Explore unapproved or secondary suppliers beyond standard tier-1 catalog.',
          risk: 'high',
          buttonLabel: 'Find Alternate Sources',
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
      const feasiblePlans = plans.filter(p => p.feasible);

      if (feasiblePlans.length > 0) {
        const p = feasiblePlans[0];
        accessedEntities.add(p.id);
        accessedEntities.add(p.incidentId);
        accessedEntities.add(p.orderId);

        replyContent =
          `A feasible recovery option is available for incident ${p.incidentId}: ` +
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
      } else {
        // Plans exist but none of the 4 standard strategies are viable
        const p = plans[0];
        accessedEntities.add(p.id);
        accessedEntities.add(p.incidentId);

        replyContent =
          `> [!WARNING]\n` +
          `> **WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption.**\n\n` +
          `All ${plans.length} candidate recovery plan(s) evaluated across the 4 standard strategies failed operational constraints.\n\n` +
          `**Suggested Alternative Solutions**:\n` +
          `1. Renegotiate customer delivery deadline or request SLA grace window extension.\n` +
          `2. Re-sequence factory production schedules to assemble products not dependent on the disrupted component.\n` +
          `3. Fast-track emergency qualification of alternate non-tier-1 or spot-market suppliers.\n` +
          `4. Propose partial shipment fulfillment with remaining units backordered.\n` +
          `5. Authorize manufacturing overtime / extra shifts to compress assembly cycle.`;

        actionCards = [
          runProposeRecoveryActionTool({
            cardType: 'filter_prompt',
            title: 'Renegotiate Customer SLA',
            detail: 'The 4 standard recovery strategies cannot resolve shortage. Review customer contract delivery grace terms.',
            risk: 'high',
            buttonLabel: 'Review Customer SLA',
          }),
          runProposeRecoveryActionTool({
            cardType: 'filter_prompt',
            title: 'Emergency Sourcing Review',
            detail: 'Explore unapproved or secondary suppliers beyond standard tier-1 catalog.',
            risk: 'high',
            buttonLabel: 'Find Alternate Sources',
          }),
        ];
      }
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
      for (const item of items) {
        if (typeof item.id === 'string') accessedEntities.add(item.id);
      }

      let formattedList = '';
      if (intent.queryType === 'suppliers') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(s => `• **${s.name || s.id}** ([${s.id}](app://suppliers/${s.id})): Tier ${s.tier ?? 1}, Lead time: ${s.leadHours ? `${s.leadHours}h` : 'std'}, Commitments: ${(s.commitments || []).length}`)
          .join('\n');
      } else if (intent.queryType === 'warehouses') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(w => `• **${w.name || w.id}** ([${w.id}](app://warehouses/${w.id})): Capacity ${(w.capacity || 0).toLocaleString()} units`)
          .join('\n');
      } else if (intent.queryType === 'lots') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(l => `• **Lot [${l.id}](app://lots/${l.id})**: ${l.quantity} units of \`${l.itemId}\` at [${l.warehouseId}](app://warehouses/${l.warehouseId}) (Available: ${Math.max(0, l.quantity - (l.reserved || 0))}, Reserved: ${l.reserved || 0}, Status: \`${l.status}\`)`)
          .join('\n');
      } else if (intent.queryType === 'shipments') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(s => `• **Shipment [${s.id}](app://shipments/${s.id})**: ${s.quantity} units of \`${s.itemId}\` from [${s.supplierId}](app://suppliers/${s.supplierId}) to [${s.warehouseId}](app://warehouses/${s.warehouseId}) (ETA: ${s.eta}, Status: \`${s.status}\`)`)
          .join('\n');
      } else if (intent.queryType === 'orders') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(o => `• **Order [${o.id}](app://orders/${o.id})** (${o.customer}): ${o.quantity} units of \`${o.itemId}\` (Fulfilled: ${o.fulfilled || 0}, Deadline: ${o.deadline}, Priority: \`${o.priority}\`)`)
          .join('\n');
      } else if (intent.queryType === 'tasks') {
        formattedList = (items as any[])
          .slice(0, 10)
          .map(t => `• **Task [${t.id}](app://collaboration/${t.id})**: ${t.title} (Status: \`${t.status}\`, Org: ${t.orgId})`)
          .join('\n');
      } else {
        const sample = items.slice(0, 5);
        formattedList = sample
          .map(item => `• **${item.id || 'Item'}**: ${JSON.stringify(item)}`)
          .join('\n');
      }

      replyContent =
        `Found **${items.length} ${intent.queryType}** in PGlite matching your permissions:\n\n` +
        `${formattedList}${items.length > 10 ? `\n...and ${items.length - 10} more records in database.` : ''}`;

      summary = `Queried PGlite ${intent.queryType}: ${items.length} records retrieved.`;
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

    const partnerSupplierIds = new Set(state.suppliers.filter(s => s.orgId === actor.orgId).map(s => s.id));
    const visibleSuppliers = isPartner ? state.suppliers.filter(s => s.orgId === actor.orgId) : state.suppliers;
    const visibleWarehouses = isPartner ? [] : state.warehouses;
    const visibleLots = isPartner ? [] : state.lots;
    const visibleShipments = isPartner ? state.shipments.filter(s => partnerSupplierIds.has(s.supplierId)) : state.shipments;
    const visibleOrders = isPartner ? [] : state.orders;

    for (const s of visibleSuppliers) accessedEntities.add(s.id);
    for (const w of visibleWarehouses) accessedEntities.add(w.id);
    for (const s of visibleShipments) accessedEntities.add(s.id);

    // Also search PGlite for any mentioned entity IDs or search terms
    const mentionedIds = [
      ...(req.message.match(/\b(?:ORD|order)-[\w-]+/gi) || []),
      ...(req.message.match(/\b(?:SHP|shipment)-[\w-]+/gi) || []),
      ...(req.message.match(/\b(?:LOT|lot)-[\w-]+/gi) || []),
      ...(req.message.match(/\b(?:SUP|supplier)-[\w-]+/gi) || []),
      ...(req.message.match(/\b(?:WH|warehouse)-[\w-]+/gi) || []),
      ...(req.message.match(/\b(?:INC|incident|scenario)-[\w-]+/gi) || []),
    ];

    for (const mid of mentionedIds) {
      accessedEntities.add(mid);
    }

    const searchMatch = req.message.match(/\b(?:search|find)\s+(?:for\s+)?["']?([A-Za-z0-9_-]+)["']?/i);
    const searchTerms = [
      ...mentionedIds,
      ...(searchMatch && searchMatch[1] && !['the', 'our', 'all', 'any', 'database'].includes(searchMatch[1].trim().toLowerCase()) ? [searchMatch[1].trim()] : []),
    ];

    const pgliteSearchResults: Record<string, any[]> = {};
    for (const term of searchTerms) {
      if (term.length > 1) {
        try {
          const results = await repo.searchAllTables(term, 3);
          for (const [tbl, rows] of Object.entries(results)) {
            if (!pgliteSearchResults[tbl]) pgliteSearchResults[tbl] = [];
            pgliteSearchResults[tbl].push(...rows);
            for (const r of rows) {
              if (r.id) accessedEntities.add(r.id);
            }
          }
        } catch {
          // Graceful fallback
        }
      }
    }

    let searchSection = '';
    const matchingTables = Object.keys(pgliteSearchResults);
    if (matchingTables.length > 0) {
      searchSection =
        `\n\n**PGlite Database Search Matches**:\n` +
        matchingTables
          .map(tbl => `• **Table \`${tbl}\`**: ${pgliteSearchResults[tbl].map(r => r.id || r.name || r.itemId || 'match').slice(0, 3).join(', ')}`)
          .join('\n');
    }

    const totalStock = visibleLots.reduce((acc, l) => acc + (l.quantity || 0), 0);
    const reservedStock = visibleLots.reduce((acc, l) => acc + (l.reserved || 0), 0);
    const availableStock = Math.max(0, totalStock - reservedStock);
    const openShortages = isPartner ? 0 : getImpact(state).filter(i => i.shortage > 0).length;

    replyContent =
      `Hello ${actor.name}. You are connected as **${actor.role.toUpperCase()}** (${actor.orgId}).\n\n` +
      `**PGlite Live Database Status** (Clock: ${state.clock}):\n` +
      `• **Suppliers**: ${visibleSuppliers.length} active registered supplier(s)\n` +
      (!isPartner ? `• **Warehouses**: ${visibleWarehouses.length} hub(s) monitored\n` : '') +
      (!isPartner ? `• **Inventory**: ${visibleLots.length} lot(s) with ${totalStock.toLocaleString()} total units (${availableStock.toLocaleString()} available, ${reservedStock.toLocaleString()} reserved)\n` : '') +
      `• **Shipments**: ${visibleShipments.length} shipment(s) tracked in transit/scheduled\n` +
      (!isPartner ? `• **Customer Orders**: ${visibleOrders.length} order(s) (${openShortages} with open shortage risk)\n` : '') +
      `• **Active Incidents**: ${sharedIncidents.length} incident(s) visible\n` +
      `• **Integration Feeds**: ${state.integrationOutage ? 'Outage active (events queued)' : 'All feeds operational'}` +
      `${searchSection}\n\n` +
      `You can ask me to inspect any supplier, warehouse inventory, order deadlines, simulate shipment delays, or investigate incident root causes.`;

    summary = `PGlite status overview (${visibleSuppliers.length} suppliers, ${visibleLots.length} lots, ${visibleShipments.length} shipments, ${sharedIncidents.length} incidents) provided to ${actor.role} (${actor.orgId}).`;
  }

  // ---------------------------------------------------------
  // Grounded LLM Enhancement (if configured)
  // ---------------------------------------------------------
  const isPartner = actor.orgId !== 'focal';
  const partnerSupplierIds = new Set(state.suppliers.filter(s => s.orgId === actor.orgId).map(s => s.id));
  const visibleSuppliers = isPartner ? state.suppliers.filter(s => s.orgId === actor.orgId) : state.suppliers;
  const visibleWarehouses = isPartner ? [] : state.warehouses;
  const visibleLots = isPartner ? [] : state.lots;
  const visibleShipments = isPartner ? state.shipments.filter(s => partnerSupplierIds.has(s.supplierId)) : state.shipments;
  const visibleOrders = isPartner ? [] : state.orders;
  const visibleTasks = isPartner ? state.tasks.filter(t => t.orgId === actor.orgId) : state.tasks;
  const sharedIncidents = state.incidents.filter(i => isPartner ? i.memberOrgIds.includes(actor.orgId) : true);

  const systemPrompt =
    `${buildPersonaInstructions(actor)}\n\n` +
    `CRITICAL AI GROUNDING RULES:\n` +
    `- You MUST answer the user's inquiry using the real PGlite supply chain records provided in the user prompt.\n` +
    `- State exact names, quantities, dates, statuses, and numbers directly from the retrieved database records.\n` +
    `- Always format entity IDs with deep links: [Entity-ID](app://type/Entity-ID), e.g. [SUP-01](app://suppliers/SUP-01), [SHP-01](app://shipments/SHP-01), [ORD-101](app://orders/ORD-101), [WH-01](app://warehouses/WH-01), [LOT-01](app://lots/LOT-01), [INC-01](app://incidents/INC-01).\n` +
    `- Never invent fictional inventory, shipments, or suppliers.\n` +
    `- If the user asks a specific question about an entity, table, or status, provide a direct, insightful, and comprehensive operational answer.`;

  const llmRes = await callAgentLLM({
    systemPrompt,
    userPrompt: JSON.stringify({
      userMessage: req.message,
      chatHistory: req.history ? req.history.slice(-3) : [],
      currentContext: req.currentContext,
      intentDetected: intent.kind,
      retrievedDatabaseContext: {
        suppliers: visibleSuppliers.slice(0, 15).map(s => ({ id: s.id, name: s.name, tier: s.tier, leadHours: s.leadHours, commitments: (s.commitments || []).length })),
        warehouses: visibleWarehouses.slice(0, 10).map(w => ({ id: w.id, name: w.name, capacity: w.capacity })),
        inventoryLots: visibleLots.slice(0, 20).map(l => ({ id: l.id, itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity, reserved: l.reserved, status: l.status })),
        shipments: visibleShipments.slice(0, 20).map(s => ({ id: s.id, supplierId: s.supplierId, warehouseId: s.warehouseId, itemId: s.itemId, quantity: s.quantity, eta: s.eta, status: s.status })),
        customerOrders: visibleOrders.slice(0, 20).map(o => ({ id: o.id, customer: o.customer, itemId: o.itemId, quantity: o.quantity, fulfilled: o.fulfilled, deadline: o.deadline, priority: o.priority, status: o.status })),
        activeIncidents: sharedIncidents.slice(0, 10).map(i => ({ id: i.id, title: i.title, status: i.status, entityId: i.entityId, affectedOrderIds: i.affectedOrderIds })),
        tasks: visibleTasks.slice(0, 10).map(t => ({ id: t.id, title: t.title, status: t.status, orgId: t.orgId })),
      },
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
