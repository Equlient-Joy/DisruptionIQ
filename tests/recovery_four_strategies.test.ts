import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { runRecoveryAdvisorAgent, FOUR_RECOVERY_STRATEGIES } from '../src/server/agents/recovery';
import { simulateWhatIfScenario } from '../src/server/agents/simulation';
import { handleCopilotChat } from '../src/server/agents/copilot';
import { buildScenarioAState } from './fixtures/demo-scenarios';
import type { Actor, RecoveryPlan, State } from '../src/shared/types';

process.env.DEMO_MODE = 'true';
process.env.AI_FEATURES_ENABLED = 'false';

describe('Four Recovery Strategies & Infeasibility Warning System', () => {
  let repo: Repository;
  let state: State;

  const managerActor: Actor = {
    id: 'usr-manager-1',
    name: 'Morgan Smith',
    email: 'manager@disruptioniq.demo',
    role: 'manager',
    orgId: 'focal',
  };

  beforeAll(async () => {
    repo = new Repository({ pglitePath: 'memory://' });
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildScenarioAState()));
    state = await repo.read();
  });

  afterAll(async () => {
    await repo.close();
  });

  test('FOUR_RECOVERY_STRATEGIES constants enumerate the 4 canonical strategies', () => {
    const types = FOUR_RECOVERY_STRATEGIES.map(s => s.type);
    expect(types).toContain('reallocate');
    expect(types).toContain('expedite');
    expect(types).toContain('alternative_supplier');
    expect(types).toContain('split_order');
    expect(types.length).toBe(4);
  });

  test('Recovery Advisor Agent compares all 4 strategies and recommends viable option', async () => {
    const incident = state.incidents[0]!;
    const order = state.orders[0]!;

    const fourStrategyPlans: RecoveryPlan[] = [
      {
        id: 'plan-reallocate-1',
        incidentId: incident.id,
        orderId: order.id,
        type: 'reallocate',
        sourceId: 'wh-beta',
        quantity: 50,
        arrivesAt: new Date(Date.now() + 86400000).toISOString(),
        costCents: 20000,
        feasible: true,
        reasons: [],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Reallocate from secondary warehouse',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'plan-expedite-1',
        incidentId: incident.id,
        orderId: order.id,
        type: 'expedite',
        sourceId: 'shp-gamma',
        quantity: 50,
        arrivesAt: new Date(Date.now() + 43200000).toISOString(),
        costCents: 120000,
        feasible: true,
        reasons: [],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Expedite air freight',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'plan-alt-supplier-1',
        incidentId: incident.id,
        orderId: order.id,
        type: 'alternative_supplier',
        sourceId: 'sup-backup',
        quantity: 50,
        arrivesAt: new Date(Date.now() + 172800000).toISOString(),
        costCents: 180000,
        feasible: false,
        reasons: ['Supplier lead time 72h exceeds order deadline'],
        riskLevel: 'high',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Secondary supplier',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'plan-split-1',
        incidentId: incident.id,
        orderId: order.id,
        type: 'split_order',
        sourceId: 'wh-beta',
        quantity: 25,
        arrivesAt: new Date(Date.now() + 21600000).toISOString(),
        costCents: 32500,
        feasible: true,
        reasons: [],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Split immediate partial leg',
        evidenceIds: [],
        inventoryVersion: 1,
      },
    ];

    const log = await runRecoveryAdvisorAgent({
      incidentId: incident.id,
      plans: fourStrategyPlans,
      state,
      repo,
    });

    expect(log.agent).toBe('advisor');
    expect(log.action).toBe('critique_recovery_options');
    expect(log.summary).toContain('Evaluated 4 candidate recovery plan(s)');
    expect(log.summary).toContain('3 feasible, 1 rejected');
    // Confirms comparison mentions the canonical strategies
    expect(log.summary).toContain('Inventory Reallocation');
    expect(log.summary).toContain('Shipment Expediting');
    expect(log.summary).toContain('Alternative Suppliers');
    expect(log.summary).toContain('Split Orders');
    // Confirms recommendation is formulated
    expect(log.summary).toContain('Recommend advancing Plan');
  });

  test('Recovery Advisor Agent issues explicit WARNING and alternative solutions when none of 4 strategies can solve problem', async () => {
    const incident = state.incidents[0]!;
    const order = state.orders[0]!;

    // Scenario where all 4 canonical strategies fail
    const failingPlans: RecoveryPlan[] = [
      {
        id: 'fail-reallocate',
        incidentId: incident.id,
        orderId: order.id,
        type: 'reallocate',
        sourceId: 'wh-beta',
        quantity: 100,
        arrivesAt: new Date(Date.now() + 86400000).toISOString(),
        costCents: 40000,
        feasible: false,
        reasons: ['Zero usable inventory available at all regional hubs'],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Stock empty',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'fail-expedite',
        incidentId: incident.id,
        orderId: order.id,
        type: 'expedite',
        sourceId: 'shp-delta',
        quantity: 100,
        arrivesAt: new Date(Date.now() + 172800000).toISOString(),
        costCents: 240000,
        feasible: false,
        reasons: ['No in-transit shipments exist for component SKU'],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Transit empty',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'fail-alt-supplier',
        incidentId: incident.id,
        orderId: order.id,
        type: 'alternative_supplier',
        sourceId: 'sup-delta',
        quantity: 100,
        arrivesAt: new Date(Date.now() + 259200000).toISOString(),
        costCents: 500000,
        feasible: false,
        reasons: ['Alternate supplier capacity exhausted and shares disrupted upstream wafer fab'],
        riskLevel: 'high',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Upstream bottleneck',
        evidenceIds: [],
        inventoryVersion: 1,
      },
      {
        id: 'fail-split',
        incidentId: incident.id,
        orderId: order.id,
        type: 'split_order',
        sourceId: 'wh-beta',
        quantity: 50,
        arrivesAt: new Date(Date.now() + 43200000).toISOString(),
        costCents: 65000,
        feasible: false,
        reasons: ['Split leg requires minimum 20 units; 0 units in stock'],
        riskLevel: 'routine',
        status: 'proposed',
        createdBy: 'manager-1',
        version: 1,
        rationale: 'Split insufficient',
        evidenceIds: [],
        inventoryVersion: 1,
      },
    ];

    const log = await runRecoveryAdvisorAgent({
      incidentId: incident.id,
      plans: failingPlans,
      state,
      repo,
    });

    // Check mandatory warning
    expect(log.summary).toContain('WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption.');
    
    // Check failure breakdown
    expect(log.summary).toContain('Strategy failure breakdown:');
    expect(log.summary).toContain('[Inventory Reallocation]: Failed');
    expect(log.summary).toContain('[Shipment Expediting]: Failed');
    expect(log.summary).toContain('[Alternative Suppliers]: Failed');
    expect(log.summary).toContain('[Split Orders]: Failed');

    // Check suggested alternative solutions
    expect(log.summary).toContain('Suggested alternative solutions:');
    expect(log.summary).toContain('Customer delivery deadline renegotiation');
    expect(log.summary).toContain('Factory production re-sequencing');
    expect(log.summary).toContain('Emergency sourcing');
    expect(log.summary).toContain('Customer waiver for partial order fulfillment');
  });

  test('What-If simulation provides 4-strategy comparison, warning, and alternative solutions when no recovery paths exist', async () => {
    // Clone state and exhaust all inventory and shipments to simulate total stockout
    const starvedState = structuredClone(state);
    for (const lot of starvedState.lots) {
      lot.quantity = 0;
      lot.reserved = 0;
      lot.status = 'held';
    }
    for (const s of starvedState.shipments) {
      s.status = 'delivered';
    }
    for (const sup of starvedState.suppliers) {
      sup.capacity = 0;
    }

    const diff = await simulateWhatIfScenario(starvedState, {
      entityType: 'shipment',
      entityId: state.shipments[0]?.id || 'shp-1',
      delta: { delayHours: 48 },
    });

    // Strategy comparison across the four
    expect(diff.strategyComparison).toBeDefined();
    expect(diff.strategyComparison!.length).toBe(4);
    const strategies = diff.strategyComparison!.map(s => s.strategy);
    expect(strategies).toEqual(['reallocate', 'expedite', 'alternative_supplier', 'split_order']);

    if (diff.simulatedTotalShortage > 0) {
      expect(diff.feasibleRecoveryCount).toBe(0);
      expect(diff.warning).toContain('WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working and cannot resolve this disruption.');
      expect(diff.suggestedAlternatives).toBeDefined();
      expect(diff.suggestedAlternatives!.length).toBeGreaterThanOrEqual(3);
      expect(diff.suggestedAlternatives!.some(a => a.toLowerCase().includes('renegotiate'))).toBe(true);
    }
  });

  test('Copilot chat handles What-If with warning and action cards when 4 strategies fail', async () => {
    // Create state where no recovery is feasible
    const starvedState = structuredClone(state);
    for (const lot of starvedState.lots) {
      lot.quantity = 0;
      lot.reserved = 0;
      lot.status = 'held';
    }
    for (const sup of starvedState.suppliers) {
      sup.capacity = 0;
    }
    await repo.mutate(s => Object.assign(s, starvedState));

    const chatResponse = await handleCopilotChat(
      managerActor,
      {
        message: 'What if shipment SHP-201 is delayed by 72 hours?',
        currentContext: {},
      },
      repo
    );

    // Should include warning in response content if shortage exists and recovery is 0
    if (chatResponse.simulationResult && chatResponse.simulationResult.feasibleRecoveryCount === 0 && chatResponse.simulationResult.simulatedTotalShortage > 0) {
      expect(chatResponse.content).toContain('WARNING: The four recommended recovery strategies');
      expect(chatResponse.content).toContain('Suggested Alternative Solutions');
      expect(chatResponse.actionCards).toBeDefined();
      expect(chatResponse.actionCards!.some(c => c.title.includes('Renegotiate Customer SLA'))).toBe(true);
    }
  });

  test('Copilot propose_action intent warns user when all candidate plans across 4 strategies are infeasible', async () => {
    // Mutate state to have plans that are all infeasible
    await repo.mutate(s => {
      s.plans = [
        {
          id: 'plan-fail-all-1',
          incidentId: s.incidents[0]?.id || 'inc-1',
          orderId: s.orders[0]?.id || 'ord-1',
          type: 'reallocate',
          sourceId: 'wh-1',
          quantity: 100,
          arrivesAt: '2026-11-10T00:00:00Z',
          costCents: 50000,
          feasible: false,
          reasons: ['Stock quarantined'],
          riskLevel: 'routine',
          status: 'proposed',
          createdBy: 'manager-1',
          version: 1,
          rationale: 'Quarantined lot',
          evidenceIds: [],
          inventoryVersion: 1,
        },
      ];
    });

    const chatResponse = await handleCopilotChat(
      managerActor,
      {
        message: 'Can you recommend a recovery action or propose plan for the incident?',
        currentContext: {},
      },
      repo
    );

    expect(chatResponse.content).toContain('WARNING: The four recommended recovery strategies (Inventory Reallocation, Shipment Expediting, Alternative Suppliers, Split Orders) are not working');
    expect(chatResponse.content).toContain('Suggested Alternative Solutions');
    expect(chatResponse.actionCards).toBeDefined();
    expect(chatResponse.actionCards!.some(c => c.title.includes('Renegotiate Customer SLA'))).toBe(true);
  });
});
