import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { State, EventInput } from '../shared/types';
import type { SimulationDataset, StoredSimulationDataset, SimulationProgress } from '../shared/simulation';
import { appendCatalogRow, catalogOrder, catalogSchemas, eventSchema, importId, timestampSchema } from './catalog';
import { DomainError } from './common';

export const SIMULATION_MAX_BYTES = 2 * 1024 * 1024;
const dayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(x => Number.isFinite(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x, 'Use a valid UTC date');
const catalogSchema = z.object({ suppliers: z.array(catalogSchemas.suppliers), warehouses: z.array(catalogSchemas.warehouses), dependencies: z.array(catalogSchemas.dependencies), lots: z.array(catalogSchemas.lots), shipments: z.array(catalogSchemas.shipments), orders: z.array(catalogSchemas.orders) });
const datasetSchema = z.object({
  schemaVersion: z.literal(1), datasetId: importId, name: importId, seed: importId, startDate: dayDate, generatorVersion: importId,
  days: z.array(z.object({ index: z.number().int().min(0), date: dayDate, label: importId, catalog: catalogSchema,
    events: z.array(eventSchema), documents: z.array(z.object({ id: importId, filename: z.string().trim().min(1).max(250), text: z.string().max(1_000_000) })) })).min(1).max(30),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const dayEnd = (date: string): string => `${date}T23:59:59.999Z`;
export function simulationEventBoundaryError(state: State, input: EventInput): string | undefined {
  if (!state.simulation) return;
  if (!state.simulation.deliveredThrough) return 'Start day 1 before capturing operational events.';
  if (Date.parse(input.time) > Date.parse(state.simulation.deliveredThrough)) return 'Effective time is after the delivered simulation day. Use Next day to advance; future claim retained as invalid evidence.';
}
export function parseSimulationDataset(content: string): StoredSimulationDataset {
  if (Buffer.byteLength(content, 'utf8') > SIMULATION_MAX_BYTES) throw new DomainError('Dataset exceeds the 2 MiB UTF-8 limit.', 413);
  const original: unknown = JSON.parse(content);
  const parsed = datasetSchema.parse(original);
  const scratch = { suppliers: [], warehouses: [], dependencies: [], lots: [], shipments: [], orders: [] } as unknown as State;
  const documentIds = new Set<string>();
  for (const [index, day] of parsed.days.entries()) {
    const expected = new Date(Date.parse(`${parsed.startDate}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
    if (day.index !== index || day.date !== expected) throw new DomainError(`Day ${index + 1} must use consecutive index/date ${expected}.`);
    const count = catalogOrder.reduce((sum, entity) => sum + day.catalog[entity].length, 0) + day.events.length + day.documents.length;
    if (count > 2000) throw new DomainError(`Day ${index + 1} exceeds 2,000 combined rows.`);
    for (const entity of catalogOrder) for (const [row, value] of day.catalog[entity].entries()) {
      try { appendCatalogRow(scratch, entity, value); }
      catch (error) { throw new DomainError(`Day ${index + 1}, ${entity} row ${row + 1}: ${error instanceof Error ? error.message : 'Invalid reference'}`); }
    }
    for (const event of day.events) {
      if (Date.parse(event.time) > Date.parse(dayEnd(day.date))) throw new DomainError(`Day ${index + 1}: event ${event.id} is effective after its delivery day.`);
      event.time = new Date(event.time).toISOString();
    }
    for (const document of day.documents) {
      if (documentIds.has(document.id)) throw new DomainError(`Repeated source document ID ${document.id}.`);
      documentIds.add(document.id);
    }
  }
  return { dataset: parsed as SimulationDataset, content, hash: createHash('sha256').update(canonical(original)).digest('hex') };
}
const nonnegative = z.number().int().nonnegative();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const stats = z.object({ affectedOrders: nonnegative, uncoveredUnits: nonnegative, executedPlans: nonnegative });
const statuses = z.enum(['accepted', 'duplicate', 'invalid', 'conflict', 'stale', 'queued']);
const counts = z.object({ suppliers: nonnegative, dependencies: nonnegative, warehouses: nonnegative, lots: nonnegative, shipments: nonnegative, orders: nonnegative });
const receiptSchema = z.object({
  requestId: importId, datasetHash: fingerprint, dayIndex: nonnegative, date: dayDate, deliveredAt: timestampSchema, actorId: importId,
  clockBefore: timestampSchema, clockAfter: timestampSchema, catalogCounts: counts,
  eventCounts: z.object({accepted: nonnegative, duplicate: nonnegative, invalid: nonnegative, conflict: nonnegative, stale: nonnegative, queued: nonnegative}),
  events: z.array(z.object({ source: importId, id: importId, status: statuses })),
  documents: z.array(z.object({ sourceId: importId, documentId: z.string().min(1) })), newIncidentIds: z.array(z.string()), before: stats, after: stats,
});
const progressSchema = z.object({ datasetId: importId, datasetHash: fingerprint, name: importId, seed: importId, startDate: dayDate,
  totalDays: z.number().int().min(1).max(30), completedDays: nonnegative, status: z.enum(['ready', 'paused', 'complete']), deliveredThrough: timestampSchema.optional(), receipts: z.array(receiptSchema).max(30) });
export function normalizeSimulationFields(raw: Record<string, unknown>): Pick<State, 'simulation' | 'simulationDataset' | 'workspaceGeneration'> {
  const generation = raw.workspaceGeneration === undefined ? 1 : raw.workspaceGeneration;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid workspace generation. Restore a valid persisted workspace.');
  if (raw.simulation === undefined && raw.simulationDataset === undefined) return { workspaceGeneration: generation };
  try {
    const stored = z.object({content: z.string(), hash: fingerprint, dataset: datasetSchema}).parse(raw.simulationDataset);
    const validated = parseSimulationDataset(stored.content);
    const progress = progressSchema.parse(raw.simulation);
    if (stored.hash !== validated.hash || canonical(stored.dataset) !== canonical(validated.dataset) || progress.datasetHash !== stored.hash || progress.datasetId !== stored.dataset.datasetId || progress.totalDays !== stored.dataset.days.length || progress.startDate !== stored.dataset.startDate || progress.name !== stored.dataset.name || progress.seed !== stored.dataset.seed) throw new Error('Dataset identity mismatch');
    if (progress.completedDays !== progress.receipts.length || progress.completedDays > progress.totalDays || (progress.status === 'complete') !== (progress.completedDays === progress.totalDays)) throw new Error('Inconsistent day progress');
    const requests = new Set<string>();
    for (const [index, receipt] of progress.receipts.entries()) {
      if (receipt.dayIndex !== index || receipt.datasetHash !== stored.hash || receipt.date !== stored.dataset.days[index]?.date || requests.has(receipt.requestId)) throw new Error('Inconsistent day receipt');
      requests.add(receipt.requestId);
    }
    const expectedBoundary = progress.completedDays ? dayEnd(stored.dataset.days[progress.completedDays - 1]!.date) : undefined;
    if (progress.deliveredThrough !== expectedBoundary) throw new Error('Inconsistent simulation clock boundary');
    return { workspaceGeneration: generation, simulationDataset: validated, simulation: progress };
  } catch (error) { throw new Error(`Invalid persisted simulation: ${error instanceof Error ? error.message : 'unknown corruption'}. Restore the saved workspace; progress was not reset.`); }
}
export function simulationSummary(state: State): SimulationProgress | null { return state.simulation ? structuredClone(state.simulation) : null; }
export function isOperationallyEmpty(state: State): boolean {
  return [...catalogOrder, 'events', 'queue', 'incidents', 'plans', 'documents', 'tasks', 'notifications'].every(key => (state[key as keyof State] as unknown[]).length === 0);
}
