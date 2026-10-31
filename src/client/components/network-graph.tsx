import { useMemo, useRef, useState } from 'react';
import { ArrowRight, Building2, Focus, Minus, Plus, Search, TriangleAlert, X } from 'lucide-react';
import type { DashboardResponse, Incident, Order, Shipment } from '../../shared/types';
import type { ViewProps } from '../model';
import { Badge, Empty, formatTime, money, number, Panel } from './ui';
import { assessSupplyNetwork, supplySituationColors, supplySituationLabels, type SupplySituation } from '../../domain/supply-status';

type Health = SupplySituation;
const healthLabels = supplySituationLabels;
const healthColors = supplySituationColors;
const healthFills: Record<Health, string> = { broken: '#fff0f1', delayed: '#fff8dc', affected: '#e7f7ed', unaffected: '#edf1f4' };
type Node = { id: string; entityId: string; name: string; subtitle: string; kind: 'supplier' | 'warehouse' | 'customer'; column: number; x: number; y: number; health: Health; reasons: string[]; incidents: Incident[]; orders: Order[]; shipments: Shipment[]; fields: [string, string][] };

function buildNetwork(data: DashboardResponse) {
  const s = data.state;
  const tiers = [...new Set(s.suppliers.map(x => x.tier))].sort((a, b) => b - a);
  const nodes: Node[] = [];
  for (const supplier of s.suppliers) {
    const downstream = new Set([supplier.id]);
    let changed = true;
    while (changed) { changed = false; for (const edge of s.dependencies) if (downstream.has(edge.childId) && !downstream.has(edge.parentId)) { downstream.add(edge.parentId); changed = true; } }
    const shipments = s.shipments.filter(x => downstream.has(x.supplierId));
    const incidentEntities = new Set([...downstream, ...shipments.map(x => x.id)]);
    const incidents = s.incidents.filter(x => incidentEntities.has(x.entityId));
    const orderIds = new Set(incidents.flatMap(x => x.affectedOrderIds));
    const orders = s.orders.filter(x => orderIds.has(x.id) || shipments.some(ship => ship.warehouseId === x.warehouseId && ship.itemId === x.itemId));
    nodes.push({ id: `supplier:${supplier.id}`, entityId: supplier.id, name: supplier.name, subtitle: `${supplier.facility} · Partner ${supplier.orgId}`, kind: 'supplier', column: tiers.indexOf(supplier.tier), x: 0, y: 0, health: 'unaffected', reasons: [], incidents, orders, shipments, fields: [['Facility', supplier.facility], ['Partner organization', supplier.orgId], ['Components', supplier.components.join(', ') || 'Not recorded'], ['Sourcing eligibility', supplier.approved ? 'Approved' : 'Not approved'], ['Lead time', `${supplier.leadHours} hours`], ['Capacity', `${number(supplier.capacity)} units`], ['Unit cost', money(supplier.unitCostCents)]] });
  }
  for (const warehouse of s.warehouses) {
    const shipments = s.shipments.filter(x => x.warehouseId === warehouse.id);
    const orders = s.orders.filter(x => x.warehouseId === warehouse.id);
    const entities = new Set([warehouse.id, ...shipments.map(x => x.id), ...s.lots.filter(x => x.warehouseId === warehouse.id).flatMap(x => [x.id, x.itemId])]);
    const incidents = s.incidents.filter(x => entities.has(x.entityId));
    nodes.push({ id: `warehouse:${warehouse.id}`, entityId: warehouse.id, name: warehouse.name, subtitle: warehouse.region, kind: 'warehouse', column: tiers.length, x: 0, y: 0, health: 'unaffected', reasons: [], incidents, orders, shipments, fields: [['Region', warehouse.region], ['Operational status', warehouse.status], ['Receiving capacity', `${number(warehouse.capacity)} units`], ['Inventory lots', String(s.lots.filter(x => x.warehouseId === warehouse.id).length)]] });
  }
  for (const customer of new Set(s.orders.map(x => x.customer))) {
    const orders = s.orders.filter(x => x.customer === customer);
    const ids = new Set(orders.map(x => x.id));
    const incidents = s.incidents.filter(x => x.affectedOrderIds.some(id => ids.has(id)));
    nodes.push({ id: `customer:${customer}`, entityId: customer, name: customer, subtitle: `${orders.length} recorded order${orders.length === 1 ? '' : 's'}`, kind: 'customer', column: tiers.length + 1, x: 0, y: 0, health: 'unaffected', reasons: [], incidents, orders, shipments: [], fields: [['Recorded orders', String(orders.length)], ['Open orders', String(orders.filter(x => x.status !== 'fulfilled').length)], ['Fulfilled units', number(orders.reduce((sum, x) => sum + x.fulfilled, 0))]] });
  }
  const assessment = assessSupplyNetwork(s, data.impacts);
  for (const node of nodes) {
    const status = assessment.nodes[node.id];
    node.health = status?.situation || 'unaffected';
    node.reasons = status?.reasons || ['No current disruption recorded'];
    const rootEntities = new Set((status?.rootIds || []).map(x => x.slice(x.indexOf(':') + 1)));
    const linked = s.incidents.filter(x => rootEntities.has(x.entityId) && x.status !== 'resolved');
    node.incidents = [...new Map([...node.incidents, ...linked].map(x => [x.id, x])).values()];
    if (node.kind === 'supplier') {
      const supplier = s.suppliers.find(x => x.id === node.entityId)!;
      node.fields.unshift(['Supplier tier', String(supplier.tier)]);
      for (const c of supplier.commitments || []) node.fields.push([`${c.itemId} commitment`, `${c.confirmedQuantity} / ${c.expectedQuantity} confirmed - ${c.status}`], ['Commitment due', formatTime(c.dueAt) + ' UTC']);
    }
  }
  const columns = tiers.length + 2;
  let rows = 1;
  for (let column = 0; column < columns; column++) { const group = nodes.filter(x => x.column === column); rows = Math.max(rows, group.length); group.forEach((node, row) => { node.x = 30 + column * 285; node.y = 66 + row * 112; }); }
  const edges: { id: string; from: string; to: string; verified: boolean; label: string }[] = s.dependencies.map(x => ({ id: x.id, from: `supplier:${x.childId}`, to: `supplier:${x.parentId}`, verified: x.verified, label: `${x.itemId} · ${Math.round(x.confidence * 100)}% declared confidence` }));
  for (const ship of s.shipments) edges.push({ id: `ship:${ship.id}`, from: `supplier:${ship.supplierId}`, to: `warehouse:${ship.warehouseId}`, verified: true, label: `Shipment ${ship.id}` });
  for (const order of s.orders) edges.push({ id: `order:${order.id}`, from: `warehouse:${order.warehouseId}`, to: `customer:${order.customer}`, verified: true, label: `Order ${order.id}` });
  return { nodes, edges, cascades: assessment.cascades, width: Math.max(650, columns * 285), height: rows * 112 + 80, columns: [...tiers.map(x => `Tier ${x} suppliers`), 'Warehouses', 'Customers'] };
}

export function NetworkGraph(props: ViewProps & { expanded?: boolean }) {
  const { data, navigate, selectEntity, expanded } = props;
  const graph = useMemo(() => buildNetwork(data), [data]);
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const selected = graph.nodes.find(x => x.id === selectedId);
  const shown = graph.nodes.filter(x => `${x.name} ${x.entityId} ${x.subtitle}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || x.health === filter));
  const visible = new Set(shown.map(x => x.id));
  const positions = new Map(graph.nodes.map(x => [x.id, x]));
  const choose = (node?: Node) => { setSelectedId(node?.id); selectEntity?.(node?.entityId); };
  const zoom = (factor: number) => setView(v => ({ ...v, scale: Math.max(.4, Math.min(3, v.scale * factor)) }));
  return <Panel title="Your supply chain" eyebrow="DEPENDENCIES & OPERATIONAL HEALTH" className={`supply-map ${expanded ? 'expanded' : ''}`} action={<div className="graph-controls"><button className="icon-button" aria-label="Zoom out" onClick={() => zoom(.8)}><Minus size={16}/></button><span>{Math.round(view.scale * 100)}%</span><button className="icon-button" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={16}/></button><button className="icon-button" aria-label="Fit graph to view" onClick={() => setView({ scale: 1, x: 0, y: 0 })}><Focus size={17}/></button></div>}>
    {graph.cascades.length ? <div className="cascade-alert" role="alert"><TriangleAlert size={21}/><div><strong>{graph.cascades.every(x => x.verified) ? 'Cascading disruption is occurring' : 'Possible cascading disruption across declared links'}</strong>{graph.cascades.map((cascade, i) => <div key={`${cascade.rootId}-${cascade.itemId}-${i}`}><p>{cascade.rootName} affects {cascade.supplierIds.length} downstream suppliers and {cascade.orderIds.length} customer orders for {cascade.itemId}.</p><details><summary>Trace the affected paths</summary>{cascade.paths.map((path, j) => <p key={j}>{path.map(id => data.state.suppliers.find(x => x.id === id)?.name || data.state.warehouses.find(x => x.id === id)?.name || id).join(' -> ')}</p>)}</details></div>)}</div></div> : null}
    <div className="graph-toolbar"><label className="search-field"><Search size={15}/><input aria-label="Search supply chain entities" placeholder="Find a supplier, warehouse or customer…" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Filter entity health" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All health statuses</option>{Object.entries(healthLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span className="results-count">{shown.length} entities</span></div>
    <div className={`graph-workspace ${selected ? 'has-selection' : ''}`}>
      {graph.nodes.length ? <div className="graph-viewport"><svg role="img" aria-label="Interactive supply chain dependency graph" viewBox={`0 0 ${graph.width} ${graph.height}`} onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY > 0 ? .9 : 1.1); } }} onPointerDown={e => { if ((e.target as Element).closest('[data-node]')) return; drag.current = { x: e.clientX, y: e.clientY, startX: view.x, startY: view.y }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const d = drag.current; if (d) { const rect = e.currentTarget.getBoundingClientRect(); setView(v => ({ ...v, x: d.startX + (e.clientX - d.x) * graph.width / rect.width, y: d.startY + (e.clientY - d.y) * graph.height / rect.height })); } }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <defs><marker id={expanded ? 'network-arrow' : 'dashboard-arrow'} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {graph.columns.map((label, i) => <text key={label} x={30 + i * 285} y={28} className="graph-column-label">{label.toUpperCase()}</text>)}
          {graph.edges.map(edge => { const a = positions.get(edge.from), b = positions.get(edge.to); if (!a || !b || !visible.has(a.id) || !visible.has(b.id)) return null; return <path key={edge.id} d={`M ${a.x + 230} ${a.y + 36} C ${a.x + 260} ${a.y + 36}, ${b.x - 30} ${b.y + 36}, ${b.x} ${b.y + 36}`} fill="none" stroke={a.health !== 'unaffected' && b.health !== 'unaffected' ? healthColors[a.health === 'broken' || a.health === 'delayed' ? a.health : b.health] : '#c0cdd5'} strokeWidth="2" strokeDasharray={edge.verified ? undefined : '5 5'} markerEnd={`url(#${expanded ? 'network-arrow' : 'dashboard-arrow'})`}><title>{edge.label}{edge.verified ? '' : ' · Unverified relationship'}</title></path>; })}
          {shown.map(node => <g key={node.id} data-node={node.id} data-situation={node.health} role="button" tabIndex={0} aria-label={`${node.name}, ${healthLabels[node.health]}, show details`} onClick={() => choose(node)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(node); } }} className={`graph-node ${selectedId === node.id ? 'selected' : ''}`}>
            <title>{node.name} · {node.subtitle} · {node.reasons.join('; ')}</title><rect x={node.x} y={node.y} width="230" height="78" rx="12" fill={healthFills[node.health]} stroke={selectedId === node.id ? '#253e52' : healthColors[node.health]} strokeWidth={selectedId === node.id ? 2.5 : 1.4}/><rect x={node.x} y={node.y + 17} width="3" height="44" rx="2" fill={healthColors[node.health]}/><circle cx={node.x + 18} cy={node.y + 24} r="4" fill={healthColors[node.health]}/><text x={node.x + 30} y={node.y + 28} className="graph-node-name">{node.name.length > 25 ? `${node.name.slice(0, 24)}…` : node.name}</text><text x={node.x + 17} y={node.y + 47} className="graph-node-detail">{node.kind.toUpperCase()} · {healthLabels[node.health]}</text><text x={node.x + 17} y={node.y + 65} className="graph-node-sub">{node.subtitle.length > 34 ? `${node.subtitle.slice(0, 33)}…` : node.subtitle}</text>
          </g>)}
        </g>
      </svg>{!shown.length ? <div className="graph-no-results">No entities match these filters.</div> : null}<div className="graph-hint">Drag to explore · use + / − to zoom · select an entity for details</div></div> : <Empty title="Your supply chain will appear here" detail="Load your dataset in Data & Evidence, then deliver day 1 to see entities, relationships and health."><button className="button primary small" onClick={() => navigate('evidence')}>Open Data & Evidence <ArrowRight size={14}/></button></Empty>}
      {selected ? <aside className="entity-details" aria-label="Selected entity details"><div className="entity-detail-heading"><Building2 size={20}/><div><span className="eyebrow">{selected.kind}</span><h3>{selected.name}</h3></div><button className="icon-button" aria-label="Close entity details" onClick={() => choose()}><X size={16}/></button></div><span className={`health-pill health-${selected.health}`}>{healthLabels[selected.health]}</span><ul className="health-reasons">{selected.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul><dl className="entity-fields">{selected.fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><h4>Active incidents</h4>{selected.incidents.filter(x => x.status !== 'resolved').length ? selected.incidents.filter(x => x.status !== 'resolved').map(x => <button key={x.id} className="entity-incident" onClick={() => navigate('incidents', x.id)}><span>{x.title}</span><Badge value={x.status}/><ArrowRight size={14}/></button>) : <p className="muted">No linked active incidents recorded.</p>}<h4>Linked orders</h4>{selected.orders.map(x => <div key={x.id} className="entity-record"><strong>{x.customer} · {x.id}</strong><span>{number(x.fulfilled)} / {number(x.quantity)} units · {x.status}</span><small>Due {formatTime(x.deadline)} UTC</small></div>)}{!selected.orders.length ? <p className="muted">No linked orders recorded.</p> : null}<h4>Shipments</h4>{selected.shipments.map(x => <div key={x.id} className="entity-record"><strong>{x.id} · {x.status}</strong><span>{number(x.quantity)} units · ETA {formatTime(x.eta)} UTC</span></div>)}{!selected.shipments.length ? <p className="muted">No linked shipments recorded.</p> : null}<h4>Recovery</h4>{data.state.plans.filter(x => selected.incidents.some(i => i.id === x.incidentId)).map(x => <button key={x.id} className="entity-incident" onClick={() => navigate('recovery', x.incidentId)}><span>{x.type.replaceAll('_', ' ')} · {money(x.costCents)}</span><Badge value={x.status}/></button>)}<h4>Relationships</h4>{graph.edges.filter(x => x.from === selected.id || x.to === selected.id).map(x => <div key={x.id} className="entity-record"><strong>{positions.get(x.from)?.name} → {positions.get(x.to)?.name}</strong><small>{x.label} · {x.verified ? 'Recorded link' : 'Unverified declaration'}</small></div>)}<button className="button secondary small" onClick={() => navigate('evidence')}>Review source evidence <ArrowRight size={14}/></button></aside> : null}
    </div><div className="graph-legend">{Object.entries(healthLabels).map(([key, label]) => <span key={key}><i style={{ background: healthColors[key as Health] }}/>{label}</span>)}<span className="graph-boundary">Recorded relationships only · dashed links are unverified</span></div>
  </Panel>;
}
