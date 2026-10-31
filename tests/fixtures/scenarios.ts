import type { State, Actor } from '../../src/shared/types';
import { atHours, audit, DomainError, requireFocal, sourceEvidence } from '../../src/domain/common';
import { ingestEvent, inspectDocument } from '../../src/domain/engine';
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
    const lotEast = state.lots.find(l => l.id === 'lot-east');
    if (lotEast) {
      const before = structuredClone(lotEast);
      lotEast.status = 'held';
      lotEast.version += 1;
      audit(state, actor, 'lot_disposition', lotEast.id, 'Scenario B synthetic quality hold placed on lot', sourceEvidence(state, [lotEast.id]), before, lotEast);
    }
    inspectDocument(state, 'synthetic-atlas-manifest.txt', 'Shipment: shipment-atlas\nQuantity: 127\nDate: 2026-10-30', actor);
    ingestEvent(state, { id: `${prefix}-invalid-count`, source: 'Synthetic malformed input', type: 'stock_count', entityId: 'lot-east', time, payload: { quantity: -3 } }, actor);
    const current = { id: `${prefix}-eta-current`, source: 'Synthetic carrier', type: 'shipment_eta' as const, entityId: 'shipment-atlas', time: atHours(state, 2), payload: { eta: atHours(state, 40) } };
    ingestEvent(state, current, actor);
    state.integrationOutage = true; audit(state, actor, 'integration_outage', 'integration', 'Limited capture remains available; source processing paused and queued durably');
    ingestEvent(state, { ...current, id: `${prefix}-eta-old`, time, payload: { eta: state.shipments.find(s => s.id === 'shipment-atlas')!.baselineEta } }, actor);
    const queued = { ...current, id: `${prefix}-eta-queued`, time: atHours(state, 1), payload: { eta: atHours(state, 46) } };
    ingestEvent(state, queued, actor); ingestEvent(state, queued, actor);
  }
  audit(state, actor, 'scenario_applied', `scenario-${scenario}`, `Applied reproducible synthetic scenario ${scenario}; use reset for independent comparisons`, state.events.filter(e => e.id.startsWith(prefix)).map(e => e.id));
}

