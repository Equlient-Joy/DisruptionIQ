import Papa from 'papaparse';
import type { Actor, State, ImportResult } from '../shared/types';
import { ingestEvent } from '../domain/engine';
import { appendCatalogRow, eventSchema, type CatalogEntity } from '../domain/catalog';
import { appendDecision } from '../domain/audit';
export { eventSchema } from '../domain/catalog';

export type ImportEntity = CatalogEntity | 'events';
export function importRows(state:State,actor:Actor,entity:ImportEntity,format:'csv'|'json',content:string): ImportResult {
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
      if(entity==='events') {
        const event=ingestEvent(state,eventSchema.parse(raw),actor);
        if(['invalid','conflict','stale'].includes(event.status)) errors.push({row:i+1,message:event.message}); else accepted++;
      } else {
        appendCatalogRow(state,entity,raw); accepted++;
      }
    } catch(error) {errors.push({row:i+1,message:error instanceof Error?error.message:'Invalid row'});}
  }
  appendDecision(state, {id:sourceId,at:state.clock,actorId:actor.id,action:'data_imported',entityId:entity,detail:`${format.toUpperCase()} import: ${accepted} accepted; ${errors.length} validation errors. Original input retained.`,after:{format,content,errors,accepted},evidenceIds:[sourceId],ruleVersion:'import-v1'});
  return {accepted,errors,total:rows.length};
}
