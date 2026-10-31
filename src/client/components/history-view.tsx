import { useState } from 'react';
import { ArrowRight, Download, FileCheck2, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Decision } from '../../shared/types';
import type { ViewProps } from '../model';
import { Empty, formatTime, Panel, SectionHeading } from './ui';

const categories = ['Incident', 'Decision', 'Recovery', 'Evidence', 'Other'] as const;
type Category = typeof categories[number];
export function auditCategory(action: string): Category {
  if (action.startsWith('incident_')) return 'Incident';
  if (/^plan_(approved|rejected|modified|approval|first_approval|break_glass)/.test(action) || action === 'ai_summary') return 'Decision';
  if (action.startsWith('plan_') || /recovery|order_fulfilled/.test(action)) return 'Recovery';
  if (/^(event_|document_|stock_|shipment_|lot_|import_|simulation_|lifecycle_|supplier_commitment_)/.test(action)) return 'Evidence';
  return 'Other';
}
export function filterAudit(decisions: Decision[], filters: { search: string; category: string; entity: string; actor: string; from: string; to: string }) {
  return [...decisions].filter(x => {
    const day = x.at.slice(0, 10);
    return (!filters.search || `${x.action} ${x.detail} ${x.entityId} ${x.id} ${x.actorId} ${x.evidenceIds.join(' ')}`.toLowerCase().includes(filters.search.toLowerCase())) && (filters.category === 'all' || auditCategory(x.action) === filters.category) && (filters.entity === 'all' || x.entityId === filters.entity) && (filters.actor === 'all' || x.actorId === filters.actor) && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
  }).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}
const initialFilters = { search: '', category: 'all', entity: 'all', actor: 'all', from: '', to: '' };
function escapeHtml(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function downloadAudit(props: ViewProps, records: Decision[], format: 'html' | 'json', filtered: boolean) {
  const exportedAt = new Date().toISOString();
  const actorName = (id: string) => props.data.users.find(x => x.id === id)?.name || id;
  const envelope = { exportedAt, scope: filtered ? 'filtered operational audit' : 'complete permitted operational audit', recordCount: records.length, workspaceVersion: props.data.state.version, workspaceClock: props.data.state.clock, exportedBy: props.data.actor.name, records };
  const content = format === 'json' ? JSON.stringify(envelope, null, 2) : `<!doctype html><html><head><meta charset="utf-8"><title>DisruptionIQ operational audit</title><style>body{font:14px system-ui;color:#172d3b;max-width:1050px;margin:40px auto;padding:0 24px}h1{font-size:30px}article{border-top:1px solid #ccd7df;padding:22px 0;break-inside:avoid}small{color:#64748b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f9;padding:16px;font-size:11px}dt{font-weight:700}dd{margin:0 0 10px}button{padding:10px 16px;cursor:pointer}@media print{button{display:none}body{margin:0;max-width:none}}</style></head><body><h1>DisruptionIQ · Operational audit</h1><p>${escapeHtml(envelope.scope)} · ${records.length} records</p><p>Exported ${escapeHtml(exportedAt)} by ${escapeHtml(envelope.exportedBy)}<br>Workspace v${envelope.workspaceVersion} · ${escapeHtml(envelope.workspaceClock)} UTC</p><p>Separate AI execution logs are excluded. Model metadata recorded in operational decisions is retained.</p><button onclick="window.print()">Print / Save as PDF</button>${records.map(x => `<article><small>${escapeHtml(x.at)} · UTC · ${escapeHtml(auditCategory(x.action))}</small><h2>${escapeHtml(x.action.replaceAll('_', ' '))}</h2><p>${escapeHtml(x.detail)}</p><dl><dt>Record / entity</dt><dd>${escapeHtml(x.id)} / ${escapeHtml(x.entityId)}</dd><dt>Actor</dt><dd>${escapeHtml(actorName(x.actorId))} (${escapeHtml(x.actorId)})</dd><dt>Rules / model</dt><dd>${escapeHtml(x.ruleVersion)}${x.model ? ' / ' + escapeHtml(x.model) : ''}</dd><dt>Evidence</dt><dd>${escapeHtml(x.evidenceIds.join(', ') || 'No linked evidence')}</dd></dl><h3>Before</h3><pre>${escapeHtml(x.before === undefined ? 'No snapshot recorded' : JSON.stringify(x.before, null, 2))}</pre><h3>After</h3><pre>${escapeHtml(x.after === undefined ? 'No snapshot recorded' : JSON.stringify(x.after, null, 2))}</pre></article>`).join('')}</body></html>`;
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `disruptioniq-audit-${filtered ? 'filtered-' : ''}${exportedAt.slice(0, 10)}.${format}`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ActivityPanel(props: ViewProps) {
  const [filters, setFilters] = useState(initialFilters);
  const records = filterAudit(props.data.state.decisions, filters);
  return <Panel title="Recent activity" eyebrow="WHAT CHANGED & WHY" action={<button className="text-button" onClick={() => props.navigate('history')}>Full history <ArrowRight size={14}/></button>}>
    <div className="filter-bar"><label className="search-field"><Search size={15}/><input aria-label="Search dashboard activity" placeholder="Search activity…" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })}/></label><select aria-label="Activity category" value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}><option value="all">All activity</option>{categories.map(x => <option key={x}>{x}</option>)}</select><select aria-label="Activity entity" value={filters.entity} onChange={e => setFilters({ ...filters, entity: e.target.value })}><option value="all">All entities</option>{[...new Set(props.data.state.decisions.map(x => x.entityId))].sort().map(x => <option key={x}>{x}</option>)}</select><label className="date-filter">From<input type="date" aria-label="Activity from date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })}/></label><label className="date-filter">To<input type="date" aria-label="Activity to date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })}/></label></div>
    {records.length ? <div className="activity-list">{records.slice(0, 8).map(x => <button key={x.id} className="activity-row" onClick={() => props.navigate('history')}><span className={`activity-dot category-${auditCategory(x.action).toLowerCase()}`}/><div><strong>{x.action.replaceAll('_', ' ')}</strong><p>{x.detail}</p><small>{x.entityId} · {formatTime(x.at)} UTC</small></div><ArrowRight size={15}/></button>)}</div> : <Empty title="No activity in this view" detail="Delivered data and subsequent decisions will appear here."/>}
  </Panel>;
}

export function History(props: ViewProps) {
  const { data } = props;
  const [filters, setFilters] = useState(initialFilters);
  const [selectedId, setSelectedId] = useState<string>();
  const [limit, setLimit] = useState(40);
  const [exportOpen, setExportOpen] = useState(false);
  const [verification, setVerification] = useState<{ intact?: boolean; verifiedCount?: number; error?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const records = filterAudit(data.state.decisions, filters);
  const selected = records.find(x => x.id === selectedId);
  const all = filterAudit(data.state.decisions, initialFilters);
  const start = records.length ? Math.min(...records.map(x => Date.parse(x.at))) : 0;
  const end = records.length ? Math.max(...records.map(x => Date.parse(x.at))) : 0;
  const update = (key: keyof typeof initialFilters, value: string) => { setFilters(f => ({ ...f, [key]: value })); setLimit(40); };
  const exportRecords = (format: 'html' | 'json', filtered: boolean) => { downloadAudit(props, filtered ? records : all, format, filtered); setExportOpen(false); };

  async function handleVerify() {
    setVerifying(true);
    try {
      const res = await fetch('/api/audit/verify', { credentials: 'same-origin' });
      const json = await res.json();
      setVerification(json);
    } catch (err: any) {
      setVerification({ intact: false, error: err?.message || 'Verification request failed' });
    } finally {
      setVerifying(false);
    }
  }

  return <><SectionHeading title="History" detail="See the sequence. Understand each decision. Keep the evidence."><div className="export-control" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>{verification ? (<span className={`badge ${verification.intact ? 'pass' : 'fail'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '6px 10px', borderRadius: '6px', fontSize: '0.82rem', background: verification.intact ? '#ecfdf5' : '#fef2f2', color: verification.intact ? '#047857' : '#b91c1c', border: `1px solid ${verification.intact ? '#a7f3d0' : '#fecaca'}` }}>{verification.intact ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>}{verification.intact ? `Chain Intact (${verification.verifiedCount} verified)` : `Compromised: ${verification.error}`}</span>) : null}<button type="button" className="button secondary" onClick={handleVerify} disabled={verifying}><ShieldCheck size={15}/>{verifying ? 'Verifying…' : 'Verify chain'}</button><button className="button primary" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}><Download size={16}/>Export audit</button>{exportOpen ? <div className="export-menu"><strong>Complete operational audit · {all.length}</strong><button onClick={() => exportRecords('html', false)}>Download printable report</button><button onClick={() => exportRecords('json', false)}>Download complete JSON</button><hr/><strong>Current filtered view · {records.length}</strong><button onClick={() => exportRecords('html', true)}>Download filtered report</button><button onClick={() => exportRecords('json', true)}>Download filtered JSON</button></div> : null}</div></SectionHeading>
    <div className="filter-bar history-filters"><label className="search-field"><Search size={16}/><input aria-label="Search decision history" placeholder="Search actions, details or evidence…" value={filters.search} onChange={e => update('search', e.target.value)}/></label><select aria-label="History category" value={filters.category} onChange={e => update('category', e.target.value)}><option value="all">All categories</option>{categories.map(x => <option key={x}>{x}</option>)}</select><select aria-label="History entity" value={filters.entity} onChange={e => update('entity', e.target.value)}><option value="all">All entities</option>{[...new Set(data.state.decisions.map(x => x.entityId))].sort().map(x => <option key={x}>{x}</option>)}</select><select aria-label="History actor" value={filters.actor} onChange={e => update('actor', e.target.value)}><option value="all">All actors</option>{[...new Set(data.state.decisions.map(x => x.actorId))].sort().map(x => <option key={x} value={x}>{data.users.find(u => u.id === x)?.name || x}</option>)}</select><label className="date-filter">From<input type="date" aria-label="History from date" value={filters.from} onChange={e => update('from', e.target.value)}/></label><label className="date-filter">To<input type="date" aria-label="History to date" value={filters.to} onChange={e => update('to', e.target.value)}/></label><button className="text-button" onClick={() => { setFilters(initialFilters); setLimit(40); }}>Clear filters</button></div>
    <Panel title="Sequence of events" eyebrow={`${records.length} MATCHING RECORDS · UTC`} className="sequence-panel">
      {records.length ? <div className="sequence-scroll"><div className="sequence-chart"><div className="sequence-axis"><span>{formatTime(new Date(start).toISOString())}</span><span>{formatTime(new Date(end).toISOString())}</span></div>{categories.filter(category => records.some(x => auditCategory(x.action) === category)).map(category => <SequenceLane key={category} category={category} records={records} start={start} end={end} selectedId={selectedId} onSelect={x => { setSelectedId(x.id); props.selectEntity?.(x.entityId); }}/>) }<div className="sequence-hint">Select an event to inspect its evidence. Numbered markers group records at the same time.</div></div></div> : <Empty title="No recorded events in this view" detail="Change the filters or deliver data to begin the audit timeline."/>}
    </Panel>
    {selected ? <Panel title={selected.action.replaceAll('_', ' ')} eyebrow={`SELECTED EVENT · ${selected.id}`} action={<button className="text-button" onClick={() => { setSelectedId(undefined); props.selectEntity?.(); }}>Close details</button>}><AuditDetail decision={selected} props={props}/><div className="timestamp-records">{records.filter(x => x.at === selected.at && auditCategory(x.action) === auditCategory(selected.action)).length > 1 ? <><strong>Other records at this timestamp</strong>{records.filter(x => x.at === selected.at && auditCategory(x.action) === auditCategory(selected.action)).map(x => <button key={x.id} className="text-button" onClick={() => { setSelectedId(x.id); props.selectEntity?.(x.entityId); }}>{x.action.replaceAll('_', ' ')} / {x.entityId}</button>)}</> : null}</div></Panel> : null}
    <Panel title="Operational audit trail" eyebrow={`${records.length} RECORDS · NEWEST FIRST`}>
      {records.length ? <div className="history-list">{records.slice(0, limit).map(x => <article className={`history-record ${selectedId === x.id ? 'selected' : ''}`} key={x.id}><div className="history-record-icon"><FileCheck2 size={17}/></div><div className="history-record-body"><div className="history-record-top"><span className={`audit-category category-text-${auditCategory(x.action).toLowerCase()}`}>{auditCategory(x.action)}</span><small>{formatTime(x.at)} UTC</small></div><h3>{x.action.replaceAll('_', ' ')}</h3><p>{x.detail}</p><div className="history-meta"><span>{data.users.find(u => u.id === x.actorId)?.name || x.actorId}</span><code>{x.entityId}</code><button className="text-button" onClick={() => { setSelectedId(selectedId === x.id ? undefined : x.id); props.selectEntity?.(selectedId === x.id ? undefined : x.entityId); }}>Inspect record <ArrowRight size={13}/></button></div><details><summary>Evidence & state change</summary><AuditDetail decision={x} props={props}/></details></div></article>)}</div> : <Empty title="No matching history" detail="Try broader filters. No placeholder records are displayed."/>}{records.length > limit ? <div className="panel-foot"><button className="button secondary small" onClick={() => setLimit(limit + 40)}>Show more ({records.length - limit} remaining)</button></div> : null}
    </Panel>
  </>;
}

function AuditDetail({ decision: x, props }: { decision: Decision; props: ViewProps }) {
  return <div className="audit-detail"><p>{x.detail}</p><div className="history-meta"><span>{x.at} UTC</span><span>{props.data.users.find(u => u.id === x.actorId)?.name || x.actorId}</span><span>Rules: {x.ruleVersion}</span>{x.model ? <span>Model: {x.model}</span> : null}</div><p><strong>Entity:</strong> {x.entityId} · <strong>Evidence:</strong> {x.evidenceIds.join(' · ') || 'No linked evidence IDs'}</p><code>{x.id}</code>{x.hash ? <div className="hash-chain-info" style={{ margin: '8px 0', padding: '6px 10px', background: 'var(--bg-subtle)', borderRadius: '6px', fontSize: '0.74rem', fontFamily: 'monospace', wordBreak: 'break-all' }}><div><strong>Previous Hash:</strong> {x.previousHash || 'GENESIS'}</div><div><strong>SHA-256 Hash:</strong> {x.hash}</div></div> : null}<div className="snapshot-grid"><div><strong>Before</strong><pre>{x.before !== undefined ? JSON.stringify(x.before, null, 2) : 'No before snapshot recorded'}</pre></div><div><strong>After</strong><pre>{x.after !== undefined ? JSON.stringify(x.after, null, 2) : 'No after snapshot recorded'}</pre></div></div></div>;
}

function SequenceLane({ category, records, start, end, selectedId, onSelect }: { category: Category; records: Decision[]; start: number; end: number; selectedId?: string; onSelect: (record: Decision) => void }) {
  const groups = new Map<string, Decision[]>();
  for (const record of records) { if (auditCategory(record.action) !== category) continue; const group = groups.get(record.at) || []; group.push(record); groups.set(record.at, group); }
  return <div className="sequence-lane"><span className={`lane-label category-text-${category.toLowerCase()}`}>{category}</span><div className="sequence-track" style={{ height: 44 }}>{[...groups].map(([at, group]) => <button key={at} className={`sequence-event category-${category.toLowerCase()} ${group.some(x => x.id === selectedId) ? 'selected' : ''}`} style={{ left: `${end === start ? 50 : 3 + (Date.parse(at) - start) / (end - start) * 94}%`, top: 12, width: group.length > 1 ? 25 : 11, height: group.length > 1 ? 20 : 11 }} title={`${group.length} ${category.toLowerCase()} record${group.length === 1 ? '' : 's'} · ${at}`} aria-label={`Show ${group.length} ${category.toLowerCase()} audit records at ${at}`} onClick={() => onSelect(group[0]!)}>{group.length > 1 ? group.length : null}</button>)}</div></div>;
}
