import type { Actor, DocumentClaim, State } from '../shared/types';
import { atHours, audit, DomainError, find, integer, nextId, requireFocal, sourceEvidence, validTime } from './common';
import { ingestEvent } from './events';

export { DomainError } from './common';
export { getImpact } from './impact';
export { generatePlans, decidePlan } from './plans';
export { ingestEvent, replayQueue } from './events';

export function inspectDocument(state: State, filename: string, text: string, actor: Actor): DocumentClaim {
  requireFocal(actor, ['analyst', 'manager', 'warehouse', 'procurement', 'admin']);
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 250 || typeof text !== 'string' || text.length > 1_000_000) throw new DomainError('Provide a filename and at most one million characters of extracted text');
  const fields: DocumentClaim['fields'] = {}; const issues: string[] = [];
  const reference = text.match(/(?:shipment(?:\s*(?:id|reference))?|consignment)\s*[:#=]\s*([a-zA-Z0-9_-]+)/i);
  const quantity = text.match(/(?:quantity|qty)\s*[:#=]\s*(-?[\d,.]+)/i);
  const date = text.match(/(?:date|issued)\s*[:#=]\s*(\d{4}-\d{2}-\d{2})/i);
  if (reference) fields.shipmentId = reference[1]!;
  if (quantity) { const value = Number(quantity[1]!.replaceAll(',', '')); if (integer(value)) fields.quantity = value; else issues.push('Extracted quantity is not a nonnegative integer'); }
  if (date) { if (validTime(date[1])) fields.date = date[1]; else issues.push('Document date is invalid'); }
  if (!text.trim()) issues.push('No extractable text; scanned or empty document requires manual review');
  if (!fields.shipmentId) issues.push('Shipment reference missing or extraction uncertain');
  if (fields.quantity === undefined) issues.push('Quantity missing or extraction uncertain');
  if (!fields.date) issues.push('Document date missing or extraction uncertain');
  const shipment = state.shipments.find(s => s.id === fields.shipmentId);
  if (fields.shipmentId && !shipment) issues.push('Shipment reference does not match an operational record');
  if (shipment && fields.quantity !== undefined && shipment.quantity !== fields.quantity) issues.push(`Quantity mismatch: document ${fields.quantity}, shipment ${shipment.quantity}; raw claim does not override trusted stock`);
  const uncertain = !text.trim() || !fields.shipmentId || fields.quantity === undefined || !fields.date || !shipment;
  const confidence = !text.trim() ? 0 : (Number(!!fields.shipmentId) + Number(fields.quantity !== undefined) + Number(!!fields.date)) / 3 * 0.9;
  const claim: DocumentClaim = { id: nextId(state, 'document'), filename: filename.trim(), text, fields, confidence, status: uncertain ? 'review' : issues.length ? 'mismatch' : 'matched', issues, source: 'Deterministic text field extraction; retained original document text' };
  state.documents.push(claim); audit(state, actor, 'document_extracted', claim.id, `${claim.status}; extraction confidence is heuristic, human review required for discrepancies`, [claim.id, ...(shipment ? [shipment.id] : [])], undefined, claim);
  if (claim.status !== 'matched') state.notifications.push({ id: nextId(state, 'notification'), at: state.clock, message: `${filename}: document ${claim.status} requires review`, read: false, orgId: 'focal' });
  return claim;
}
export function resolveDocument(state: State, id: string, actor: Actor): DocumentClaim {
  requireFocal(actor, ['warehouse', 'manager', 'procurement', 'admin']); const claim = find(state.documents, id, 'Document');
  if (!claim.fields.shipmentId || !state.shipments.some(s => s.id === claim.fields.shipmentId) || claim.fields.quantity === undefined) throw new DomainError('Unlinked or unextracted claims require corrected document evidence before confirmation', 409);
  if (claim.status === 'confirmed') throw new DomainError('Document has already been confirmed', 409);
  const before = structuredClone(claim); claim.status = 'confirmed'; claim.confirmedBy = actor.id;
  audit(state, actor, 'document_confirmed', id, 'Reviewer acknowledged extracted claim and retained discrepancy evidence; operational quantities require their own reconciled events', [id, claim.fields.shipmentId], before, claim);
  return claim;
}
export function setLotDisposition(state: State, id: string, status: 'available' | 'quarantined', actor: Actor): void {
  requireFocal(actor, ['warehouse', 'admin']); if (status !== 'available' && status !== 'quarantined') throw new DomainError('Disposition must be available or quarantined');
  const lot = find(state.lots, id, 'Lot');
  if (status === 'available' && lot.status === 'disputed') {
    const conflictTime = Math.max(-Infinity, ...state.events.filter(e => e.entityId === id && e.type === 'stock_count' && e.status === 'conflict').map(e => Date.parse(e.time)));
    const reconciled = state.events.some(e => e.entityId === id && e.type === 'stock_count' && e.status === 'accepted' && (e.payload.meaning ?? 'on_hand') === 'on_hand' && Date.parse(e.time) > conflictTime);
    if (actor.role !== 'admin' || !reconciled) throw new DomainError('Disputed stock requires a newer reconciled physical count and administrator disposition', 409);
  }
  const before = structuredClone(lot); lot.status = status; lot.version += 1;
  audit(state, actor, 'lot_disposition', id, `${status}: authorized human review under fictional demonstration quality policy`, sourceEvidence(state, [id]), before, lot);
  if (status === 'available') state.incidents.filter(i => i.entityId === id && ['condition_excursion', 'stock_conflict'].includes(i.type)).forEach(i => { i.status = 'resolved'; });
}
export function setTaskStatus(state: State, id: string, status: 'open' | 'done', actor: Actor): void {
  const task = find(state.tasks, id, 'Task'); const incident = find(state.incidents, task.incidentId, 'Incident');
  if (status !== 'open' && status !== 'done') throw new DomainError('Task status must be open or done');
  if (task.orgId !== actor.orgId || !incident.memberOrgIds.includes(actor.orgId) || (task.ownerId !== actor.id && !(actor.orgId === 'focal' && ['manager', 'admin'].includes(actor.role)))) throw new DomainError('You may update only your own scoped tasks or manage focal organization tasks', 403);
  const before = structuredClone(task); task.status = status; audit(state, actor, 'task_updated', id, `${task.title}: ${status}`, [incident.id], before, task);
}
export function runScenario(state: State, scenario: 'A' | 'B', actor: Actor): void {
  requireFocal(actor, ['analyst', 'manager', 'admin']);
  if (scenario !== 'A' && scenario !== 'B') throw new DomainError('Scenario must be A or B');
  if (state.integrationOutage) throw new DomainError('Restore and replay the integration before another scenario', 409);
  const time = state.clock; const prefix = `scenario-${scenario}-${state.version}`;
  if (scenario === 'A') {
    const delay = { id: `${prefix}-delay`, source: 'Synthetic scenario A', type: 'supplier_delay' as const, entityId: 'supplier-core', time, payload: { delayHours: 48 } };
    ingestEvent(state, delay, actor); ingestEvent(state, delay, actor);
    ingestEvent(state, { ...delay, id: `${prefix}-correlated` }, actor);
    ingestEvent(state, { id: `${prefix}-outage`, source: 'Synthetic scenario A', type: 'warehouse_outage', entityId: 'warehouse-west', time, payload: { status: 'outage' } }, actor);
    // Same effective-time/scope contradiction is deliberately retained as evidence.
    ingestEvent(state, { id: `${prefix}-count-1`, source: 'Synthetic WMS count', type: 'stock_count', entityId: 'lot-west', time, payload: { quantity: 100, meaning: 'on_hand' } }, actor);
    ingestEvent(state, { id: `${prefix}-count-2`, source: 'Synthetic cycle count', type: 'stock_count', entityId: 'lot-west', time, payload: { quantity: 95, meaning: 'on_hand' } }, actor);
  } else {
    ingestEvent(state, { id: `${prefix}-condition`, source: 'Synthetic temperature sensor', type: 'condition_reading', entityId: 'lot-east', time, payload: { temperature: 37, durationMinutes: 25 } }, actor);
    inspectDocument(state, 'synthetic-atlas-manifest.txt', 'Shipment: shipment-atlas\nQuantity: 127\nDate: 2026-10-30', actor);
    ingestEvent(state, { id: `${prefix}-invalid-count`, source: 'Synthetic malformed input', type: 'stock_count', entityId: 'lot-east', time, payload: { quantity: -3 } }, actor);
    ingestEvent(state, { id: `${prefix}-broken-reference`, source: 'Synthetic unmapped sensor', type: 'condition_reading', entityId: 'unknown-lot', time, payload: { temperature: 40, durationMinutes: 25 } }, actor);
    const current = { id: `${prefix}-eta-current`, source: 'Synthetic carrier', type: 'shipment_eta' as const, entityId: 'shipment-atlas', time: atHours(state, 2), payload: { eta: atHours(state, 40) } };
    ingestEvent(state, current, actor);
    state.integrationOutage = true; audit(state, actor, 'integration_outage', 'integration', 'Limited capture remains available; source processing paused and queued durably');
    ingestEvent(state, { ...current, id: `${prefix}-eta-old`, time, payload: { eta: state.shipments.find(s => s.id === 'shipment-atlas')!.baselineEta } }, actor);
    const queued = { ...current, id: `${prefix}-eta-queued`, time: atHours(state, 1), payload: { eta: atHours(state, 46) } };
    ingestEvent(state, queued, actor); ingestEvent(state, queued, actor);
  }
  audit(state, actor, 'scenario_applied', `scenario-${scenario}`, `Applied reproducible synthetic scenario ${scenario}; use reset for independent comparisons`, state.events.filter(e => e.id.startsWith(prefix)).map(e => e.id));
}
