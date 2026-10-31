import { z } from 'zod';
import type { State, Dependency } from '../shared/types';
import { DomainError } from './common';

export const importId = z.string().trim().min(1).max(120);
const id = importId;
const count = z.coerce.number().int().min(0).max(1_000_000_000);
export const timestampSchema = z.string().refine(x => Number.isFinite(Date.parse(x)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(x), 'Use an ISO timestamp with timezone');
const date = timestampSchema;
const bool = z.preprocess(v => v === 'true' ? true : v === 'false' ? false : v, z.boolean());
export const eventSchema = z.object({ id, source: id, type: z.enum(['supplier_delay', 'supplier_commitment', 'shipment_eta', 'stock_count', 'warehouse_outage', 'shipment_status']), entityId: id, time: date, payload: z.record(z.string(), z.unknown()), integrationId: id.optional(), correlationId: id.optional() });
export const commitmentSchema = z.object({ itemId: id, expectedQuantity: count.refine(x => x > 0), confirmedQuantity: count, dueAt: date, status: z.enum(['ready','delayed','broken','fulfilled']), updatedAt: date }).refine(x => x.confirmedQuantity <= x.expectedQuantity, 'Confirmed units cannot exceed the commitment').refine(x => x.status !== 'fulfilled' || x.confirmedQuantity === x.expectedQuantity, 'Fulfilled commitments must cover the promised quantity');
export const catalogSchemas = {
  suppliers: z.object({id,name:id,tier:z.coerce.number().int().min(1).max(10),facility:id,components:z.preprocess(x=>typeof x==='string'?x.split('|').filter(Boolean):x,z.array(id).min(1)),approved:bool,leadHours:count,minOrder:count,capacity:count,unitCostCents:count,orgId:id,commitments:z.array(commitmentSchema).optional()}).refine(x => !x.commitments || new Set(x.commitments.map(c => c.itemId)).size === x.commitments.length, 'Only one current commitment per supplier/item is allowed'),
  warehouses: z.object({id,name:id,region:id,capacity:count,status:z.enum(['online','outage'])}),
  dependencies: z.object({id,parentId:id,childId:id,itemId:id,confidence:z.coerce.number().min(0).max(1),source:id,verified:bool}),
  lots: z.object({id,itemId:id,name:id,warehouseId:id,quantity:count,reserved:count,status:z.enum(['available','held','quarantined','disputed']).transform(s=>s==='quarantined'?'held':s),version:count}).refine(x=>x.reserved<=x.quantity,'Reserved units cannot exceed physical quantity'),
  shipments: z.object({id,supplierId:id,warehouseId:id,itemId:id,quantity:count,status:z.enum(['scheduled','in_transit','delayed','delivered']),eta:date,baselineEta:date,etaHistory:z.preprocess(x=>typeof x==='string'?JSON.parse(x||'[]'):x??[],z.array(z.object({eta:date,at:date,source:id}))),lotId:id.optional()}),
  orders: z.object({id,customer:id,itemId:id,warehouseId:id,quantity:count.refine(x=>x>0),fulfilled:count,deadline:date,priority:z.enum(['critical','high','normal']),penaltyCents:count,status:z.enum(['open','recovering','fulfilled'])}).refine(x=>x.fulfilled<=x.quantity,'Fulfilled units cannot exceed ordered units'),
};
export type CatalogEntity = keyof typeof catalogSchemas;
export type CatalogRows = Pick<State, CatalogEntity>;
export const catalogOrder: CatalogEntity[] = ['suppliers', 'warehouses', 'dependencies', 'lots', 'shipments', 'orders'];

export function appendCatalogRow<K extends CatalogEntity>(state: State, entity: K, input: unknown): CatalogRows[K][number] {
  const record = catalogSchemas[entity].parse(input);
  if (state[entity].some(x => x.id === record.id)) throw new DomainError('Existing IDs cannot be overwritten by catalog imports. Use a validated event or a new ID.');
  if ('warehouseId' in record && !state.warehouses.some(x => x.id === record.warehouseId)) throw new DomainError(`Unknown warehouse ${record.warehouseId}`);
  if ('supplierId' in record && !state.suppliers.some(x => x.id === record.supplierId)) throw new DomainError(`Unknown supplier ${record.supplierId}`);
  if ('lotId' in record && record.lotId) {
    const lot = state.lots.find(x => x.id === record.lotId);
    if (!lot) throw new DomainError(`Unknown lot ${record.lotId}`);
    if (lot.warehouseId !== record.warehouseId || lot.itemId !== record.itemId) throw new DomainError(`Lot ${record.lotId} item or warehouse does not match shipment`);
  }
  if (entity === 'dependencies') {
    const edge = record as Dependency;
    if (!state.suppliers.some(x => x.id === edge.parentId) || !state.suppliers.some(x => x.id === edge.childId)) throw new DomainError('Dependency endpoints must reference known suppliers');
    const visited = new Set<string>();
    const reaches = (node: string): boolean => {
      if (node === edge.parentId) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      return state.dependencies.filter(x => x.parentId === node).some(x => reaches(x.childId));
    };
    if (reaches(edge.childId)) throw new DomainError('Dependency cannot introduce a cycle or self edge');
  }
  (state[entity] as {id: string}[]).push(record);
  return record as CatalogRows[K][number];
}
