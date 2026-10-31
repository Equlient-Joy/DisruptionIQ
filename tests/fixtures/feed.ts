import type { SimulationDataset, CatalogRows } from '../../src/shared/simulation';
import { createSeedState } from './enterprise';

export function emptyCatalog(): CatalogRows {
  return { suppliers: [], dependencies: [], warehouses: [], lots: [], shipments: [], orders: [] };
}
export function feedFixture(days = 2): SimulationDataset {
  const seed = createSeedState(new Date('2026-11-01T00:00:00Z'));
  return {
    schemaVersion: 1, datasetId: 'test-feed', name: 'Test enterprise', seed: 'test', startDate: '2026-11-01', generatorVersion: 'test-1',
    days: Array.from({ length: days }, (_, index) => ({
      index, date: new Date(Date.UTC(2026, 10, 1 + index)).toISOString().slice(0, 10), label: `Day ${index + 1}`,
      catalog: index === 0 ? { suppliers: seed.suppliers, dependencies: seed.dependencies, warehouses: seed.warehouses, lots: seed.lots, shipments: seed.shipments, orders: seed.orders } : emptyCatalog(),
      events: [], documents: [],
    })),
  };
}
