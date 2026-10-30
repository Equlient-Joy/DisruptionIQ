import type { State } from '../shared/types';
import { defaultIntegrations } from './normalize';

/** Operationally empty workspace for judges; initial setup has no baked records. */
export function createEmptyState(now = new Date()): State {
  const clock = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  return {
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

/** Reproducible fictional electronics distribution workspace; all times use the displayed simulation clock. */
export function createSeedState(now = new Date()): State {
  if (!Number.isFinite(now.getTime())) throw new Error('Seed time must be a valid date');
  const time = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  return {
    version: 1, clock: time(0), integrationOutage: false,
    suppliers: [
      { id: 'supplier-atlas', name: 'Atlas Assemblies', tier: 1, facility: 'Pune Assembly', components: ['controller'], approved: true, leadHours: 24, minOrder: 25, capacity: 180, unitCostCents: 12500, orgId: 'partner' },
      { id: 'supplier-beacon', name: 'Beacon Electronics', tier: 1, facility: 'Chennai Assembly', components: ['controller'], approved: true, leadHours: 30, minOrder: 20, capacity: 140, unitCostCents: 13200, orgId: 'partner' },
      { id: 'supplier-core', name: 'Core Silicon', tier: 2, facility: 'Fictional Shared Wafer Plant', components: ['controller'], approved: false, leadHours: 72, minOrder: 100, capacity: 300, unitCostCents: 8000, orgId: 'partner' },
      { id: 'supplier-reserve', name: 'Reserve Circuit Works', tier: 1, facility: 'Hyderabad Reserve Line', components: ['controller'], approved: true, leadHours: 10, minOrder: 25, capacity: 180, unitCostCents: 15600, orgId: 'focal' },
      { id: 'supplier-unverified', name: 'Unverified Components', tier: 1, facility: 'Undeclared facility', components: ['controller'], approved: false, leadHours: 6, minOrder: 10, capacity: 100, unitCostCents: 9000, orgId: 'focal' },
    ],
    dependencies: [
      { id: 'dep-atlas-core', parentId: 'supplier-atlas', childId: 'supplier-core', itemId: 'controller', confidence: 0.95, source: 'Synthetic partner declaration 2026-10', verified: true },
      { id: 'dep-beacon-core', parentId: 'supplier-beacon', childId: 'supplier-core', itemId: 'controller', confidence: 0.8, source: 'Synthetic partner declaration; facility audit pending', verified: false },
    ],
    warehouses: [
      { id: 'warehouse-east', name: 'East Distribution Hub', region: 'East', capacity: 240, status: 'online' },
      { id: 'warehouse-west', name: 'West Distribution Hub', region: 'West', capacity: 180, status: 'online' },
    ],
    lots: [
      { id: 'lot-east', itemId: 'controller', name: 'East controller batch', warehouseId: 'warehouse-east', quantity: 40, reserved: 10, status: 'available', version: 1 },
      { id: 'lot-west', itemId: 'controller', name: 'West controller batch', warehouseId: 'warehouse-west', quantity: 100, reserved: 30, status: 'available', version: 1 },
      { id: 'lot-hold', itemId: 'controller', name: 'Inspection batch — existing quality hold', warehouseId: 'warehouse-west', quantity: 25, reserved: 0, status: 'held', version: 1 },
    ],
    shipments: [
      { id: 'shipment-atlas', supplierId: 'supplier-atlas', warehouseId: 'warehouse-east', itemId: 'controller', quantity: 120, status: 'in_transit', eta: time(12), baselineEta: time(12), etaHistory: [
        { eta: time(12), at: time(-8), source: 'Synthetic carrier forecast' }, { eta: time(12), at: time(-4), source: 'Synthetic carrier forecast' }, { eta: time(12), at: time(-1), source: 'Synthetic carrier forecast' },
      ] },
      { id: 'shipment-beacon', supplierId: 'supplier-beacon', warehouseId: 'warehouse-west', itemId: 'controller', quantity: 90, status: 'in_transit', eta: time(12), baselineEta: time(12), etaHistory: [
        { eta: time(6), at: time(-8), source: 'Synthetic carrier forecast' }, { eta: time(23), at: time(-4), source: 'Synthetic carrier forecast' }, { eta: time(12), at: time(-1), source: 'Synthetic carrier forecast' },
      ] },
    ],
    orders: [
      { id: 'order-hospital', customer: 'Fictional Meridian Medical', itemId: 'controller', warehouseId: 'warehouse-east', quantity: 100, fulfilled: 0, deadline: time(24), priority: 'critical', penaltyCents: 750000, status: 'open' },
      { id: 'order-transit', customer: 'Fictional Civic Transit', itemId: 'controller', warehouseId: 'warehouse-west', quantity: 90, fulfilled: 0, deadline: time(30), priority: 'high', penaltyCents: 420000, status: 'open' },
    ],
    events: [], incidents: [], plans: [], decisions: [], tasks: [], documents: [], notifications: [], queue: [], aiReports: [],
    integrations: defaultIntegrations(time(0)),
  };
}
