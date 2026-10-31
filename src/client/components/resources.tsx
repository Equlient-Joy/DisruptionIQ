import { ArrowRight, Box, Clock3, ShieldCheck, Truck } from 'lucide-react';
import { useState } from 'react';
import type { Shipment } from '../../shared/types';
import type { ViewProps } from '../model';
import { Badge, Empty, formatTime, number, Panel, SectionHeading } from './ui';

export { Network } from './network-page';

function etaEvidence(shipment: Shipment, clock: string) {
  if (!shipment.etaHistory.length) return { label: 'Insufficient evidence', tone: 'review', detail: 'No ETA revision history is available. Stability and confidence cannot be assessed.' };
  const latest = shipment.etaHistory.at(-1)!;
  const age = (new Date(clock).getTime() - new Date(latest.at).getTime()) / 3_600_000;
  const etas = shipment.etaHistory.map(revision => new Date(revision.eta).getTime());
  const spread = (Math.max(...etas) - Math.min(...etas)) / 3_600_000;
  if (age > 24) return { label: 'Stale ETA evidence', tone: 'stale', detail: `Latest observed revision is ${Math.round(age)}h old. Confirm the carrier estimate before making commitments.` };
  if (shipment.etaHistory.length < 2) return { label: 'Limited ETA evidence', tone: 'review', detail: 'One revision is available; there is not enough history to measure volatility.' };
  return { label: spread > 6 ? 'Volatile ETA evidence' : 'Stable ETA evidence', tone: spread > 6 ? 'delayed' : 'available', detail: `${shipment.etaHistory.length} observations · ${Math.round(spread)}h revision spread · latest update ${Math.max(0, Math.round(age))}h ago. This is an evidence heuristic, not a delivery probability.` };
}

export function Inventory(props: ViewProps) {
  const { data, execute, pending } = props;
  const [tab, setTab] = useState('inventory');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const { warehouses } = data.state;
  const lots = data.state.lots.filter(x => `${x.name} ${x.id} ${x.itemId} ${x.warehouseId}`.toLowerCase().includes(search.toLowerCase()) && (status === 'all' || x.status === status));
  const shipments = data.state.shipments.filter(x => `${x.id} ${x.itemId} ${x.supplierId} ${data.state.suppliers.find(s => s.id === x.supplierId)?.name || ''}`.toLowerCase().includes(search.toLowerCase()) && (status === 'all' || x.status === status));
  const canDispose = data.actor.orgId === 'focal' && ['warehouse', 'admin'].includes(data.actor.role);
  const stock = data.state.lots.filter(lot => lot.status === 'available').reduce((total, lot) => total + Math.max(0, lot.quantity - lot.reserved), 0);
  const holds = data.state.lots.filter(lot => lot.status !== 'available');
  return <><SectionHeading title="Inventory & transport" detail="Usable inventory and ETA evidence determine what recovery can deliver."/>
    <div className="mini-metrics"><div><Box size={18}/><strong>{number(stock)}</strong><span>usable, unreserved units</span></div><div><ShieldCheck size={18}/><strong>{holds.length}</strong><span>lots held from allocation</span></div><div><Truck size={18}/><strong>{shipments.filter(shipment => shipment.status === 'delayed').length}</strong><span>delayed shipments</span></div></div>
    <div className="resource-toolbar"><div className="page-tabs" role="tablist" aria-label="Inventory and transport"><button role="tab" aria-selected={tab === 'inventory'} className={tab === 'inventory' ? 'active' : ''} onClick={() => { setTab('inventory'); setStatus('all'); }}>Inventory</button><button role="tab" aria-selected={tab === 'shipments'} className={tab === 'shipments' ? 'active' : ''} onClick={() => { setTab('shipments'); setStatus('all'); }}>Shipments</button></div><input aria-label="Search inventory or shipments" placeholder="Search item, location or reference..." value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="Inventory or shipment status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>{(tab === 'inventory' ? ['available', 'held', 'disputed'] : ['scheduled', 'in_transit', 'delayed', 'delivered']).map(x => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}</select></div>
    <div hidden={tab !== 'inventory'} className="resource-section"><Panel title="Lot inventory" eyebrow="QUALITY & COMMITMENTS">{lots.length ? <div className="table-scroll"><table><thead><tr><th>Lot / item</th><th>Warehouse</th><th>On hand</th><th>Reserved</th><th>Usable</th><th>Quality status</th><th>Disposition</th></tr></thead><tbody>{lots.map(lot => <tr key={lot.id}><td><strong>{lot.name}</strong><span className="table-sub">{lot.id} · {lot.itemId}</span></td><td>{warehouses.find(warehouse => warehouse.id === lot.warehouseId)?.name || lot.warehouseId}</td><td>{number(lot.quantity)}</td><td>{number(lot.reserved)}</td><td><strong>{lot.status === 'available' ? number(Math.max(0, lot.quantity - lot.reserved)) : '0'}</strong></td><td><Badge value={lot.status}/><span className="table-sub">inventory v{lot.version}</span></td><td>{canDispose ? <button className="button secondary small" disabled={pending} onClick={() => execute({ path: `/lots/${lot.id}/disposition`, body: { status: lot.status === 'available' ? 'held' : 'available' } }, 'Lot disposition recorded and recovery constraints recalculated.')}>{lot.status === 'available' ? 'Hold lot' : 'Release lot'}</button> : <span className="table-sub">Warehouse review required</span>}</td></tr>)}</tbody></table></div> : <Empty title="No inventory lots" detail="Import linked lot records to calculate usable inventory."/>}<div className="panel-foot"><ShieldCheck size={15}/>Held or disputed stock cannot fund a recovery allocation.</div></Panel>
    </div><div hidden={tab !== 'shipments'} className="resource-section"><Panel title="Shipments & ETA confidence" eyebrow="OBSERVATIONS, NOT ASSUMED CERTAINTY">{shipments.length ? <div className="shipment-list">{shipments.map(shipment => {
      const evidence = etaEvidence(shipment, data.state.clock);
      const supplier = data.state.suppliers.find(candidate => candidate.id === shipment.supplierId);
      return <article className="shipment-card" key={shipment.id}><div className="shipment-heading"><span className="shipment-icon"><Truck size={20}/></span><div><h3>{shipment.id}</h3><p>{supplier?.name || shipment.supplierId} <ArrowRight size={12}/> {warehouses.find(warehouse => warehouse.id === shipment.warehouseId)?.name || shipment.warehouseId}</p></div><Badge value={shipment.status}/></div><div className="shipment-stats"><div><span>Item / quantity</span><strong>{shipment.itemId} · {number(shipment.quantity)} units</strong></div><div><span>Baseline ETA · UTC</span><strong>{formatTime(shipment.baselineEta)}</strong></div><div><span>Latest ETA · UTC</span><strong>{formatTime(shipment.eta)}</strong></div><div><span>Evidence assessment</span><Badge value={evidence.tone} label={evidence.label}/></div></div><details className="eta-history"><summary><Clock3 size={15}/>ETA revision history <span>{shipment.etaHistory.length} observations</span></summary><p>{evidence.detail}</p>{shipment.etaHistory.length ? <div className="table-scroll"><table><thead><tr><th>Observed at · UTC</th><th>Predicted arrival · UTC</th><th>Source</th></tr></thead><tbody>{shipment.etaHistory.map((revision, i) => <tr key={i}><td>{formatTime(revision.at)}</td><td>{formatTime(revision.eta)}</td><td>{revision.source}</td></tr>)}</tbody></table></div> : null}</details></article>;
    })}</div> : <Empty title="No linked shipments" detail="Import shipments with valid supplier and warehouse references."/>}</Panel>
  </div></>;
}
