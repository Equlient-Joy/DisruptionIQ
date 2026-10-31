import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import { AgentEventBus, type DocumentChunk } from '../src/server/agents/bus';
import { runTriageAgent } from '../src/server/agents/triage';
import { runRecoveryAdvisorAgent } from '../src/server/agents/recovery';
import { runDocumentReconcilerAgent } from '../src/server/agents/document';
import { buildScenarioAState } from './fixtures/demo-scenarios';
import type { EventInput, RawEvent, RecoveryPlan } from '../src/shared/types';

process.env.DEMO_MODE = 'true';
process.env.AI_FEATURES_ENABLED = 'false';

describe('AgentEventBus and Autonomous Agents', () => {
  let repo: Repository;
  let app: ReturnType<typeof createApp>;
  let managerCookie = '';
  let analystCookie = '';

  beforeAll(async () => {
    repo = new Repository();
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildScenarioAState()));
    app = createApp(repo);

    const loginMgr = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'manager@disruptioniq.demo', password: 'disruption-demo' }),
    });
    managerCookie = loginMgr.headers.get('set-cookie')!.split(';')[0]!;

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

  describe('AgentEventBus core mechanics', () => {
    test('strongly-typed event emission and asynchronous error containment', async () => {
      const bus = new AgentEventBus();
      let callCount = 0;
      let errorHandled = false;

      // Register good subscriber
      bus.subscribe('plans:generated', async payload => {
        callCount++;
        expect(payload.incidentId).toBe('test-incident');
      });

      // Register failing subscriber
      bus.subscribe('plans:generated', async () => {
        errorHandled = true;
        throw new Error('Agent internal reasoning failure');
      });

      // Should not throw when publishing
      const mockState = (await repo.read());
      bus.publish('plans:generated', {
        incidentId: 'test-incident',
        plans: [],
        state: mockState,
      });

      await bus.waitForIdle();
      expect(callCount).toBe(1);
      expect(errorHandled).toBe(true);
    });

    test('unsubscribing removes listener cleanly', async () => {
      const bus = new AgentEventBus();
      let calls = 0;
      const unsub = bus.subscribe('disruption:ingested', () => {
        calls++;
      });

      const mockEvent: RawEvent = {
        id: 'ev-test',
        source: 'test',
        type: 'supplier_delay',
        entityId: 'sup-1',
        time: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        status: 'accepted',
        message: 'test',
        payload: { delayHours: 48 },
      };

      bus.publish('disruption:ingested', { event: mockEvent, state: await repo.read() });
      await bus.waitForIdle();
      expect(calls).toBe(1);

      unsub();
      bus.publish('disruption:ingested', { event: mockEvent, state: await repo.read() });
      await bus.waitForIdle();
      expect(calls).toBe(1);
    });
  });

  describe('Triage Agent', () => {
    test('correlates root cause with scoped least privilege and offline fallback', async () => {
      const state = await repo.read();
      const incident = state.incidents[0]!;
      const event: RawEvent = {
        id: 'ev-triage-1',
        source: 'manual',
        type: 'supplier_delay',
        entityId: incident.entityId,
        time: state.clock,
        receivedAt: state.clock,
        status: 'accepted',
        message: 'Delay reported',
        payload: { delayHours: 48 },
      };

      const log = await runTriageAgent({
        event,
        incident,
        state,
        repo,
      });

      expect(log.agent).toBe('triage');
      expect(log.feature).toBe('incidents');
      expect(log.action).toBe('correlate_root_cause');
      expect(log.status).toBe('fallback');
      expect(log.accessedEntities).toContain(incident.id);
      expect(log.accessedEntities).toContain(event.entityId);
      expect(log.summary).toContain(incident.id);
      expect(log.latencyMs).toBeGreaterThanOrEqual(0);

      // Verify log persisted in repository
      const logs = await repo.getAgentLogs({ feature: 'incidents' });
      expect(logs.some(l => l.id === log.id)).toBe(true);
    });
  });

  describe('Recovery Advisor Agent', () => {
    test('critiques candidate recovery plans and synthesizes trade-offs', async () => {
      const state = await repo.read();
      const incident = state.incidents[0]!;

      const mockPlans: RecoveryPlan[] = [
        {
          id: 'plan-feasible-1',
          incidentId: incident.id,
          orderId: state.orders[0]!.id,
          type: 'expedite',
          quantity: 50,
          sourceId: 'sup-alpha',
          arrivesAt: new Date(Date.now() + 3600000).toISOString(),
          costCents: 250000,
          feasible: true,
          reasons: [],
          status: 'proposed',
          createdBy: 'system',
          version: 1,
          rationale: 'Fast air freight',
          evidenceIds: [],
          inventoryVersion: 1,
          riskLevel: 'high',
        },
        {
          id: 'plan-rejected-1',
          incidentId: incident.id,
          orderId: state.orders[0]!.id,
          type: 'reallocate',
          quantity: 50,
          sourceId: 'wh-beta',
          arrivesAt: new Date(Date.now() + 7200000).toISOString(),
          costCents: 10000,
          feasible: false,
          reasons: ['Insufficient available inventory at warehouse wh-beta'],
          status: 'proposed',
          createdBy: 'system',
          version: 1,
          rationale: 'Local reallocation',
          evidenceIds: [],
          inventoryVersion: 1,
          riskLevel: 'routine',
        },
      ];

      const log = await runRecoveryAdvisorAgent({
        incidentId: incident.id,
        plans: mockPlans,
        state,
        repo,
      });

      expect(log.agent).toBe('advisor');
      expect(log.feature).toBe('plans');
      expect(log.action).toBe('critique_recovery_options');
      expect(log.status).toBe('fallback');
      expect(log.accessedEntities).toContain(incident.id);
      expect(log.accessedEntities).toContain('plan-feasible-1');
      expect(log.summary).toContain('Evaluated 2 candidate recovery plan(s)');
      expect(log.summary).toContain('1 feasible');
      expect(log.summary).toContain('1 rejected');

      // Verify log persisted in repository
      const logs = await repo.getAgentLogs({ feature: 'plans' });
      expect(logs.some(l => l.id === log.id)).toBe(true);
    });
  });

  describe('Document Reconciler Agent', () => {
    test('reconciles freight document against expected shipment', async () => {
      const state = await repo.read();
      const shipment = state.shipments[0]!;

      // Add a test document claim to state
      const docId = 'doc-reconcile-test';
      await repo.mutate(s => {
        s.documents.push({
          id: docId,
          filename: 'bill_of_lading_998.pdf',
          fileSizeBytes: 12040,
          pageCount: 1,
          excerpt: `BOL Reference: ${shipment.id}, Cargo Qty: ${shipment.quantity} units`,
          fields: {
            shipmentId: shipment.id,
            quantity: shipment.quantity,
            date: '2026-10-31',
          },
          confidence: 0.95,
          status: 'ready',
          issues: [],
          source: 'PDF text extraction',
          uploadedAt: s.clock,
        });
      });

      const updatedState = await repo.read();
      const chunks: DocumentChunk[] = [
        {
          chunkIndex: 0,
          pageNumber: 1,
          charStart: 0,
          charEnd: 100,
          content: `Bill of Lading for Shipment ${shipment.id} confirmed quantity: ${shipment.quantity} units intact.`,
        },
      ];

      const log = await runDocumentReconcilerAgent({
        documentId: docId,
        chunks,
        state: updatedState,
        repo,
      });

      expect(log.agent).toBe('reconciler');
      expect(log.feature).toBe('documents');
      expect(log.action).toBe('reconcile_freight_document');
      expect(log.status).toBe('fallback');
      expect(log.accessedEntities).toContain(docId);
      expect(log.accessedEntities).toContain(shipment.id);
      expect(log.summary).toContain('Reconciliation confirmed for shipment');
      expect(log.summary).toContain('100% agreement');

      // Verify log persisted in repository
      const logs = await repo.getAgentLogs({ feature: 'documents' });
      expect(logs.some(l => l.id === log.id)).toBe(true);
    });

    test('flags variance when document quantity mismatches shipment', async () => {
      const state = await repo.read();
      const shipment = state.shipments[0]!;

      const docId = 'doc-variance-test';
      await repo.mutate(s => {
        s.documents.push({
          id: docId,
          filename: 'shortage_invoice.pdf',
          fileSizeBytes: 8500,
          pageCount: 1,
          excerpt: `Discrepant Invoice: ${shipment.id}`,
          fields: {
            shipmentId: shipment.id,
            quantity: shipment.quantity - 15, // shortage of 15
            date: '2026-10-31',
          },
          confidence: 0.88,
          status: 'mismatch',
          issues: ['Quantity mismatch'],
          source: 'PDF text extraction',
          uploadedAt: s.clock,
        });
      });

      const updatedState = await repo.read();
      const chunks: DocumentChunk[] = [
        {
          chunkIndex: 0,
          pageNumber: 1,
          charStart: 0,
          charEnd: 100,
          content: `Shortage notice for Shipment ${shipment.id}: Delivered only ${shipment.quantity - 15} units.`,
        },
      ];

      const log = await runDocumentReconcilerAgent({
        documentId: docId,
        chunks,
        state: updatedState,
        repo,
      });

      expect(log.agent).toBe('reconciler');
      expect(log.action).toBe('reconcile_freight_document');
      expect(log.summary).toContain('Reconciliation variance flagged');
      expect(log.summary).toContain('-15 units');
    });
  });

  describe('End-to-End API event bus triggers', () => {
    test('creating another app cannot send this workspace agent logs to another repository', async () => {
      const other = new Repository();
      await other.init();
      createApp(other);
      const before = (await repo.getAgentLogs({ feature: 'incidents' })).length;
      try {
        const state = await repo.read();
        const res = await app.request('/api/events', {
          method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie },
          body: JSON.stringify({ id: 'app-isolation', source: 'operator', type: 'supplier_delay', entityId: state.suppliers[0]!.id, time: new Date(Date.parse(state.clock) + 3600000).toISOString(), payload: { delayHours: 3 } }),
        });
        expect(res.status).toBe(200);
        await repo.agentBus.waitForIdle();
        expect((await repo.getAgentLogs({ feature: 'incidents' })).length).toBe(before + 1);
        expect(await other.getAgentLogs()).toHaveLength(0);
      } finally {
        await other.close();
        createApp(repo);
      }
    }, 30000);
    test('/api/events disruption event publishes to agentBus and triggers triage agent log', async () => {
      const state = await repo.read();
      const supplier = state.suppliers[0]!;

      const eventPayload: EventInput = {
        id: `ev-bus-e2e-${crypto.randomUUID()}`,
        source: 'manual',
        type: 'supplier_delay',
        entityId: supplier.id,
        time: new Date().toISOString(),
        payload: { delayHours: 24 },
      };

      const res = await app.request('/api/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: analystCookie,
        },
        body: JSON.stringify(eventPayload),
      });

      expect(res.status).toBe(200);

      // Wait for agentBus in-flight asynchronous handlers to complete
      await repo.agentBus.waitForIdle();

      const logs = await repo.getAgentLogs({ feature: 'incidents' });
      const matchingLog = logs.find(l => l.accessedEntities.includes(supplier.id));
      expect(matchingLog).toBeDefined();
      expect(matchingLog!.agent).toBe('triage');
      expect(matchingLog!.action).toBe('correlate_root_cause');
    });

    test('/api/plans/generate publishes to agentBus and triggers recovery advisor log', async () => {
      const state = await repo.read();
      const incident = state.incidents[0]!;

      const res = await app.request('/api/plans/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({ incidentId: incident.id }),
      });

      expect(res.status).toBe(200);

      // Wait for agentBus in-flight asynchronous handlers to complete
      await repo.agentBus.waitForIdle();

      const logs = await repo.getAgentLogs({ feature: 'plans' });
      const matchingLog = logs.find(l => l.accessedEntities.includes(incident.id));
      expect(matchingLog).toBeDefined();
      expect(matchingLog!.agent).toBe('advisor');
      expect(matchingLog!.action).toBe('critique_recovery_options');
    });

    test('/api/documents/:id/confirm publishes to agentBus and triggers reconciler log', async () => {
      const state = await repo.read();
      const shipment = state.shipments[0]!;
      const docId = `doc-confirm-e2e-${crypto.randomUUID()}`;

      // Insert a document in mismatch status to be confirmed
      await repo.mutate(s => {
        s.documents.push({
          id: docId,
          filename: 'bill_of_lading_confirm_test.pdf',
          fileSizeBytes: 5400,
          pageCount: 1,
          fields: {
            shipmentId: shipment.id,
            quantity: shipment.quantity,
          },
          confidence: 0.91,
          status: 'mismatch',
          issues: ['Minor discrepancy'],
          source: 'PDF text extraction',
          uploadedAt: s.clock,
        });
      });

      const res = await app.request(`/api/documents/${docId}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);

      // Wait for agentBus in-flight asynchronous handlers to complete
      await repo.agentBus.waitForIdle();

      const logs = await repo.getAgentLogs({ feature: 'documents' });
      const matchingLog = logs.find(l => l.accessedEntities.includes(docId));
      expect(matchingLog).toBeDefined();
      expect(matchingLog!.agent).toBe('reconciler');
      expect(matchingLog!.action).toBe('reconcile_freight_document');
    });

    test('GET /api/agent-logs retrieves logs filtered by feature', async () => {
      const res = await app.request('/api/agent-logs?feature=incidents&limit=10', {
        headers: { cookie: managerCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(l => l.feature === 'incidents')).toBe(true);
    });
  });
});
