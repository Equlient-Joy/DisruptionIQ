import type { Hono } from 'hono';
import { z } from 'zod';
import type { Actor } from '../shared/types';
import type { Repository } from './repository';
import { requireFocal } from '../domain/common';
import { importId } from '../domain/catalog';
import { parseSimulationDataset, simulationSummary } from '../domain/simulation-dataset';
import { attachSimulation, advanceSimulationDay, controlSimulation } from '../domain/simulation';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function registerSimulationRoutes(app: Hono<{Variables: {actor: Actor}}>, repo: Repository): void {
  app.get('/api/simulation', async c => {
    requireFocal(c.get('actor'), ['analyst','manager','warehouse','procurement','admin','viewer']);
    return c.json({simulation: simulationSummary(await repo.read())});
  });
  app.post('/api/simulation/dataset', async c => {
    const actor = c.get('actor'); requireFocal(actor, ['manager','admin']);
    const {content} = z.object({content: z.string()}).parse(await c.req.json());
    const stored = parseSimulationDataset(content);
    const simulation = await repo.mutate(s => attachSimulation(s,actor,stored));
    return c.json({simulation});
  });
  app.post('/api/simulation/control', async c => {
    const actor = c.get('actor'); requireFocal(actor, ['manager','admin']);
    const input = z.object({datasetHash:hash,action:z.enum(['pause','resume'])}).parse(await c.req.json());
    return c.json({simulation:await repo.mutate(s=>controlSimulation(s,actor,input))});
  });
  app.post('/api/simulation/advance', async c => {
    const actor = c.get('actor'); requireFocal(actor, ['manager','admin']);
    const input=z.object({datasetHash:hash,expectedDayIndex:z.number().int().nonnegative(),requestId:importId}).parse(await c.req.json());
    const result=await repo.mutate(s=>advanceSimulationDay(s,actor,input,new Date().toISOString()));
    if(result.newlyCommitted) {
      const state=await repo.read();
      for(const entry of result.receipt.events.filter(x=>x.status==='accepted')) {
        const event=[...state.events].reverse().find(x=>x.id===entry.id && x.source===entry.source && x.status==='accepted');
        if(event && ['supplier_delay','supplier_commitment','warehouse_outage','shipment_eta','stock_count'].includes(event.type)) {
          const incident=state.incidents.find(x=>x.entityId===event.entityId && x.status!=='resolved');
          repo.agentBus.publish('disruption:ingested',{event,incident,state});
        }
      }
    }
    return c.json(result);
  });
}
