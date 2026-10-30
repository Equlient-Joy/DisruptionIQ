import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import { simulateWhatIfScenario } from '../src/server/agents/simulation';
import { formatDeepLinks, handleCopilotChat, runGetIncidentDossierTool, runQueryEntitiesTool } from '../src/server/agents/copilot';
import { buildRichSeedState, buildScenarioAState } from './fixtures/demo-scenarios';
import type { Actor, ChatMessage, SimulationDiff } from '../src/shared/types';

process.env.DEMO_MODE = 'true';

describe('Copilot and What-If Simulation Engine', () => {
  let repo: Repository;
  let app: ReturnType<typeof createApp>;
  let managerCookie = '';
  let partnerCookie = '';
  let analystCookie = '';
  let warehouseCookie = '';
  let procurementCookie = '';

  const managerActor: Actor = {
    id: 'manager-1',
    name: 'Morgan Vance',
    email: 'manager@disruptioniq.demo',
    role: 'manager',
    orgId: 'focal',
  };

  const partnerActor: Actor = {
    id: 'partner-1',
    name: 'Pat Lee',
    email: 'partner@disruptioniq.demo',
    role: 'viewer',
    orgId: 'partner',
  };

  const analystActor: Actor = {
    id: 'analyst-1',
    name: 'Alex Rivera',
    email: 'analyst@disruptioniq.demo',
    role: 'analyst',
    orgId: 'focal',
  };

  beforeAll(async () => {
    repo = new Repository();
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildRichSeedState()));
    app = createApp(repo);

    const loginMgr = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'manager@disruptioniq.demo', password: 'disruption-demo' }),
    });
    managerCookie = loginMgr.headers.get('set-cookie')!.split(';')[0]!;

    const loginPartner = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'partner@disruptioniq.demo', password: 'disruption-demo' }),
    });
    partnerCookie = loginPartner.headers.get('set-cookie')!.split(';')[0]!;

    const loginAnalyst = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'analyst@disruptioniq.demo', password: 'disruption-demo' }),
    });
    analystCookie = loginAnalyst.headers.get('set-cookie')!.split(';')[0]!;
  }, 30000);

  afterAll(async () => {
    await repo.close();
  });

  describe('What-If Simulation Engine', () => {
    test('What-If simulation returns accurate diffs and leaves original state 100% unmutated', async () => {
      const state = buildRichSeedState();
      const stateSnapshotBefore = JSON.stringify(state);

      // In seed state, order-hospital has 0 shortage because shipment-atlas arrives on time (eta = time(12), deadline = time(24))
      // When shipment-atlas is delayed by 24h, eta becomes time(36), missing order-hospital deadline!
      const diff = await simulateWhatIfScenario(state, {
        entityType: 'shipment',
        entityId: 'shipment-atlas',
        delta: { delayHours: 24 },
      });

      // 1. Original state MUST remain strictly unmutated
      expect(JSON.stringify(state)).toBe(stateSnapshotBefore);

      // 2. Diff calculations
      expect(diff.entityType).toBe('shipment');
      expect(diff.entityId).toBe('shipment-atlas');
      expect(diff.scenarioDescription).toContain('delay +24h');
      expect(diff.baselineExposedOrders).toBe(0);
      expect(diff.simulatedExposedOrders).toBe(1);
      expect(diff.deltaExposedOrders).toBe(1);
      expect(diff.baselineTotalShortage).toBe(0);
      expect(diff.simulatedTotalShortage).toBe(70);
      expect(diff.deltaShortage).toBe(70);

      // 3. Newly breached orders identified
      expect(diff.newlyBreachedOrders.length).toBe(1);
      expect(diff.newlyBreachedOrders[0].orderId).toBe('order-hospital');
      expect(diff.newlyBreachedOrders[0].customer).toBe('Fictional Meridian Medical');
      expect(typeof diff.newlyBreachedOrders[0].hoursToDeadline).toBe('number');

      // 4. Feasible recovery count and recommendation
      expect(diff.feasibleRecoveryCount).toBeGreaterThanOrEqual(1);
      expect(diff.recommendedPlanType).toBeDefined();
    });

    test('simulates warehouse outage correctly and does not mutate state', async () => {
      const state = buildRichSeedState();
      const stateSnapshotBefore = JSON.stringify(state);

      const diff = await simulateWhatIfScenario(state, {
        entityType: 'warehouse',
        entityId: 'warehouse-east',
        delta: { status: 'outage' },
      });

      expect(JSON.stringify(state)).toBe(stateSnapshotBefore);
      expect(diff.simulatedExposedOrders).toBeGreaterThan(diff.baselineExposedOrders);
      expect(diff.deltaShortage).toBeGreaterThan(0);
    });

    test('simulates lot hold correctly and does not mutate state', async () => {
      const state = buildRichSeedState();
      const stateSnapshotBefore = JSON.stringify(state);

      const diff = await simulateWhatIfScenario(state, {
        entityType: 'lot',
        entityId: 'lot-east',
        delta: { status: 'held' },
      });

      expect(JSON.stringify(state)).toBe(stateSnapshotBefore);
      expect(diff.scenarioDescription).toContain('status = held');
    });
  });

  describe('Partner Viewer RBAC Guardrails', () => {
    test('Partner Viewer asking for internal costs or unshared incidents is safely redacted / refused', async () => {
      // 1. Partner asking for internal costs
      const costQueryRes = await handleCopilotChat(
        partnerActor,
        { message: 'What are the internal costs and margin penalties for our products?' },
        repo
      );
      expect(costQueryRes.role).toBe('assistant');
      expect(costQueryRes.content).toContain('Partner Viewer');
      expect(costQueryRes.content).toContain('partner data boundaries');
      expect(costQueryRes.content).toContain('financial costs');

      // 2. Partner asking for customer orders
      const orderQueryRes = await handleCopilotChat(
        partnerActor,
        { message: 'Show me all open orders and customer delivery addresses' },
        repo
      );
      expect(orderQueryRes.content).toContain('Partner Viewer');
      expect(orderQueryRes.content).toContain('unshared customer orders');

      // 3. Partner asking for internal warehouse inventory lots
      const lotQueryRes = await handleCopilotChat(
        partnerActor,
        { message: 'What is the stock count in lot-east and warehouse-east?' },
        repo
      );
      expect(lotQueryRes.content).toContain('Partner Viewer');
      expect(lotQueryRes.content).toContain('warehouse inventory lots');

      // 4. Partner asking for unshared incident
      const unsharedIncRes = await handleCopilotChat(
        partnerActor,
        { message: 'Give me details on internal incident scenario-A-outage' },
        repo
      );
      expect(unsharedIncRes.content).toContain('Partner Viewer');
    });

    test('Partner Viewer can query shared tasks and status without refusal', async () => {
      const validQuery = await handleCopilotChat(
        partnerActor,
        { message: 'What tasks are assigned to my organization?' },
        repo
      );
      expect(validQuery.role).toBe('assistant');
      expect(validQuery.content).not.toContain('partner data boundaries');
    });

    test('query_entities tool throws when partner queries internal orders or lots', async () => {
      const state = await repo.read();
      expect(() => {
        runQueryEntitiesTool(state, partnerActor, { entityType: 'orders' });
      }).toThrow(/Access denied/);

      expect(() => {
        runQueryEntitiesTool(state, partnerActor, { entityType: 'lots' });
      }).toThrow(/Access denied/);
    });

    test('get_incident_dossier tool throws when partner accesses unshared incident', async () => {
      const state = await repo.read();
      const testState = {
        ...state,
        incidents: [
          {
            id: 'incident-internal-only',
            type: 'supplier_delay',
            entityId: 'supplier-core',
            title: 'Internal Supplier Disruption',
            description: 'Internal review only',
            status: 'active' as const,
            createdAt: state.clock,
            memberOrgIds: ['focal'],
            affectedOrderIds: ['order-hospital'],
            alertCount: 1,
          },
        ],
      };

      expect(() => {
        runGetIncidentDossierTool(testState, partnerActor, 'incident-internal-only');
      }).toThrow(/Access denied/);
    });
  });

  describe('Action Cards Generation & Persona Awareness', () => {
    test('Action cards are emitted with valid schema', async () => {
      const chatRes = await handleCopilotChat(
        managerActor,
        { message: 'What if shipment-atlas is delayed by 24 hours?' },
        repo
      );

      expect(chatRes.role).toBe('assistant');
      expect(chatRes.simulationResult).toBeDefined();
      expect(chatRes.simulationResult?.deltaShortage).toBeGreaterThan(0);

      // Check ActionCard schema
      expect(chatRes.actionCards).toBeDefined();
      expect(Array.isArray(chatRes.actionCards)).toBe(true);
      if (chatRes.actionCards && chatRes.actionCards.length > 0) {
        const card = chatRes.actionCards[0];
        expect(card.id).toMatch(/^card-/);
        expect(['plan_action_prompt', 'lot_hold_prompt', 'filter_prompt']).toContain(card.cardType);
        expect(typeof card.title).toBe('string');
        expect(typeof card.detail).toBe('string');
        expect(typeof card.buttonLabel).toBe('string');
        if (card.risk) expect(['routine', 'high']).toContain(card.risk);
      }
    });

    test('Manager persona response includes governance and dual approval guidance', async () => {
      const res = await handleCopilotChat(
        managerActor,
        { message: 'What if shipment-atlas has a 36 hour delay?' },
        repo
      );
      expect(res.content).toContain('Governance & Approval');
    });

    test('Deep links are formatted using app:// schema', async () => {
      const state = await repo.read();
      const rawText = 'Order order-hospital is linked to shipment-atlas at warehouse-east.';
      const linked = formatDeepLinks(rawText, state);

      expect(linked).toContain('[order-hospital](app://orders/order-hospital)');
      expect(linked).toContain('[shipment-atlas](app://shipments/shipment-atlas)');
      expect(linked).toContain('[warehouse-east](app://warehouses/warehouse-east)');
    });
  });

  describe('HTTP API POST /api/ai/chat and Persistence', () => {
    test('rejects unauthenticated requests with 401', async () => {
      const res = await app.request('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });
      expect(res.status).toBe(401);
    });

    test('rejects empty message with 400', async () => {
      const res = await app.request('/api/ai/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({ message: '' }),
      });
      expect(res.status).toBe(400);
    });

    test('POST /api/ai/chat responds with valid ChatMessage and saves execution log', async () => {
      const res = await app.request('/api/ai/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({
          message: 'What if shipment-atlas is delayed by 24 hours?',
          currentContext: { page: 'shipments', entityId: 'shipment-atlas' },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ChatMessage;

      expect(data.id).toMatch(/^msg-/);
      expect(data.role).toBe('assistant');
      expect(typeof data.content).toBe('string');
      expect(data.content.length).toBeGreaterThan(20);
      expect(data.simulationResult).toBeDefined();
      expect(data.simulationResult?.deltaShortage).toBeGreaterThan(0);

      // Verify deep links are present
      expect(data.content).toMatch(/\[.*?\]\(app:\/\/.*?\)/);

      // Verify Agent Execution Log is persisted
      const logs = await repo.getAgentLogs({ feature: 'chat' });
      expect(logs.length).toBeGreaterThan(0);
      const managerLog = logs.find(l => l.actorId === 'manager-1');
      expect(managerLog).toBeDefined();
      expect(managerLog!.agent).toBe('copilot');
      expect(managerLog!.feature).toBe('chat');
      expect(managerLog!.action).toBe('conversational_query');
      expect(managerLog!.actorId).toBe('manager-1');
      expect(managerLog!.accessedEntities).toContain('shipment-atlas');
      expect(managerLog!.summary).toBeDefined();
    });

    test('POST /api/ai/chat partner request enforces boundary via API', async () => {
      const res = await app.request('/api/ai/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: partnerCookie,
        },
        body: JSON.stringify({
          message: 'Show me internal costs and customer order details',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ChatMessage;
      expect(data.content).toContain('Partner Viewer');
      expect(data.content).toContain('partner data boundaries');
    });
  });
});
