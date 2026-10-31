import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { handleCopilotChat } from '../src/server/agents/copilot';
import { runRecoveryAdvisorAgent } from '../src/server/agents/recovery';
import { runTriageAgent } from '../src/server/agents/triage';
import type { Actor, Supplier, Warehouse, Lot, Shipment, Order, Incident } from '../src/shared/types';

process.env.AI_FEATURES_ENABLED = 'false';

describe('PGlite Data Retrieval & AI Grounding for Autonomous Agents', () => {
  let repo: Repository;

  const focalManager: Actor = {
    id: 'mgr-focal-01',
    name: 'Chief Logistics Officer',
    email: 'clo@disruptioniq.demo',
    role: 'manager',
    orgId: 'focal',
  };

  const testSupplier: Supplier = {
    id: 'SUP-PG-901',
    name: 'Advanced Silicon Fab Tech',
    tier: 1,
    facility: 'Hsinchu Park Line 4',
    components: ['CHIP-X100'],
    approved: true,
    leadHours: 72,
    minOrder: 100,
    capacity: 50000,
    unitCostCents: 4500,
    orgId: 'focal',
    commitments: [
      {
        itemId: 'CHIP-X100',
        expectedQuantity: 5000,
        confirmedQuantity: 5000,
        dueAt: '2026-11-15T00:00:00Z',
        status: 'ready',
        updatedAt: '2026-10-31T00:00:00Z',
      },
    ],
  };

  const testWarehouse: Warehouse = {
    id: 'WH-PG-801',
    name: 'Dallas Primary Logistics Hub',
    region: 'North America',
    capacity: 120000,
    status: 'online',
  };

  const testLot: Lot = {
    id: 'LOT-PG-701',
    itemId: 'CHIP-X100',
    name: 'Primary Silicon Buffer Lot',
    warehouseId: 'WH-PG-801',
    quantity: 14500,
    reserved: 2500,
    status: 'available',
    version: 1,
  };

  const testShipment: Shipment = {
    id: 'SHP-PG-601',
    supplierId: 'SUP-PG-901',
    warehouseId: 'WH-PG-801',
    itemId: 'CHIP-X100',
    quantity: 8000,
    eta: '2026-11-05T12:00:00Z',
    baselineEta: '2026-11-05T12:00:00Z',
    etaHistory: [{ at: '2026-10-31T00:00:00Z', eta: '2026-11-05T12:00:00Z', source: 'manual' }],
    status: 'in_transit',
  };

  const testOrder: Order = {
    id: 'ORD-PG-501',
    customer: 'Apex Aerospace Solutions',
    itemId: 'CHIP-X100',
    quantity: 6000,
    fulfilled: 0,
    deadline: '2026-11-06T18:00:00Z',
    priority: 'critical',
    warehouseId: 'WH-PG-801',
    status: 'open',
    penaltyCents: 150000,
  };

  const testIncident: Incident = {
    id: 'INC-PG-401',
    type: 'shipment_delay',
    entityId: 'SHP-PG-601',
    title: 'Customs Hold on Transpacific Airfreight',
    description: 'Shipment SHP-PG-601 delayed at port of entry',
    status: 'active',
    createdAt: '2026-10-31T06:00:00Z',
    memberOrgIds: ['focal'],
    affectedOrderIds: ['ORD-PG-501'],
    alertCount: 1,
  };

  beforeAll(async () => {
    repo = new Repository({ pglitePath: 'memory://' });
    await repo.init();

    // Populate real records into PGlite
    await repo.mutate(s => {
      s.suppliers.push(testSupplier);
      s.warehouses.push(testWarehouse);
      s.lots.push(testLot);
      s.shipments.push(testShipment);
      s.orders.push(testOrder);
      s.incidents.push(testIncident);
      s.clock = '2026-10-31T08:00:00Z';
    });
  });

  afterAll(async () => {
    await repo.close();
  });

  test('Copilot retrieves real supplier data from PGlite instead of hardcoded data', async () => {
    const res = await handleCopilotChat(
      focalManager,
      { message: 'What suppliers do we have in our database?' },
      repo
    );

    expect(res.role).toBe('assistant');
    // Must retrieve the actual supplier from PGlite
    expect(res.content).toContain('Advanced Silicon Fab Tech');
    expect(res.content).toContain('SUP-PG-901');
    expect(res.content).not.toContain('You can ask me to simulate an existing shipment');
  });

  test('Copilot retrieves real warehouse and inventory lot records from PGlite', async () => {
    const resWarehouse = await handleCopilotChat(
      focalManager,
      { message: 'Show me our warehouses and their capacity' },
      repo
    );
    expect(resWarehouse.content).toContain('Dallas Primary Logistics Hub');
    expect(resWarehouse.content).toContain('WH-PG-801');
    expect(resWarehouse.content).toContain('120,000');

    const resLots = await handleCopilotChat(
      focalManager,
      { message: 'What inventory lots and available stock do we have?' },
      repo
    );
    expect(resLots.content).toContain('LOT-PG-701');
    expect(resLots.content).toContain('CHIP-X100');
    expect(resLots.content).toContain('14500');
    expect(resLots.content).toContain('WH-PG-801');
  });

  test('Copilot retrieves real shipments and customer orders from PGlite', async () => {
    const resShipments = await handleCopilotChat(
      focalManager,
      { message: 'Which shipments are currently in transit?' },
      repo
    );
    expect(resShipments.content).toContain('SHP-PG-601');
    expect(resShipments.content).toContain('8000 units');
    expect(resShipments.content).toContain('SUP-PG-901');

    const resOrders = await handleCopilotChat(
      focalManager,
      { message: 'What open customer orders do we have?' },
      repo
    );
    expect(resOrders.content).toContain('ORD-PG-501');
    expect(resOrders.content).toContain('Apex Aerospace Solutions');
    expect(resOrders.content).toContain('6000 units');
  });

  test('Copilot searches PGlite across all tables when given a search term', async () => {
    const resSearch = await handleCopilotChat(
      focalManager,
      { message: 'Search for CHIP-X100 in the database' },
      repo
    );
    expect(resSearch.content).toContain('PGlite Database Search Matches');
    expect(resSearch.content).toContain('LOT-PG-701');
  });

  test('Copilot uses AI and passes retrieved PGlite data when AI is enabled', async () => {
    const prevEnabled = process.env.AI_FEATURES_ENABLED;
    const prevKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;

    process.env.AI_FEATURES_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    let capturedPrompt = '';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        capturedPrompt = String(init.body);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'According to PGlite, supplier [SUP-PG-901](app://suppliers/SUP-PG-901) is Advanced Silicon Fab Tech with capacity for 50,000 units.',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const res = await handleCopilotChat(
        focalManager,
        { message: 'Tell me about supplier SUP-PG-901' },
        repo
      );

      // Verify that AI was called and the response comes from AI grounded on PGlite
      expect(res.content).toContain('Advanced Silicon Fab Tech');
      expect(res.content).toContain('[SUP-PG-901](app://suppliers/SUP-PG-901)');
      // Verify that PGlite records were actually passed inside the user prompt to the AI
      expect(capturedPrompt).toContain('Advanced Silicon Fab Tech');
      expect(capturedPrompt).toContain('SUP-PG-901');
    } finally {
      globalThis.fetch = originalFetch;
      process.env.AI_FEATURES_ENABLED = prevEnabled;
      process.env.GEMINI_API_KEY = prevKey;
    }
  });

  test('Recovery Advisor Agent searches and critiques candidate plans using PGlite lots', async () => {
    const state = await repo.read();
    const log = await runRecoveryAdvisorAgent({
      incidentId: testIncident.id,
      plans: [],
      state,
      repo,
    });

    expect(log.agent).toBe('advisor');
    expect(log.feature).toBe('plans');
    expect(log.summary).toContain('Recovery critique for incident INC-PG-401');
    expect(log.accessedEntities).toContain(testIncident.id);
  });

  test('Triage Agent queries customer_orders from PGlite and correlates affected orders', async () => {
    const state = await repo.read();
    const log = await runTriageAgent({
      event: {
        id: 'evt-test-881',
        type: 'carrier_delay',
        entityId: 'SHP-PG-601',
        time: '2026-10-31T07:00:00Z',
        source: 'manual',
        payload: { delayHours: 48 },
      },
      incident: testIncident,
      state,
      repo,
    });

    expect(log.agent).toBe('triage');
    expect(log.summary).toContain('Triage analysis');
    expect(log.accessedEntities).toContain('SHP-PG-601');
  });
});
