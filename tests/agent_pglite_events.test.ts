import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { runTriageAgent } from '../src/server/agents/triage';
import { runRecoveryAdvisorAgent } from '../src/server/agents/recovery';
import { runDocumentReconcilerAgent } from '../src/server/agents/document';
import type { Incident, RawEvent, RecoveryPlan } from '../src/shared/types';

describe('PGlite Table Access, Full Search & Event-Driven Agent Triggers', () => {
  let repo: Repository;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Mock Gemini API responses for fast, deterministic unit test verification
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        let text = 'Agent reasoning completed successfully.';
        if (init?.body) {
          const body = JSON.parse(String(init.body));
          const prompt = JSON.stringify(body);
          if (prompt.includes('Triage') || prompt.includes('warehouse_outage')) {
            text = 'Triage analysis: TEMP-WH-99 outage directly impacts TEMP-ORD-99 with deadline pressure.';
          } else if (prompt.includes('Recovery') || prompt.includes('TEMP-PLAN-EXPEDITE')) {
            text = 'Recovery Advisor critique: Recommend advancing TEMP-PLAN-EXPEDITE arriving 2026-11-04 with feasible lead time.';
          } else if (prompt.includes('Reconciler') || prompt.includes('BillOfLading') || prompt.includes('TEMP-SHIP-99')) {
            text = 'Document Reconciler verified: TEMP-DOC-BOL-1 matches shipment TEMP-SHIP-99 with 100% agreement on 300 units.';
          }
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    repo = new Repository({ pglitePath: 'memory://' });
    await repo.init();

    // Register event-driven autonomous agents on the event bus
    repo.agentBus.clear();
    repo.agentBus.subscribe('disruption:ingested', data => runTriageAgent({ ...data, repo }));
    repo.agentBus.subscribe('plans:generated', data => runRecoveryAdvisorAgent({ ...data, repo }));
    repo.agentBus.subscribe('document:extracted', data => runDocumentReconcilerAgent({ ...data, repo }));
  }, 30000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await repo.close();
  });

  describe('Part 1: PGlite Table Access and Full Search for All Tables', () => {
    test('all 16 tables exist in PGlite and can be queried and searched by agents', async () => {
      const allTables = await repo.getAllTableNames();
      expect(allTables).toHaveLength(16);

      // Verify direct select access to each table
      for (const table of allTables) {
        const rows = await repo.searchTable(table);
        expect(Array.isArray(rows)).toBe(true);
      }
    });

    test('agents can place temp data across relational PGlite tables and search across all of them', async () => {
      // Place temporary records via state mutation and document records
      await repo.mutate(s => {
        s.suppliers.push({
          id: 'TEMP-SUP-99',
          name: 'Temp Precision Sensors',
          orgId: 'supplier-org',
          tier: 1,
          facility: 'Temp Facility 99',
          components: ['temp-sensor'],
          approved: true,
          leadHours: 72,
          minOrder: 10,
          capacity: 1000,
          unitCostCents: 500,
        });
        s.warehouses.push({
          id: 'TEMP-WH-99',
          name: 'Temp Western Logistics Hub',
          region: 'West',
          capacity: 5000,
          status: 'online',
        });
        s.lots.push({
          id: 'TEMP-LOT-99',
          itemId: 'temp-sensor',
          name: 'Temp Sensor Lot A',
          warehouseId: 'TEMP-WH-99',
          quantity: 250,
          reserved: 50,
          status: 'available',
          version: 1,
        });
        s.orders.push({
          id: 'TEMP-ORD-99',
          customer: 'Temp Aerospace Client',
          itemId: 'temp-sensor',
          quantity: 100,
          fulfilled: 0,
          deadline: '2026-11-05T00:00:00Z',
          warehouseId: 'TEMP-WH-99',
          priority: 'critical',
          status: 'open',
          penaltyCents: 500000,
        });
        s.shipments.push({
          id: 'TEMP-SHIP-99',
          supplierId: 'TEMP-SUP-99',
          warehouseId: 'TEMP-WH-99',
          itemId: 'temp-sensor',
          quantity: 300,
          eta: '2026-11-03T12:00:00Z',
          baselineEta: '2026-11-03T12:00:00Z',
          etaHistory: [],
          status: 'in_transit',
        });
      });

      // Verify searchTable on individual relational projection tables
      const foundSuppliers = await repo.searchTable('suppliers', 'Temp Precision Sensors');
      expect(foundSuppliers.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(foundSuppliers)).toContain('TEMP-SUP-99');

      const foundLots = await repo.searchTable('inventory_lots', 'temp-sensor');
      expect(foundLots.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(foundLots)).toContain('TEMP-LOT-99');

      const foundOrders = await repo.searchTable('customer_orders', 'Aerospace');
      expect(foundOrders.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(foundOrders)).toContain('TEMP-ORD-99');

      // Verify searchAllTables searches across all 16 PGlite tables in a single sweep
      const globalMatches = await repo.searchAllTables('TEMP-');
      expect(Object.keys(globalMatches).length).toBeGreaterThan(0);
      expect(globalMatches['suppliers']).toBeDefined();
      expect(globalMatches['warehouses']).toBeDefined();
      expect(globalMatches['inventory_lots']).toBeDefined();
      expect(globalMatches['customer_orders']).toBeDefined();
      expect(globalMatches['shipments']).toBeDefined();
    });

    test('agents can perform targeted searches on each specific table in PGlite', async () => {
      // Create session and inbox temp records to ensure populated tables
      await repo.createSession('TEMP-TOKEN-1', 'analyst-1');
      await repo.recordInbox({
        integrationId: 'carrier-api',
        sourceEventId: 'TEMP-INBOX-SRC-1',
        payload: { test: 'payload' },
        eventTime: new Date(),
      });

      const tablesToVerify = [
        { table: 'workspaces', query: 'focal' },
        { table: 'app_users', query: 'analyst' },
        { table: 'app_sessions', query: 'analyst-1' },
        { table: 'suppliers', query: 'TEMP-SUP-99' },
        { table: 'warehouses', query: 'TEMP-WH-99' },
        { table: 'shipments', query: 'TEMP-SHIP-99' },
        { table: 'inventory_lots', query: 'TEMP-LOT-99' },
        { table: 'customer_orders', query: 'TEMP-ORD-99' },
        { table: 'order_lines', query: 'TEMP-ORD-99-line' },
        { table: 'integration_connections', query: 'carrier' },
        { table: 'integration_inbox', query: 'TEMP-INBOX-SRC-1' },
      ];

      for (const { table, query } of tablesToVerify) {
        const results = await repo.searchTable(table, query);
        expect(results.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Part 2: Event-Driven Autonomous Agent Triggers with PGlite Data', () => {
    test('triggering disruption:ingested activates Triage Agent and writes log into PGlite agent_execution_logs', async () => {
      const state = await repo.read();

      const tempDisruptionEvent: RawEvent = {
        id: 'TEMP-EVT-DISRUPT-1',
        time: state.clock,
        source: 'carrier',
        type: 'warehouse_outage',
        entityId: 'TEMP-WH-99',
        payload: {
          reason: 'Severe regional power interruption',
          expectedDurationHours: 48,
        },
        status: 'accepted',
        receivedAt: state.clock,
        message: 'Warehouse outage recorded',
      };

      const tempIncident: Incident = {
        id: 'TEMP-INC-1',
        type: 'warehouse_outage',
        title: 'Temp Power Outage at Western Hub',
        description: 'Facility offline due to regional power disruption',
        status: 'active',
        entityId: 'TEMP-WH-99',
        createdAt: state.clock,
        memberOrgIds: ['focal'],
        affectedOrderIds: ['TEMP-ORD-99'],
        alertCount: 1,
      };

      // Publish event to the bus
      repo.agentBus.publish('disruption:ingested', {
        event: tempDisruptionEvent,
        incident: tempIncident,
        state,
      });

      // Await non-blocking agent completion
      await repo.agentBus.waitForIdle();

      // Verify agent execution log was saved in PGlite
      const logs = await repo.getAgentLogs({ feature: 'incidents', limit: 10 });
      const triageLog = logs.find(l => l.accessedEntities.includes('TEMP-WH-99') || l.accessedEntities.includes('TEMP-INC-1'));

      expect(triageLog).toBeDefined();
      expect(triageLog?.agent).toBe('triage');
      expect(triageLog?.feature).toBe('incidents');
      expect(triageLog?.action).toBe('correlate_root_cause');
      expect(triageLog?.summary).toContain('TEMP-WH-99');
      expect(triageLog?.latencyMs).toBeGreaterThan(0);

      // Verify the log is directly readable via PGlite SQL table search
      const sqlLogs = await repo.searchTable('agent_execution_logs', 'TEMP-WH-99');
      expect(sqlLogs.length).toBeGreaterThanOrEqual(1);
      expect(sqlLogs[0].agent).toBe('triage');
    });

    test('triggering plans:generated activates Recovery Advisor Agent and writes critique to PGlite', async () => {
      const state = await repo.read();

      const tempPlans: RecoveryPlan[] = [
        {
          id: 'TEMP-PLAN-EXPEDITE',
          incidentId: 'TEMP-INC-1',
          type: 'expedite',
          orderId: 'TEMP-ORD-99',
          sourceId: 'TEMP-SUP-99',
          quantity: 100,
          costCents: 150000, // $1,500
          arrivesAt: '2026-11-04T00:00:00Z',
          feasible: true,
          reasons: ['Fast air freight route open'],
          riskLevel: 'routine',
          status: 'proposed',
          createdBy: 'manager-1',
          rationale: 'Expedite from verified supplier',
          inventoryVersion: 1,
          approvals: [],
          evidenceIds: ['TEMP-EVT-DISRUPT-1'],
          version: 1,
        },
        {
          id: 'TEMP-PLAN-REALLOCATE',
          incidentId: 'TEMP-INC-1',
          type: 'reallocate',
          orderId: 'TEMP-ORD-99',
          sourceId: 'TEMP-LOT-99',
          quantity: 100,
          costCents: 50000,
          arrivesAt: '2026-11-06T00:00:00Z',
          feasible: false,
          reasons: ['Warehouse TEMP-WH-99 is offline for 48 hours'],
          riskLevel: 'high',
          status: 'proposed',
          createdBy: 'manager-1',
          rationale: 'Reallocate from warehouse stock',
          inventoryVersion: 1,
          approvals: [],
          evidenceIds: ['TEMP-EVT-DISRUPT-1'],
          version: 1,
        },
      ];

      // Publish plans:generated event to the bus
      repo.agentBus.publish('plans:generated', {
        incidentId: 'TEMP-INC-1',
        plans: tempPlans,
        state,
      });

      // Await non-blocking agent completion
      await repo.agentBus.waitForIdle();

      // Verify recovery advisor execution log was saved in PGlite
      const logs = await repo.getAgentLogs({ feature: 'plans', limit: 10 });
      const advisorLog = logs.find(l => l.accessedEntities.includes('TEMP-INC-1') || l.accessedEntities.includes('TEMP-PLAN-EXPEDITE'));

      expect(advisorLog).toBeDefined();
      expect(advisorLog?.agent).toBe('advisor');
      expect(advisorLog?.feature).toBe('plans');
      expect(advisorLog?.action).toBe('critique_recovery_options');
      expect(advisorLog?.summary).toContain('TEMP-PLAN-EXPEDITE');
      expect(advisorLog?.latencyMs).toBeGreaterThan(0);

      // Verify direct SQL search in PGlite for the advisor log
      const sqlLogs = await repo.searchTable('agent_execution_logs', 'TEMP-PLAN-EXPEDITE');
      expect(sqlLogs.length).toBeGreaterThanOrEqual(1);
      expect(sqlLogs[0].agent).toBe('advisor');
    });

    test('triggering document:extracted activates Document Reconciler Agent and reconciles PGlite data', async () => {
      // Create document record and chunks in PGlite
      await repo.insertDocumentRecord({
        id: 'TEMP-DOC-BOL-1',
        filename: 'BillOfLading_TEMP_SHIP_99.pdf',
        fileSizeBytes: 24500,
        mimeType: 'application/pdf',
        source: 'carrier_upload',
        status: 'ready',
      });

      // Add document claim in state
      await repo.mutate(s => {
        s.documents.push({
          id: 'TEMP-DOC-BOL-1',
          filename: 'BillOfLading_TEMP_SHIP_99.pdf',
          source: 'carrier_upload',
          fileSizeBytes: 24500,
          status: 'ready',
          confidence: 0.95,
          fields: {
            shipmentId: 'TEMP-SHIP-99',
            quantity: 300,
            date: '2026-11-03',
          },
          issues: [],
          excerpt: 'Manifest Bill of Lading: 300 units of temp-sensor for TEMP-SHIP-99 verified clean.',
        });
      });

      const state = await repo.read();

      const tempChunks = [
        {
          id: 'TEMP-DOC-BOL-1-chunk-0',
          documentId: 'TEMP-DOC-BOL-1',
          chunkIndex: 0,
          pageNumber: 1,
          charStart: 0,
          charEnd: 120,
          content: 'Carrier Freight Manifest. Shipment ID: TEMP-SHIP-99. Declared Count: 300 units of temp-sensor.',
        },
      ];

      // Publish document:extracted event to the bus
      repo.agentBus.publish('document:extracted', {
        documentId: 'TEMP-DOC-BOL-1',
        chunks: tempChunks,
        state,
      });

      // Await non-blocking agent completion
      await repo.agentBus.waitForIdle();

      // Verify document reconciler log was saved in PGlite
      const logs = await repo.getAgentLogs({ feature: 'documents', limit: 10 });
      const reconcilerLog = logs.find(l => l.accessedEntities.includes('TEMP-DOC-BOL-1'));

      expect(reconcilerLog).toBeDefined();
      expect(reconcilerLog?.agent).toBe('reconciler');
      expect(reconcilerLog?.feature).toBe('documents');
      expect(reconcilerLog?.action).toBe('reconcile_freight_document');
      expect(reconcilerLog?.summary).toContain('TEMP-SHIP-99');
      expect(reconcilerLog?.summary).toContain('100% agreement');

      // Verify direct SQL search in PGlite for the reconciler log
      const sqlLogs = await repo.searchTable('agent_execution_logs', 'TEMP-DOC-BOL-1');
      expect(sqlLogs.length).toBeGreaterThanOrEqual(1);
      expect(sqlLogs[0].agent).toBe('reconciler');
    });

    test('agents gracefully use deterministic logic and log fallback in PGlite when LLM is unavailable', async () => {
      // Temporarily simulate LLM failure / offline
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('Provider unreachable', { status: 503 })) as unknown as typeof fetch;

      try {
        const state = await repo.read();
        const offlineEvent: RawEvent = {
          id: 'TEMP-EVT-OFFLINE-1',
          time: state.clock,
          source: 'carrier',
          type: 'supplier_delay',
          entityId: 'TEMP-SUP-99',
          payload: { delayHours: 72 },
          status: 'accepted',
          receivedAt: state.clock,
          message: 'Offline delay reported',
        };

        repo.agentBus.publish('disruption:ingested', {
          event: offlineEvent,
          state,
        });

        await repo.agentBus.waitForIdle();

        const logs = await repo.getAgentLogs({ feature: 'incidents', limit: 5 });
        const fallbackLog = logs.find(l => l.accessedEntities.includes('TEMP-SUP-99'));

        expect(fallbackLog).toBeDefined();
        expect(fallbackLog?.status).toBe('fallback');
        expect(fallbackLog?.model).toBe('deterministic-triage');
        expect(fallbackLog?.summary).toContain('TEMP-SUP-99');

        // Verify fallback log is in PGlite table
        const dbLogs = await repo.searchTable('agent_execution_logs', 'TEMP-SUP-99');
        expect(dbLogs.length).toBeGreaterThanOrEqual(1);
      } finally {
        globalThis.fetch = prevFetch;
      }
    });
  });
});
