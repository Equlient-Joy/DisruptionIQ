import type { Supplier, Dependency, Warehouse, Lot, Shipment, Order, EventInput, RawEvent } from './types';
export type CatalogRows = { suppliers: Supplier[]; dependencies: Dependency[]; warehouses: Warehouse[]; lots: Lot[]; shipments: Shipment[]; orders: Order[] };
export type CatalogEntity = keyof CatalogRows;
export type EventCounts = Record<RawEvent['status'], number>;
export interface SimulationDay { index: number; date: string; label: string; catalog: CatalogRows; events: EventInput[]; documents: { id: string; filename: string; text: string }[] }
export interface SimulationDataset { schemaVersion: 1; datasetId: string; name: string; seed: string; startDate: string; generatorVersion: string; days: SimulationDay[] }
export interface StoredSimulationDataset { dataset: SimulationDataset; content: string; hash: string }
export interface ImpactSnapshot { affectedOrders: number; uncoveredUnits: number; executedPlans: number }
export interface DayReceipt {
  requestId: string; datasetHash: string; dayIndex: number; date: string; deliveredAt: string; actorId: string;
  clockBefore: string; clockAfter: string; catalogCounts: Record<CatalogEntity, number>; eventCounts: EventCounts;
  events: { source: string; id: string; status: RawEvent['status'] }[];
  documents: { sourceId: string; documentId: string }[]; newIncidentIds: string[]; before: ImpactSnapshot; after: ImpactSnapshot;
}
export interface SimulationProgress { datasetId: string; datasetHash: string; name: string; seed: string; startDate: string; totalDays: number; completedDays: number; status: 'ready' | 'paused' | 'complete'; deliveredThrough?: string; receipts: DayReceipt[] }
export interface AdvanceDayCommand { datasetHash: string; expectedDayIndex: number; requestId: string }
export interface AdvanceDayResult { receipt: DayReceipt; newlyCommitted: boolean }
