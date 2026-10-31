import type { Actor, Decision, Incident, State } from '../shared/types';
import { appendDecision } from './audit';

export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'DomainError'; this.status = status; }
}
export const RULE_VERSION = 'disruptioniq-demo-1.0';
export const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const validTime = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
export const atHours = (state: State, hours: number) => new Date(Date.parse(state.clock) + hours * 3_600_000).toISOString();
export function requireFocal(actor: Actor, roles: Actor['role'][]): void {
  if (actor.orgId !== 'focal' || !roles.includes(actor.role)) throw new DomainError('Your organization or role cannot perform this action', 403);
}
export function find<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find(x => x.id === id); if (!item) throw new DomainError(`${label} not found`, 404); return item;
}
export function nextId(state: State, prefix: string): string {
  return `${prefix}-${state.version}-${state.decisions.length + 1}-${state.events.length + 1}`;
}
export function audit(state: State, actor: Actor, action: string, entityId: string, detail: string, evidenceIds: string[] = [], before?: unknown, after?: unknown): Decision {
  const base: Omit<Decision, 'previousHash' | 'hash'> = {
    id: nextId(state, 'decision'),
    at: state.clock,
    actorId: actor.id,
    action,
    entityId,
    detail,
    evidenceIds: [...new Set(evidenceIds)],
    ruleVersion: RULE_VERSION,
  };
  if (before !== undefined) base.before = structuredClone(before);
  if (after !== undefined) base.after = structuredClone(after);
  return appendDecision(state, base);
}
export function incident(state: State, actor: Actor, type: string, entityId: string, title: string, description: string, affectedOrderIds: string[], evidenceId: string): Incident {
  let existing = state.incidents.find(i => i.type === type && i.entityId === entityId && i.status !== 'resolved');
  if (existing) { existing.alertCount += 1; existing.affectedOrderIds = [...new Set([...existing.affectedOrderIds, ...affectedOrderIds])]; }
  else {
    existing = { id: nextId(state, 'incident'), type, entityId, title, description, status: 'active', createdAt: state.clock, memberOrgIds: ['focal', 'partner'], affectedOrderIds: [...new Set(affectedOrderIds)], alertCount: 1 };
    state.incidents.push(existing);
    state.tasks.push(
      { id: `${existing.id}-verify`, incidentId: existing.id, title: 'Verify disruption evidence and customer exposure', ownerId: 'analyst-1', orgId: 'focal', status: 'open', dueAt: atHours(state, 4) },
      { id: `${existing.id}-partner`, incidentId: existing.id, title: 'Confirm supplier facts and provide revised timing', ownerId: 'partner-1', orgId: 'partner', status: 'open', dueAt: atHours(state, 3) },
      { id: `${existing.id}-review`, incidentId: existing.id, title: 'Review recovery capacity and approval', ownerId: 'manager-1', orgId: 'focal', status: 'open', dueAt: atHours(state, 6) },
    );
  }
  state.notifications.push({ id: nextId(state, 'notification'), at: state.clock, message: title, incidentId: existing.id, read: false, orgId: 'focal', targetRoles: ['analyst', 'manager', 'admin'] });
  audit(state, actor, 'incident_correlated', existing.id, description, [evidenceId]);
  return existing;
}
/** Traverse declared edges only; unverified links remain explicitly marked in impact explanations. */
export function upstreamPaths(state: State, supplierId: string): string[][] {
  const paths: string[][] = [];
  function walk(id: string, path: string[]): void {
    paths.push(path); for (const edge of state.dependencies.filter(e => e.parentId === id)) if (!path.includes(edge.childId)) walk(edge.childId, [...path, edge.childId]);
  }
  walk(supplierId, [supplierId]); return paths;
}
export const sourceEvidence = (state: State, entityIds: string[]) => [...new Set([
  ...state.events.filter(e => entityIds.includes(e.entityId)).map(e => e.id),
  ...state.dependencies.filter(d => entityIds.includes(d.parentId) || entityIds.includes(d.childId)).map(d => d.id),
])];
