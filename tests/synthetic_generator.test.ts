import { describe, expect, test } from 'bun:test';
import { generateEnterpriseDataset, renderPresenterGuide } from '../scripts/synthetic/generator';
import { parseSimulationDataset } from '../src/domain/simulation-dataset';
import { createEmptyState } from '../src/domain/seed';
import { attachSimulation, advanceSimulationDay } from '../src/domain/simulation';
import { generatePlans, getImpact, decidePlan } from '../src/domain/engine';
import type { Actor } from '../src/shared/types';
const admin:Actor={id:'admin-1',name:'Admin',email:'admin@test.local',role:'admin',orgId:'focal'};

describe('external synthetic generator',()=>{
  test('later discrepancy evidence cannot replenish a lot consumed by confirmed recovery',()=>{
    const dataset=generateEnterpriseDataset({seed:'judges-2026',startDate:'2026-11-01',days:7});
    const state=createEmptyState();const stored=parseSimulationDataset(JSON.stringify(dataset));attachSimulation(state,admin,stored);
    const advance=(index:number)=>advanceSimulationDay(state,admin,{datasetHash:stored.hash,expectedDayIndex:index,requestId:`recovery-${index}`},'2026-11-01T12:00:00Z');
    advance(0);advance(1);
    const plan=generatePlans(state,state.incidents[0]!.id,{...admin,id:'analyst-1',role:'analyst'}).find(p=>p.feasible && p.type==='reallocate')!;
    expect(plan).toBeDefined();
    decidePlan(state,plan.id,{action:'approve',confirmed:true},{...admin,id:'manager-1',role:'manager'});
    if(plan.status==='awaiting_second_approval') decidePlan(state,plan.id,{action:'approve',confirmed:true},admin);
    const remaining=state.lots.find(l=>l.id===plan.sourceId)!.quantity;
    advance(2);advance(3);
    expect(state.lots.find(l=>l.id===plan.sourceId)!.quantity).toBe(remaining);
    expect(state.events.some(e=>e.status==='conflict')).toBe(true);
  });
  test('same inputs reproduce the exact package and different seeds remain valid',()=>{
    const options={seed:'judges-2026',startDate:'2026-11-01',days:7};
    const first=generateEnterpriseDataset(options);
    expect(generateEnterpriseDataset(options)).toEqual(first);
    expect(generateEnterpriseDataset({...options,seed:'another'})).not.toEqual(first);
    for(const days of [1,7,30]) expect(parseSimulationDataset(JSON.stringify(generateEnterpriseDataset({...options,days}))).dataset.days).toHaveLength(days);
    expect(renderPresenterGuide(first)).toContain('Next day');
  });
  test('generated days use ingestion to expose disruptions, recoveries and actual anomaly evidence',()=>{
    const data=generateEnterpriseDataset({seed:'judges-2026',startDate:'2026-11-01',days:7});
    const state=createEmptyState();const stored=parseSimulationDataset(JSON.stringify(data));
    attachSimulation(state,admin,stored);expect(state.suppliers).toHaveLength(0);
    const types=new Set<string>();
    for(let index=0;index<7;index++) {
      advanceSimulationDay(state,admin,{datasetHash:stored.hash,expectedDayIndex:index,requestId:`day-${index}`},'2026-11-01T12:00:00Z');
      if(index===1) {
        expect(getImpact(state).length).toBeGreaterThan(0);
        expect(state.dependencies).toHaveLength(2);
        for(const incident of state.incidents) for(const plan of generatePlans(state,incident.id,{...admin,id:'analyst-1',role:'analyst'})) types.add(plan.type);
        expect(state.plans.some(p=>p.feasible)).toBe(true);
      }
    }
    expect([...types].sort()).toEqual(['alternative_supplier','expedite','reallocate','split_order']);
    expect(state.incidents.some(i=>i.type==='supplier_delay')).toBe(true);
    expect(state.incidents.some(i=>i.type==='warehouse_outage')).toBe(true);
    expect(state.events.some(e=>e.status==='duplicate')).toBe(true);
    expect(state.events.some(e=>e.status==='conflict')).toBe(true);
    expect(state.events.some(e=>e.status==='invalid')).toBe(true);
    expect(state.documents.some(d=>d.status==='mismatch')).toBe(true);
    expect(state.lots.some(l=>l.status==='held')).toBe(true);
    expect(state.simulation!.status).toBe('complete');
    expect(state.plans.every(p=>p.status!=='executed')).toBe(true);
  });
});
