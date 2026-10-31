import { describe, expect, test } from 'bun:test';
import { appendCatalogRow, eventSchema } from '../src/domain/catalog';
import { createEmptyState } from '../src/domain/seed';
import { createSeedState } from './fixtures/enterprise';
import { importRows } from '../src/server/imports';
import { parseSimulationDataset, normalizeSimulationFields, SIMULATION_MAX_BYTES } from '../src/domain/simulation-dataset';
import { normalizeState } from '../src/domain/normalize';
import { feedFixture } from './fixtures/feed';

describe('shared catalog validation', () => {
  test('dependency imports require known suppliers and cannot introduce cycles', () => {
    const state = createSeedState();
    state.dependencies = [];
    const [parent, child] = state.suppliers;
    const edge = { id: 'edge', parentId: parent!.id, childId: child!.id, itemId: 'controller', confidence: 0.8, source: 'Declared', verified: true };
    appendCatalogRow(state, 'dependencies', edge);
    expect(state.dependencies).toEqual([edge]);
    for (const invalid of [
      { ...edge, id: 'unknown', parentId: 'absent' },
      { ...edge, id: 'self', childId: parent!.id },
      { ...edge, id: 'bad-score', confidence: 1.1 },
      { ...edge, id: 'cycle', parentId: child!.id, childId: parent!.id },
    ]) expect(() => appendCatalogRow(state, 'dependencies', invalid)).toThrow();
    expect(state.dependencies).toEqual([edge]);
  });
  test('catalog append refuses existing IDs and preserves partial imports', () => {
    const state = createEmptyState();
    const actor = { id: 'admin', name: 'Admin', email: 'admin@test.local', orgId: 'focal', role: 'admin' as const };
    const row = { id: 'hub', name: 'Hub', region: 'West', capacity: 100, status: 'online' };
    appendCatalogRow(state, 'warehouses', row);
    expect(() => appendCatalogRow(state, 'warehouses', row)).toThrow('Existing IDs');
    const content = JSON.stringify([{ ...row, id: 'new' }, { ...row, id: 'bad', capacity: -1 }]);
    const result = importRows(state, actor, 'warehouses', 'json', content);
    expect(result.accepted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(state.decisions.at(-1)?.after).toMatchObject({ content });
  });
  test('event envelope retains integration and correlation identifiers', () => {
    const input = { id: 'eta', source: 'carrier', type: 'shipment_eta' as const, entityId: 'shipment', time: '2026-11-01T09:00:00Z', payload: { eta: '2026-11-03T10:00:00Z' }, integrationId: 'carrier-api', correlationId: 'day-1' };
    expect(eventSchema.parse(input)).toEqual(input);
  });
});

describe('simulation source contracts', () => {
  test('fingerprint is canonical and preserves array order', () => {
    const data = feedFixture();
    const first = parseSimulationDataset(JSON.stringify(data));
    expect(parseSimulationDataset(JSON.stringify(Object.fromEntries(Object.entries(data).reverse()))).hash).toBe(first.hash);
    data.days[0]!.catalog.lots[0]!.quantity++;
    expect(parseSimulationDataset(JSON.stringify(data)).hash).not.toBe(first.hash);
    data.days[0]!.catalog.suppliers.reverse();
    expect(parseSimulationDataset(JSON.stringify(data)).hash).not.toBe(first.hash);
  });
  test('validates dates, references, versions and day boundaries', () => {
    for (const count of [1, 7, 30]) expect(parseSimulationDataset(JSON.stringify(feedFixture(count))).dataset.days).toHaveLength(count);
    const bad: unknown[] = [{ ...feedFixture(), schemaVersion: 2 }, feedFixture(0), feedFixture(31)];
    const gap = feedFixture(); gap.days[1]!.date = '2026-11-04'; bad.push(gap);
    const invalidDate = feedFixture(); invalidDate.startDate = '2026-02-30'; bad.push(invalidDate);
    const broken = feedFixture(); broken.days[0]!.catalog.lots[0]!.warehouseId = 'absent'; bad.push(broken);
    const future = feedFixture(); future.days[0]!.events.push({ id: 'future', source: 'test', type: 'stock_count', entityId: 'absent', time: '2026-11-02T00:00:00Z', payload: { quantity: -1 } }); bad.push(future);
    for (const input of bad) expect(() => parseSimulationDataset(JSON.stringify(input))).toThrow();
    future.days[0]!.events[0]!.time = '2026-10-30T00:00:00Z';
    expect(parseSimulationDataset(JSON.stringify(future)).dataset.days[0]!.events).toHaveLength(1);
  });
  test('enforces UTF-8 size and combined row limits', () => {
    const content = JSON.stringify(feedFixture());
    const exact = content.padEnd(content.length + SIMULATION_MAX_BYTES - Buffer.byteLength(content), ' ');
    expect(Buffer.byteLength(parseSimulationDataset(exact).content)).toBe(SIMULATION_MAX_BYTES);
    expect(() => parseSimulationDataset(content.padEnd(SIMULATION_MAX_BYTES + 1, ' '))).toThrow('2 MiB');
    expect(() => parseSimulationDataset('é'.repeat(SIMULATION_MAX_BYTES / 2 + 1))).toThrow('2 MiB');
    const many = feedFixture();
    many.days[1]!.events = Array.from({length: 2001}, (_, index) => ({ id: `row-${index}`, source: 'test', type: 'stock_count', entityId: 'absent', time: '2026-11-02T00:00:00Z', payload: {} }));
    expect(() => parseSimulationDataset(JSON.stringify(many))).toThrow('2,000');
  });
  test('legacy normalization remains empty and corrupt persisted progress fails closed', () => {
    const empty = normalizeState(createEmptyState());
    expect(empty.simulation).toBeUndefined(); expect(empty.simulationDataset).toBeUndefined();
    expect(empty.workspaceGeneration).toBe(1);
    expect(() => normalizeSimulationFields({ simulation: { completedDays: 3 } })).toThrow();
    expect(() => normalizeState({ ...empty, workspaceGeneration: -1 })).toThrow('generation');
  });
});
