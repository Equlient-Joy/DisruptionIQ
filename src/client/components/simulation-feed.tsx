import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Pause, Play, Upload } from 'lucide-react';
import type { SimulationDataset, SimulationProgress, AdvanceDayCommand, AdvanceDayResult } from '../../shared/simulation';
import type { ViewProps } from '../model';
import { ApiError, request } from '../api';
import { Badge, ErrorNotice, Panel, formatTime, number } from './ui';

interface SelectedDataset { content: string; filename: string; name: string; seed: string; start: string; end: string; days: number; rows: number }
export function SimulationFeed({data,pending}:Pick<ViewProps,'data'|'pending'>) {
  const client=useQueryClient();
  const [selected,setSelected]=useState<SelectedDataset>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string>();
  const [success,setSuccess]=useState<string>();
  const delivery=useRef<AdvanceDayCommand|undefined>(undefined);
  if(data.actor.orgId!=='focal') return null;
  const progress=data.state.simulation;
  const canControl=['manager','admin'].includes(data.actor.role);
  const saving=busy || pending;
  const receipt=progress?.receipts.at(-1);

  async function selectFile(file:File|undefined) {
    setError(undefined);setSuccess(undefined);setSelected(undefined);
    if(!file) return;
    setBusy(true);
    try {
      if(file.size>2*1024*1024) throw new Error('Choose a JSON dataset up to 2 MiB.');
      const content=await file.text();const value=JSON.parse(content) as SimulationDataset;
      if(value.schemaVersion!==1 || !value.name || !value.seed || !value.startDate || !Array.isArray(value.days) || !value.days.length || value.days.length>30) throw new Error('Choose a version 1 enterprise dataset with 1–30 days.');
      const rows=value.days.reduce((sum,day)=>sum+(day.events?.length ?? 0)+(day.documents?.length ?? 0)+Object.values(day.catalog ?? {}).reduce((count,items)=>count+(Array.isArray(items)?items.length:0),0),0);
      setSelected({content,filename:file.name,name:value.name,seed:value.seed,start:value.startDate,end:value.days.at(-1)!.date,days:value.days.length,rows});
    } catch(err) {setError(err instanceof Error?err.message:'Unable to read dataset.');}
    finally {setBusy(false);}
  }
  async function attach() {
    if(!selected) return;
    setBusy(true);setError(undefined);setSuccess(undefined);
    try {
      await request('/simulation/dataset',{content:selected.content});
      setSelected(undefined);setSuccess('Dataset attached. Start day 1 when ready; no operational records have been delivered.');
    } catch(err) {setError(err instanceof Error?err.message:'Dataset could not be attached.');}
    finally {await client.invalidateQueries({queryKey:['dashboard']});setBusy(false);}
  }
  async function control(action:'pause'|'resume') {
    if(!progress) return;
    setBusy(true);setError(undefined);setSuccess(undefined);
    try {
      await request('/simulation/control',{datasetHash:progress.datasetHash,action});
      setSuccess(action==='pause'?'Day delivery paused. You can continue reviewing and resolving issues.':'Controls resumed. Click Next day when ready.');
    } catch(err) {setError(err instanceof Error?err.message:'Control could not be updated.');}
    finally {await client.invalidateQueries({queryKey:['dashboard']});setBusy(false);}
  }
  async function advance() {
    if(!progress) return;
    const command=delivery.current ?? {datasetHash:progress.datasetHash,expectedDayIndex:progress.completedDays,requestId:crypto.randomUUID()};
    delivery.current=command;
    setBusy(true);setError(undefined);setSuccess(undefined);
    try {
      const result=await request<AdvanceDayResult>('/simulation/advance',command);
      delivery.current=undefined;setSuccess(`Day ${result.receipt.dayIndex+1} delivered. Review its evidence and resolve issues before advancing.`);
    } catch(err) {
      try {
        const {simulation}=await request<{simulation:SimulationProgress|null}>('/simulation');
        const saved=simulation?.receipts.find(item=>item.requestId===command.requestId && item.datasetHash===command.datasetHash);
        if(saved) {delivery.current=undefined;setSuccess(`Delivery confirmed from saved receipt for day ${saved.dayIndex+1}. No second batch was injected.`);}
        else {
          if(simulation?.datasetHash!==command.datasetHash || (simulation?.completedDays ?? 0)>command.expectedDayIndex || (err instanceof ApiError && err.status<500)) delivery.current=undefined;
          setError(err instanceof Error?err.message:'Delivery outcome is uncertain. Retry with the same request.');
        }
      } catch {setError('Unable to confirm delivery. Retry day delivery to recover its saved result safely.');}
    } finally {await client.invalidateQueries({queryKey:['dashboard']});setBusy(false);}
  }

  return <Panel className="simulation-feed" title="Enterprise simulation" eyebrow="EXPLICIT DAY DELIVERY" action={progress?<Badge value={progress.status} label={progress.status==='ready'?'Waiting for your next click':progress.status==='paused'?'Day delivery paused':'Simulation complete'}/>:null}>
    {!progress ? <>
      <p className="muted">No dataset attached. Choose an exported synthetic enterprise JSON file; records appear only after you deliver a day.</p>
      {canControl?<div className="simulation-loader"><label>Simulation dataset file<input type="file" accept=".json,application/json" disabled={saving} onChange={event=>void selectFile(event.target.files?.[0])}/></label>
        {selected?<div className="simulation-source"><strong>{selected.name}</strong><span>{selected.filename} · seed {selected.seed}</span><span>{selected.start} → {selected.end} UTC · {selected.days} days · {number(selected.rows)} source rows</span><p>Preview only. The server validates every record and relationship before attaching.</p></div>:null}
        <button className="button primary" disabled={saving || !selected} onClick={()=>void attach()}><Upload size={15}/>{saving?'Validating…':'Load simulation dataset'}</button></div>:<p className="permission-note">A Supply Chain Manager or Administrator can attach and control the dataset.</p>}
    </>:<>
      <div className="simulation-summary"><div><strong>{progress.name}</strong><span>Seed {progress.seed} · starts {progress.startDate} UTC</span><span className="simulation-clock">Simulation clock: {formatTime(data.state.clock)} UTC</span></div><strong className="simulation-progress">{progress.completedDays} / {progress.totalDays} days delivered</strong></div>
      <progress aria-label="Delivered simulation days" max={progress.totalDays} value={progress.completedDays}/>
      {progress.status==='complete'?<p>Simulation complete. Evidence, outstanding issues and confirmed recoveries remain available.</p>:<p>{progress.completedDays?'Review the current day before advancing. Outstanding issues carry forward.':'Day 1 has not arrived. Start it to ingest the opening enterprise records.'} {progress.status==='paused'?'Further delivery is paused.':'No data arrives automatically.'}</p>}
      {canControl && progress.status!=='complete'?<div className="button-row"><button className="button primary" disabled={saving || progress.status==='paused'} onClick={()=>void advance()}><ArrowRight size={16}/>{busy?'Delivering day…':delivery.current?'Retry day delivery':progress.completedDays?'Next day':'Start day 1'}</button><button className="button secondary" disabled={saving} onClick={()=>void control(progress.status==='paused'?'resume':'pause')}>{progress.status==='paused'?<Play size={15}/>:<Pause size={15}/>} {progress.status==='paused'?'Resume':'Pause'}</button></div>:null}
      <p className="form-help">Pause takes effect between days. A submitted day finishes as a complete batch. Reviewing and approving recoveries remains available.</p>
      <div className="simulation-live"><span>{data.state.incidents.filter(x=>x.status!=='resolved').length} open incidents</span><span>{data.impacts.length} affected orders</span><span>{data.state.incidents.filter(x=>x.status==='resolved').length} resolved incidents</span><span>{data.state.plans.filter(x=>x.status==='executed').length} confirmed recoveries</span><span>{data.state.queue.length} queued source events</span></div>
      {receipt?<div className="simulation-receipt"><h3>Delivered day {receipt.dayIndex+1} · {receipt.date} UTC</h3><div className="simulation-counts">{Object.entries(receipt.eventCounts).map(([status,count])=><span key={status}><strong>{number(count)}</strong> {status}</span>)}</div><p>{Object.values(receipt.catalogCounts).reduce((sum,n)=>sum+n,0)} new catalog records · {receipt.documents.length} document claims · {receipt.newIncidentIds.length} new incidents</p><p className="muted">Delivery snapshot: affected orders {receipt.before.affectedOrders} → {receipt.after.affectedOrders}; uncovered units {receipt.before.uncoveredUnits} → {receipt.after.uncoveredUnits}. Current outcomes are shown above.</p><details><summary>Delivery history</summary>{[...progress.receipts].reverse().map(item=><p key={item.requestId}>Day {item.dayIndex+1} · {item.date} UTC · recorded {formatTime(item.deliveredAt)} UTC · {Object.values(item.eventCounts).reduce((sum,n)=>sum+n,0)} source events</p>)}</details></div>:null}
    </>}
    {error?<ErrorNotice message={error}/>:null}{success?<p className="simulation-message" role="status">{success}</p>:null}
  </Panel>;
}
