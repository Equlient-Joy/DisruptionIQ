import Papa from 'papaparse';
import { z } from 'zod';
import type { Actor, State, EventInput } from '../shared/types';
import { ingestEvent } from '../domain/engine';

const id = z.string().trim().min(1).max(120);
const count = z.coerce.number().int().min(0).max(1_000_000_000);
const date = z.string().refine(x => Number.isFinite(Date.parse(x)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(x),'Use an ISO timestamp with timezone');
const bool = z.preprocess(v => v === 'true' ? true : v === 'false' ? false : v,z.boolean());
export const eventSchema = z.object({id,source:id,type:z.enum(['supplier_delay','shipment_eta','stock_count','warehouse_outage','shipment_status']),entityId:id,time:date,payload:z.record(z.string(),z.unknown())});
const schemas = {
  suppliers: z.object({id,name:id,tier:z.coerce.number().int().min(1).max(10),facility:id,components:z.preprocess(x=>typeof x==='string'?x.split('|').filter(Boolean):x,z.array(id).min(1)),approved:bool,leadHours:count,minOrder:count,capacity:count,unitCostCents:count,orgId:id}),
  warehouses: z.object({id,name:id,region:id,capacity:count,status:z.enum(['online','outage'])}),
  lots: z.object({id,itemId:id,name:id,warehouseId:id,quantity:count,reserved:count,status:z.enum(['available','held','quarantined','disputed']).transform(s=>s==='quarantined'?'held':s),version:count}).refine(x=>x.reserved<=x.quantity,'Reserved units cannot exceed physical quantity'),
  shipments: z.object({id,supplierId:id,warehouseId:id,itemId:id,quantity:count,status:z.enum(['scheduled','in_transit','delayed','delivered']),eta:date,baselineEta:date,etaHistory:z.preprocess(x=>typeof x==='string'?JSON.parse(x||'[]'):x??[],z.array(z.object({eta:date,at:date,source:id}))),lotId:id.optional()}),
  orders: z.object({id,customer:id,itemId:id,warehouseId:id,quantity:count.refine(x=>x>0),fulfilled:count,deadline:date,priority:z.enum(['critical','high','normal']),penaltyCents:count,status:z.enum(['open','recovering','fulfilled'])}).refine(x=>x.fulfilled<=x.quantity,'Fulfilled units cannot exceed ordered units'),
  events: eventSchema,
};
export type ImportEntity = keyof typeof schemas;
export function importRows(state:State,actor:Actor,entity:ImportEntity,format:'csv'|'json',content:string) {
  let rows:unknown[];
  const errors:{row:number;message:string}[]=[];
  if (format==='csv') {
    const parsed=Papa.parse<Record<string,string>>(content,{header:true,skipEmptyLines:'greedy'});
    rows=parsed.data;
    for(const e of parsed.errors) errors.push({row:(e.row??0)+2,message:e.message});
  } else {
    const value=JSON.parse(content); rows=Array.isArray(value)?value:[value];
  }
  if(rows.length>2000) throw new Error('Maximum 2,000 rows per import.');
  const sourceId=`import-${crypto.randomUUID()}`; let accepted=0;
  for(let i=0;i<rows.length;i++) {
    try {
      const raw=rows[i] as Record<string,unknown>;
      if(entity==='events' && typeof raw?.payload==='string') raw.payload=JSON.parse(raw.payload);
      const result=schemas[entity].safeParse(raw);
      if(!result.success) { errors.push({row:i+1,message:result.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')}); continue; }
      const record=result.data as any;
      if ('warehouseId' in record && !state.warehouses.some(x=>x.id===record.warehouseId)) throw new Error(`Unknown warehouse ${record.warehouseId}`);
      if ('supplierId' in record && !state.suppliers.some(x=>x.id===record.supplierId)) throw new Error(`Unknown supplier ${record.supplierId}`);
      if (entity === 'shipments' && record.lotId) {
        const lot = state.lots.find(x => x.id === record.lotId);
        if (!lot) throw new Error(`Unknown lot ${record.lotId}`);
        if (lot.warehouseId !== record.warehouseId || lot.itemId !== record.itemId) throw new Error(`Lot ${record.lotId} item or warehouse does not match shipment`);
      }
      if(entity==='events') {
        const event=ingestEvent(state,record as EventInput,actor);
        if(['invalid','conflict','stale'].includes(event.status)) errors.push({row:i+1,message:event.message}); else accepted++;
      } else {
        const collection=state[entity] as {id:string}[];
        if(collection.some(x=>x.id===record.id)) throw new Error('Existing IDs cannot be overwritten by catalog imports. Use a validated event or a new ID.');
        collection.push(record); accepted++;
      }
    } catch(error) {errors.push({row:i+1,message:error instanceof Error?error.message:'Invalid row'});}
  }
  state.decisions.push({id:sourceId,at:state.clock,actorId:actor.id,action:'data_imported',entityId:entity,detail:`${format.toUpperCase()} import: ${accepted} accepted; ${errors.length} validation errors. Original input retained.`,after:{format,content,errors,accepted},evidenceIds:[sourceId],ruleVersion:'import-v1'});
  return {accepted,errors,total:rows.length};
}
