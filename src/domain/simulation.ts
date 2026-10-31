import type { Actor, State } from '../shared/types';
import type { AdvanceDayCommand, AdvanceDayResult, DayReceipt, ImpactSnapshot, SimulationProgress, StoredSimulationDataset } from '../shared/simulation';
import { appendCatalogRow, catalogOrder } from './catalog';
import { audit, DomainError, requireFocal } from './common';
import { ingestEvent } from './events';
import { inspectDocument } from './engine';
import { getImpact } from './impact';
import { dayEnd, isOperationallyEmpty } from './simulation-dataset';
export { simulationEventBoundaryError } from './simulation-dataset';

function current(state: State, hash: string): SimulationProgress {
  if (!state.simulation || !state.simulationDataset) throw new DomainError('Load a simulation dataset first.', 409);
  if (state.simulation.datasetHash !== hash) throw new DomainError('The simulation dataset changed. Refresh before continuing.', 409);
  return state.simulation;
}
function snapshot(state: State): ImpactSnapshot {
  const impacts = getImpact(state);
  return { affectedOrders: impacts.length, uncoveredUnits: impacts.reduce((sum, x) => sum + x.shortage, 0), executedPlans: state.plans.filter(x => x.status === 'executed').length };
}
export function requireSimulationStarted(state: State): void {
  if (state.simulation && !state.simulation.completedDays) throw new DomainError('Start day 1 before capturing events, importing catalogs or uploading documents.', 409);
}
export function attachSimulation(state: State, actor: Actor, stored: StoredSimulationDataset): SimulationProgress {
  requireFocal(actor, ['manager', 'admin']);
  if (state.simulation) {
    if (state.simulation.datasetHash === stored.hash) return structuredClone(state.simulation);
    throw new DomainError('A simulation dataset is already attached. Use an explicit administrator demo reset to replace it.', 409);
  }
  if (!isOperationallyEmpty(state)) throw new DomainError('Simulation requires an empty operational workspace. Existing data was retained.', 409);
  const data = stored.dataset;
  state.simulationDataset = structuredClone(stored);
  state.simulation = { datasetId: data.datasetId, datasetHash: stored.hash, name: data.name, seed: data.seed, startDate: data.startDate, totalDays: data.days.length, completedDays: 0, status: 'ready', receipts: [] };
  audit(state, actor, 'simulation_attached', data.datasetId, 'Synthetic source attached; no operational records delivered.', [], undefined, state.simulation);
  return structuredClone(state.simulation);
}
export function controlSimulation(state: State, actor: Actor, input: { datasetHash: string; action: 'pause' | 'resume' }): SimulationProgress {
  requireFocal(actor, ['manager', 'admin']);
  const progress = current(state, input.datasetHash);
  if (progress.status === 'complete') throw new DomainError('Simulation is complete.', 409);
  const status = input.action === 'pause' ? 'paused' : 'ready';
  if (progress.status !== status) {
    progress.status = status;
    audit(state, actor, `simulation_${input.action}`, progress.datasetId, input.action === 'pause' ? 'Further day delivery paused. Operational review remains available.' : 'Day controls resumed. Delivery still requires an explicit click.');
  }
  return structuredClone(progress);
}
export function advanceSimulationDay(state: State, actor: Actor, command: AdvanceDayCommand, deliveredAt: string): AdvanceDayResult {
  requireFocal(actor, ['manager', 'admin']);
  const progress = current(state, command.datasetHash);
  const previous = progress.receipts.find(x => x.requestId === command.requestId);
  if (previous) {
    if (previous.dayIndex !== command.expectedDayIndex) throw new DomainError('Request ID was reused for a different day.', 409);
    return { receipt: structuredClone(previous), newlyCommitted: false };
  }
  if (progress.status === 'paused') throw new DomainError('Simulation is paused. Resume to enable the next day.', 409);
  if (progress.status === 'complete') throw new DomainError('Simulation is complete.', 409);
  if (command.expectedDayIndex !== progress.completedDays) throw new DomainError('Another request delivered this day. Refresh progress before continuing.', 409);
  const day = state.simulationDataset!.dataset.days[progress.completedDays]!;
  const clockBefore = state.clock;
  const before = snapshot(state);
  const incidentIds = new Set(state.incidents.map(x => x.id));
  if (!progress.completedDays) {
    if (!isOperationallyEmpty(state)) throw new DomainError('Day 1 requires a still-empty operational workspace.', 409);
    state.clock = `${day.date}T00:00:00.000Z`;
  } else if (Date.parse(state.clock) > Date.parse(dayEnd(day.date))) throw new DomainError('Workspace clock is beyond this day; data was not delivered.', 409);
  // Temporary boundary exists only in this transaction until its receipt commits.
  progress.deliveredThrough = dayEnd(day.date);
  const catalogCounts = { suppliers: 0, dependencies: 0, warehouses: 0, lots: 0, shipments: 0, orders: 0 };
  for (const entity of catalogOrder) for (const row of day.catalog[entity]) { appendCatalogRow(state, entity, row); catalogCounts[entity]++; }
  const eventCounts = { accepted: 0, duplicate: 0, invalid: 0, conflict: 0, stale: 0, queued: 0 };
  const events: DayReceipt['events'] = [];
  for (const input of [...day.events].sort((a,b) => Date.parse(a.time) - Date.parse(b.time))) {
    const event = ingestEvent(state, input, actor);
    eventCounts[event.status]++;
    events.push({ source: event.source, id: event.id, status: event.status });
  }
  const documents = day.documents.map(input => ({ sourceId: input.id, documentId: inspectDocument(state, input.filename, input.text, actor).id }));
  state.clock = dayEnd(day.date);
  const receipt: DayReceipt = { requestId: command.requestId, datasetHash: command.datasetHash, dayIndex: day.index, date: day.date, deliveredAt, actorId: actor.id, clockBefore, clockAfter: state.clock, catalogCounts, eventCounts, events, documents, newIncidentIds: state.incidents.filter(x => !incidentIds.has(x.id)).map(x => x.id), before, after: snapshot(state) };
  progress.receipts.push(receipt);
  progress.completedDays++;
  if (progress.completedDays === progress.totalDays) progress.status = 'complete';
  audit(state, actor, 'simulation_day_delivered', progress.datasetId, `Delivered day ${day.index + 1} (${day.date}) from explicit synthetic source.`, [...events.map(x => x.id), ...documents.map(x => x.documentId)], undefined, receipt);
  return { receipt: structuredClone(receipt), newlyCommitted: true };
}
