import type { State } from '../shared/types';
import { defaultIntegrations } from './normalize';

/** Operationally empty workspace for judges; initial setup has no baked records. */
export function createEmptyState(now = new Date()): State {
  const clock = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  return {
    workspaceGeneration: 1,
    simulation: undefined,
    simulationDataset: undefined,
    version: 1,
    clock,
    suppliers: [],
    dependencies: [],
    warehouses: [],
    lots: [],
    shipments: [],
    orders: [],
    incidents: [],
    tasks: [],
    events: [],
    plans: [],
    decisions: [],
    documents: [],
    notifications: [],
    integrations: defaultIntegrations(clock),
    aiReports: [],
    queue: [],
  };
}
