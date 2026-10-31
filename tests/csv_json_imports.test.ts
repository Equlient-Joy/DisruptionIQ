import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import { buildScenarioAState } from './fixtures/demo-scenarios';
import type { ImportResult } from '../src/shared/types';

process.env.AI_FEATURES_ENABLED = 'false';

describe('CSV and JSON Data Input & Ingestion Pipelines', () => {
  let repo: Repository;
  let app: ReturnType<typeof createApp>;
  let managerCookie = '';

  beforeAll(async () => {
    repo = new Repository({ pglitePath: 'memory://' });
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildScenarioAState()));
    app = createApp(repo);

    const loginRes = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'manager@disruptioniq.demo', password: 'disruption-demo' }),
    });
    managerCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
  }, 30000);

  afterAll(async () => {
    await repo.close();
  });

  async function postImport(entity: string, format: 'csv' | 'json', content: string): Promise<{ status: number; body: ImportResult }> {
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: managerCookie,
      },
      body: JSON.stringify({ entity, format, content }),
    });
    return {
      status: res.status,
      body: await res.json(),
    };
  }

  describe('1. Warehouse CSV and JSON Imports', () => {
    test('imports warehouse records via CSV format', async () => {
      const csvContent = [
        'id,name,region,capacity,status',
        'WH-CSV-01,Central Distribution Hub,Central,12000,online',
        'WH-CSV-02,Southern Spare Facility,South,6000,online',
      ].join('\n');

      const { status, body } = await postImport('warehouses', 'csv', csvContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(2);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.warehouses.some(w => w.id === 'WH-CSV-01')).toBe(true);
      expect(state.warehouses.some(w => w.id === 'WH-CSV-02')).toBe(true);
    });

    test('imports warehouse records via JSON format', async () => {
      const jsonContent = JSON.stringify([
        {
          id: 'WH-JSON-01',
          name: 'Eastern Automated Warehouse',
          region: 'East',
          capacity: 15000,
          status: 'online',
        },
      ]);

      const { status, body } = await postImport('warehouses', 'json', jsonContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.warehouses.some(w => w.id === 'WH-JSON-01')).toBe(true);
    });
  });

  describe('2. Supplier CSV and JSON Imports', () => {
    test('imports supplier records via CSV format (with piped components)', async () => {
      const csvContent = [
        'id,name,tier,facility,components,approved,leadHours,minOrder,capacity,unitCostCents,orgId',
        'SUP-CSV-01,Silicon Foundries Ltd,1,Facility Alpha,microcontroller|dsp-chip,true,48,100,50000,1250,supplier-org-1',
      ].join('\n');

      const { status, body } = await postImport('suppliers', 'csv', csvContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      const sup = state.suppliers.find(s => s.id === 'SUP-CSV-01');
      expect(sup).toBeDefined();
      expect(sup?.components).toEqual(['microcontroller', 'dsp-chip']);
      expect(sup?.approved).toBe(true);
    });

    test('imports supplier records via JSON format', async () => {
      const jsonContent = JSON.stringify([
        {
          id: 'SUP-JSON-01',
          name: 'Precision Optics Corp',
          tier: 2,
          facility: 'Optics Plant B',
          components: ['sensor-lens'],
          approved: true,
          leadHours: 72,
          minOrder: 50,
          capacity: 20000,
          unitCostCents: 3200,
          orgId: 'supplier-org-2',
        },
      ]);

      const { status, body } = await postImport('suppliers', 'json', jsonContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.suppliers.some(s => s.id === 'SUP-JSON-01')).toBe(true);
    });
  });

  describe('3. Inventory Lots CSV and JSON Imports', () => {
    test('imports inventory lots via CSV format and links to warehouse', async () => {
      const csvContent = [
        'id,itemId,name,warehouseId,quantity,reserved,status,version',
        'LOT-CSV-01,microcontroller,Batch MCU-01,WH-CSV-01,500,50,available,1',
      ].join('\n');

      const { status, body } = await postImport('lots', 'csv', csvContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      const lot = state.lots.find(l => l.id === 'LOT-CSV-01');
      expect(lot).toBeDefined();
      expect(lot?.quantity).toBe(500);
      expect(lot?.reserved).toBe(50);
    });

    test('imports inventory lots via JSON format', async () => {
      const jsonContent = JSON.stringify([
        {
          id: 'LOT-JSON-01',
          itemId: 'sensor-lens',
          name: 'Batch LENS-01',
          warehouseId: 'WH-JSON-01',
          quantity: 250,
          reserved: 0,
          status: 'available',
          version: 1,
        },
      ]);

      const { status, body } = await postImport('lots', 'json', jsonContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.lots.some(l => l.id === 'LOT-JSON-01')).toBe(true);
    });
  });

  describe('4. Customer Orders CSV and JSON Imports', () => {
    test('imports customer orders via CSV format with valid deadline & priority', async () => {
      const csvContent = [
        'id,customer,itemId,warehouseId,quantity,fulfilled,deadline,priority,penaltyCents,status',
        'ORD-CSV-01,Aerospace Dynamics,microcontroller,WH-CSV-01,150,0,2026-11-10T12:00:00Z,critical,500000,open',
      ].join('\n');

      const { status, body } = await postImport('orders', 'csv', csvContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      const order = state.orders.find(o => o.id === 'ORD-CSV-01');
      expect(order).toBeDefined();
      expect(order?.customer).toBe('Aerospace Dynamics');
      expect(order?.priority).toBe('critical');
    });

    test('imports customer orders via JSON format', async () => {
      const jsonContent = JSON.stringify([
        {
          id: 'ORD-JSON-01',
          customer: 'Defense Systems Inc',
          itemId: 'sensor-lens',
          warehouseId: 'WH-JSON-01',
          quantity: 80,
          fulfilled: 0,
          deadline: '2026-11-12T18:00:00Z',
          priority: 'high',
          penaltyCents: 250000,
          status: 'open',
        },
      ]);

      const { status, body } = await postImport('orders', 'json', jsonContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.orders.some(o => o.id === 'ORD-JSON-01')).toBe(true);
    });
  });

  describe('5. Inbound Events CSV and JSON Imports', () => {
    test('imports operational events via CSV with JSON-encoded payload', async () => {
      const csvContent = [
        'id,source,type,entityId,time,payload',
        'EVT-CSV-01,carrier,supplier_delay,SUP-CSV-01,2026-11-01T10:00:00Z,"{""delayHours"":48}"',
      ].join('\n');

      const { status, body } = await postImport('events', 'csv', csvContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      const evt = state.events.find(e => e.id === 'EVT-CSV-01');
      expect(evt).toBeDefined();
      expect(evt?.type).toBe('supplier_delay');
      expect((evt?.payload as any)?.delayHours).toBe(48);
    });

    test('imports operational events via JSON format', async () => {
      const jsonContent = JSON.stringify([
        {
          id: 'EVT-JSON-01',
          source: 'warehouse-telemetry',
          type: 'warehouse_outage',
          entityId: 'WH-JSON-01',
          time: '2026-11-01T12:00:00Z',
          payload: { reason: 'Substation maintenance', durationHours: 24 },
        },
      ]);

      const { status, body } = await postImport('events', 'json', jsonContent);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors).toHaveLength(0);

      const state = await repo.read();
      expect(state.events.some(e => e.id === 'EVT-JSON-01')).toBe(true);
    });
  });

  describe('6. Validation & Error Handling for Malformed CSV / JSON', () => {
    test('returns row-level error for CSV with schema violations without crashing', async () => {
      const badCsv = [
        'id,name,region,capacity,status',
        'WH-GOOD,Valid Hub,Central,5000,online',
        'WH-BAD,Negative Capacity Hub,West,-999,online', // invalid negative capacity
      ].join('\n');

      const { status, body } = await postImport('warehouses', 'csv', badCsv);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
      expect(body.errors.length).toBeGreaterThan(0);
      expect(body.errors[0]?.row).toBe(2); // row 2 of data

      const state = await repo.read();
      expect(state.warehouses.some(w => w.id === 'WH-GOOD')).toBe(true);
      expect(state.warehouses.some(w => w.id === 'WH-BAD')).toBe(false);
    });

    test('rejects orders where fulfilled exceeds total quantity', async () => {
      const badOrderJson = JSON.stringify([
        {
          id: 'ORD-INVALID-FULFILL',
          customer: 'Client',
          itemId: 'microcontroller',
          warehouseId: 'WH-CSV-01',
          quantity: 10,
          fulfilled: 20, // impossible: fulfilled > ordered
          deadline: '2026-11-15T00:00:00Z',
          priority: 'normal',
          penaltyCents: 0,
          status: 'open',
        },
      ]);

      const { status, body } = await postImport('orders', 'json', badOrderJson);
      expect(status).toBe(200);
      expect(body.accepted).toBe(0);
      expect(body.errors.some(e => e.message.includes('Fulfilled units cannot exceed ordered units'))).toBe(true);
    });
  });

  describe('7. Freight Document Upload in CSV and JSON Format', () => {
    test('accepts and processes freight manifest uploaded as CSV text', async () => {
      const csvDocText = [
        'Shipment Reference: SHIP-DOC-01',
        'Quantity: 450',
        'Delivery Date: 2026-11-04',
        'Bill of Lading manifest verified.',
      ].join('\n');

      const res = await app.request('/api/documents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({
          filename: 'freight_manifest_01.csv',
          text: csvDocText,
        }),
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.filename).toBe('freight_manifest_01.csv');
      expect(data.status).toBe('processing');

      // Await background document processing worker and agent bus
      await new Promise(r => setTimeout(r, 150));
      await repo.agentBus.waitForIdle();

      const docRecord = await repo.getDocument(data.id);
      expect(docRecord).toBeDefined();
      expect(docRecord?.pageCount).toBe(1);
      expect(['matched', 'review', 'mismatch']).toContain(docRecord?.status || '');
    });

    test('accepts and processes freight manifest uploaded as JSON text', async () => {
      const jsonDocText = JSON.stringify({
        shipmentId: 'SHIP-DOC-02',
        quantity: 800,
        date: '2026-11-08',
        notes: 'Priority carrier shipment confirmation',
      }, null, 2);

      const res = await app.request('/api/documents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: managerCookie,
        },
        body: JSON.stringify({
          filename: 'freight_manifest_02.json',
          text: jsonDocText,
        }),
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.filename).toBe('freight_manifest_02.json');

      await new Promise(r => setTimeout(r, 150));
      await repo.agentBus.waitForIdle();

      const docRecord = await repo.getDocument(data.id);
      expect(docRecord).toBeDefined();
      expect(docRecord?.pageCount).toBe(1);
      expect(['matched', 'review', 'mismatch']).toContain(docRecord?.status || '');
    });
  });
});
