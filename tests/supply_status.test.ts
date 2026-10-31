import { test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { generateJudgesDemo } from '../scripts/synthetic/judges-demo';
import { createEmptyState } from '../src/domain/seed';
import { parseSimulationDataset } from '../src/domain/simulation-dataset';
import { attachSimulation, advanceSimulationDay } from '../src/domain/simulation';
import { ingestEvent } from '../src/domain/events';
import { getImpact, availableShipment } from '../src/domain/impact';
import { assessSupplyNetwork } from '../src/domain/supply-status';
import { demoActors } from '../src/server/auth';

const actor = demoActors.find(x => x.role === 'manager')!;
function delivered(days: number) {
  const stored = parseSimulationDataset(JSON.stringify(generateJudgesDemo()));
  const state = createEmptyState(); attachSimulation(state, actor, stored);
  const counts: number[] = [];
  for (let i = 0; i < days; i++) counts.push(advanceSimulationDay(state, actor, { datasetHash: stored.hash, expectedDayIndex: i, requestId: `cascade-test-${i}` }, new Date().toISOString()).receipt.newIncidentIds.length);
  return { state, counts };
}
test('tiers alone do not trigger warnings; a delay colours the source yellow and descendants green', () => {
  const { state } = delivered(1);
  const initial = assessSupplyNetwork(state, getImpact(state));
  expect(initial.cascades).toHaveLength(0);
  expect(Object.values(initial.nodes).every(x => x.situation === 'unaffected')).toBe(true);
  ingestEvent(state, { id: 'day1-delay-check', source: 'cascade-test', type: 'supplier_delay', entityId: 'SUP-FOUNDRY', time: '2026-11-01T12:00:00Z', payload: { delayHours: 96 } }, actor);
  const status = assessSupplyNetwork(state, getImpact(state));
  expect(status.nodes['supplier:SUP-FOUNDRY']!.situation).toBe('delayed');
  expect(status.nodes['supplier:SUP-EAST']!.situation).toBe('affected');
  expect(status.nodes['supplier:SUP-MINERAL']!.situation).toBe('unaffected');
  expect(status.nodes['supplier:SUP-CASCADE-RAW']!.situation).toBe('unaffected');
  expect(status.cascades.some(x => x.rootId === 'SUP-FOUNDRY')).toBe(true);
});
test('day 6 creates one commitment failure, traces both tier-4 branches, and stops warning after restoration', () => {
  const { state, counts } = delivered(6);
  expect(counts).toEqual([0, 1, 1, 1, 1, 1]);
  const status = assessSupplyNetwork(state, getImpact(state));
  expect(status.nodes['supplier:SUP-CASCADE-RAW']!.situation).toBe('broken');
  expect(status.nodes['supplier:SUP-CASCADE-ASSEMBLY-A']!.situation).toBe('affected');
  expect(status.nodes['customer:Polar Logistics Devices']!.situation).toBe('affected');
  const cascade = status.cascades.find(x => x.rootId === 'SUP-CASCADE-RAW')!;
  expect(cascade.supplierIds).toHaveLength(6); expect(cascade.orderIds).toHaveLength(2);
  expect(cascade.paths.every(x => x.length === 6)).toBe(true);
  expect(availableShipment(state, state.shipments.find(x => x.id === 'SHP-CASCADE-EAST')!)).toBe(0);
  expect(ingestEvent(state, { id: 'restored-commitment', source: 'cascade-test', type: 'supplier_commitment', entityId: 'SUP-CASCADE-RAW', time: '2026-11-06T18:00:00Z', payload: { itemId: 'LINK-600', expectedQuantity: 240, confirmedQuantity: 240, dueAt: '2026-11-07T10:00:00Z', status: 'ready' } }, actor).status).toBe('accepted');
  expect(assessSupplyNetwork(state, getImpact(state)).cascades.some(x => x.rootId === 'SUP-CASCADE-RAW')).toBe(false);
});
test('quantity shortfalls limit planned inbound without applying shortages to dispatched goods', () => {
  const { state } = delivered(1);
  state.suppliers.find(x => x.id === 'SUP-CASCADE-RAW')!.commitments![0]!.confirmedQuantity = 120;
  state.suppliers.find(x => x.id === 'SUP-CASCADE-RAW')!.commitments![0]!.status = 'broken';
  const shipment = state.shipments.find(x => x.id === 'SHP-CASCADE-EAST')!;
  expect(availableShipment(state, shipment)).toBe(45);
  shipment.status = 'in_transit'; expect(availableShipment(state, shipment)).toBe(90);
});
test('database migration backfills tiers, persists commitment quantities, and is repeatable', async () => {
  const db = new PGlite();
  try {
    const migration = await readFile(new URL('../src/server/migration.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.query("INSERT INTO workspaces (id,state) VALUES ('focal','{}')");
    await db.query('INSERT INTO suppliers (id,workspace_id,name,data) VALUES ($1,$2,$3,$4)', ['tier4-test', 'focal', 'Tier 4', { tier: 4, commitments: [{ itemId: 'component', expectedQuantity: 100, confirmedQuantity: 25, dueAt: '2026-11-07T00:00:00Z', status: 'broken', updatedAt: '2026-11-06T10:00:00Z' }] }]);
    await db.exec(migration); await db.exec(migration);
    expect((await db.query('SELECT tier FROM suppliers WHERE id=$1', ['tier4-test'])).rows).toEqual([{ tier: 4 }]);
    expect((await db.query('SELECT expected_quantity,confirmed_quantity FROM supplier_commitments')).rows).toEqual([{ expected_quantity: 100, confirmed_quantity: 25 }]);
    await expect(db.query('UPDATE supplier_commitments SET confirmed_quantity=-1')).rejects.toThrow();
  } finally { await db.close(); }
}, 30000);
