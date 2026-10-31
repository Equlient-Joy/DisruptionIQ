import type { Actor, DocumentClaim, State } from '../shared/types';
import { audit, DomainError, find, integer, nextId, requireFocal, sourceEvidence, validTime } from './common';

export { DomainError } from './common';
export { getImpact } from './impact';
export { generatePlans, decidePlan } from './plans';
export { ingestEvent, replayQueue, integrationForEvent } from './events';

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
  if (claim.status !== 'matched') state.notifications.push({ id: nextId(state, 'notification'), at: state.clock, message: `${filename}: document ${claim.status} requires review`, read: false, orgId: 'focal', targetRoles: ['warehouse', 'procurement', 'manager', 'admin'] });
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
export function setLotDisposition(state: State, id: string, status: 'available' | 'held' | 'quarantined', actor: Actor): void {
  const targetStatus = status === 'quarantined' ? 'held' : status;
  requireFocal(actor, ['warehouse', 'admin']); if (targetStatus !== 'available' && targetStatus !== 'held') throw new DomainError('Disposition must be available or held');
  const lot = find(state.lots, id, 'Lot');
  if (targetStatus === 'available' && lot.status === 'disputed') {
    const conflictTime = Math.max(-Infinity, ...state.events.filter(e => e.entityId === id && e.type === 'stock_count' && e.status === 'conflict').map(e => Date.parse(e.time)));
    const reconciled = state.events.some(e => e.entityId === id && e.type === 'stock_count' && e.status === 'accepted' && (e.payload.meaning ?? 'on_hand') === 'on_hand' && Date.parse(e.time) > conflictTime);
    if (actor.role !== 'admin' || !reconciled) throw new DomainError('Disputed stock requires a newer reconciled physical count and administrator disposition', 409);
  }
  const before = structuredClone(lot); lot.status = targetStatus; lot.version += 1;
  audit(state, actor, 'lot_disposition', id, `${targetStatus}: authorized human review under quality policy`, sourceEvidence(state, [id]), before, lot);
  if (targetStatus === 'available') state.incidents.filter(i => i.entityId === id && i.type === 'stock_conflict').forEach(i => { i.status = 'resolved'; });
}
export function setTaskStatus(state: State, id: string, status: 'open' | 'done', actor: Actor): void {
  if (actor.role === 'viewer') throw new DomainError('Partner viewers have read-only visibility.', 403);
  const task = find(state.tasks, id, 'Task'); const incident = find(state.incidents, task.incidentId, 'Incident');
  if (status !== 'open' && status !== 'done') throw new DomainError('Task status must be open or done');
  if (task.orgId !== actor.orgId || !incident.memberOrgIds.includes(actor.orgId) || (task.ownerId !== actor.id && !(actor.orgId === 'focal' && ['manager', 'admin'].includes(actor.role)))) throw new DomainError('You may update only your own scoped tasks or manage focal organization tasks', 403);
  const before = structuredClone(task); task.status = status; audit(state, actor, 'task_updated', id, `${task.title}: ${status}`, [incident.id], before, task);
}
