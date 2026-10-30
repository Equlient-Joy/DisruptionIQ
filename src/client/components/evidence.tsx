import { Eye, FileCheck2, FileText, PlugZap, RotateCcw, ShieldAlert, Upload, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import type { ViewProps } from '../model';
import { Badge, Empty, formatTime, Panel, SectionHeading } from './ui';
import { AiActivityFeed } from './ai-activity';

function ChunkViewer({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  async function load(c = 0) {
    setLoading(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/chunks?cursor=${c}&limit=5`, {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        setChunks(data.items || []);
        setHasMore(data.hasMore);
        setCursor(c);
        setTotal(data.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="button secondary small"
        style={{ marginTop: '0.5rem' }}
        onClick={() => {
          setOpen(true);
          load(0);
        }}
      >
        <FileText size={14} /> View extracted chunks
      </button>
    );
  }

  return (
    <div className="chunks-container" style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-subtle)', borderRadius: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <strong>Extracted Chunks ({total} total)</strong>
        <button type="button" className="button text-button small" onClick={() => setOpen(false)}>Close</button>
      </div>
      {loading ? <p className="muted">Loading chunks…</p> : chunks.length === 0 ? <p className="muted">No chunks stored yet.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {chunks.map(chunk => (
            <div key={chunk.id} style={{ border: '1px solid var(--border-light)', borderRadius: '4px', padding: '0.5rem', fontSize: '0.82rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                <span>Chunk #{chunk.chunkIndex} (Page {chunk.pageNumber || 1})</span>
                <span>Chars {chunk.charStart}–{chunk.charEnd}</span>
              </div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: '120px', overflowY: 'auto' }}>{chunk.content}</pre>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
            <button type="button" className="button secondary small" disabled={cursor <= 0 || loading} onClick={() => load(Math.max(0, cursor - 5))}>Previous</button>
            <button type="button" className="button secondary small" disabled={!hasMore || loading} onClick={() => load(cursor + 5)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Evidence(props: ViewProps) {
  const { data, pending, execute, open } = props;
  const { state } = data;
  const [eventFilter, setEventFilter] = useState('all');
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const internal = data.actor.orgId === 'focal';
  const canIngest = internal && ['analyst', 'manager', 'warehouse', 'admin'].includes(data.actor.role);
  const canImport = internal && ['analyst', 'manager', 'admin'].includes(data.actor.role);
  const canControl = internal && ['manager', 'admin'].includes(data.actor.role);
  const canReview = internal && ['manager', 'warehouse', 'procurement', 'admin'].includes(data.actor.role);
  const anomalies = state.events.filter(event => ['invalid', 'conflict', 'stale'].includes(event.status));
  const events = [...state.events].reverse().filter(event => eventFilter === 'all' || event.status === eventFilter);

  const integrations = state.integrations || [];

  async function previewReplay(integrationId?: string) {
    try {
      const res = await fetch(integrationId ? `/api/integrations/${integrationId}/replay` : '/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preview: true }),
      });
      if (res.ok) {
        const json = await res.json();
        setPreviewResult(`Preview: ${json.replayed} queued events would be processed (${json.events?.filter((e: any) => e.status === 'accepted').length ?? 0} accepted, ${json.events?.filter((e: any) => e.status === 'duplicate').length ?? 0} duplicate, ${json.events?.filter((e: any) => e.status === 'stale').length ?? 0} stale). Real state was NOT mutated.`);
      }
    } catch {
      setPreviewResult('Preview check failed.');
    }
  }

  return <><SectionHeading title="Data & evidence" detail="Trust the inputs, preserve every claim, and make uncertainty visible.">{canImport ? <button className="button secondary" onClick={() => open({ type: 'import' })}><Upload size={16}/>Import CSV / JSON</button> : null}{canIngest ? <button className="button primary" onClick={() => open({ type: 'event' })}><PlugZap size={16}/>Capture event</button> : null}</SectionHeading>
    <div className={`continuity-banner ${state.integrationOutage ? 'outage' : ''}`}><span className="continuity-icon">{state.integrationOutage ? <WifiOff size={23}/> : <Wifi size={23}/>}</span><div><h2>{state.integrationOutage ? 'Integration outage is active' : 'Event integration is online'}</h2><p>{state.integrationOutage ? 'New operational updates are durably queued. Trusted state remains at its last reconciled version.' : 'Incoming claims are validated, deduplicated and reconciled before changing trusted records.'}</p><small>{state.queue.length} queued events · workspace version {state.version} · {data.database}</small></div>{canControl ? <div className="button-row"><button className="button secondary small" disabled={pending} onClick={() => execute({ path: '/outage', body: { enabled: !state.integrationOutage } }, state.integrationOutage ? 'Integration restored. Replay queued updates when ready.' : 'Integration outage enabled. New events will be queued.')}>{state.integrationOutage ? 'Restore integration' : 'Simulate outage'}</button><button className="button primary small" disabled={pending || state.integrationOutage || !state.queue.length} onClick={() => execute({ path: '/replay', body: {} }, 'Queued events replayed through current validation rules.')}><RotateCcw size={14}/>Replay queue</button></div> : null}</div>

    <Panel title="Integration connections & continuity health" eyebrow="PER-INTEGRATION RESILIENCE & QUEUES">
      <div className="integration-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
        {integrations.map(conn => {
          const backlog = state.queue.filter(e => {
            if (conn.kind === 'carrier') return e.type === 'shipment_eta' || e.type === 'shipment_status';
            if (conn.kind === 'warehouse') return e.type === 'stock_count' || e.type === 'warehouse_outage';
            if (conn.kind === 'supplier') return e.type === 'supplier_delay';
            return false;
          }).length;

          return (
            <article key={conn.id} className="integration-card" style={{ background: 'var(--bg-subtle)', padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <div>
                  <strong style={{ fontSize: '0.92rem', display: 'block' }}>{conn.name}</strong>
                  <small style={{ color: 'var(--text-muted)' }}>{conn.kind.toUpperCase()} · {conn.id}</small>
                </div>
                <Badge value={conn.status} />
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                <div>Backlog: <strong>{backlog}</strong> queued events</div>
                <div>Failures: <strong>{conn.failureCount}</strong> recorded</div>
                {conn.reason ? <div style={{ marginTop: '4px', fontStyle: 'italic' }}>{conn.reason}</div> : null}
              </div>
              {canControl ? (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    className="button secondary small"
                    disabled={pending}
                    onClick={() =>
                      execute(
                        { path: `/integrations/${conn.id}/health`, body: { status: conn.status === 'offline' ? 'online' : 'offline' } },
                        `${conn.name} status updated to ${conn.status === 'offline' ? 'online' : 'offline'}.`,
                      )
                    }
                  >
                    {conn.status === 'offline' ? 'Restore' : 'Pause'}
                  </button>
                  <button
                    className="button primary small"
                    disabled={pending || conn.status === 'offline' || backlog === 0}
                    onClick={() =>
                      execute(
                        { path: `/integrations/${conn.id}/replay`, body: {} },
                        `Replayed ${backlog} queued events for ${conn.name}.`,
                      )
                    }
                  >
                    <RotateCcw size={13} /> Replay
                  </button>
                  <button
                    className="button secondary small"
                    disabled={pending || backlog === 0}
                    onClick={() => previewReplay(conn.id)}
                    title="Simulate replay without committing mutations"
                  >
                    <Eye size={13} /> Preview
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {previewResult ? (
        <div style={{ marginTop: '12px', padding: '10px', background: 'var(--bg-subtle)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)', fontSize: '0.84rem' }}>
          <strong>Simulation Result:</strong> {previewResult}
        </div>
      ) : null}
    </Panel>

    <div className="mini-metrics"><div><FileCheck2 size={18}/><strong>{state.events.filter(event => event.status === 'accepted').length}</strong><span>accepted claims</span></div><div><ShieldAlert size={18}/><strong>{anomalies.length}</strong><span>trust anomalies</span></div><div><RotateCcw size={18}/><strong>{state.events.filter(event => event.status === 'duplicate').length}</strong><span>duplicates safely ignored</span></div><div><FileText size={18}/><strong>{state.documents.filter(document => document.status !== 'confirmed').length}</strong><span>documents to review</span></div></div>
    {state.queue.length ? <Panel title="Durable continuity queue" eyebrow="CAPTURE NOW · RECONCILE AFTER RESTORATION" action={canControl ? <button className="button secondary small" disabled={pending} onClick={() => previewReplay()}><Eye size={14}/>Preview all</button> : null}><div className="table-scroll"><table><thead><tr><th>Event</th><th>Source</th><th>Entity</th><th>Effective time · UTC</th><th>Status</th></tr></thead><tbody>{state.queue.map((event, i) => <tr key={`${event.id}-${i}`}><td><strong>{event.id}</strong><span className="table-sub">{event.type.replaceAll('_', ' ')}</span></td><td>{event.source}</td><td>{event.entityId}</td><td>{formatTime(event.time)}</td><td><Badge value="queued"/></td></tr>)}</tbody></table></div><div className="panel-foot">Replay retains original event time and identity. Old claims cannot silently replace newer facts.</div></Panel> : null}
    <Panel title="Semantic data health" eyebrow="OPERATIONAL CONSEQUENCES">{anomalies.length ? <div className="anomaly-grid">{anomalies.slice(-8).reverse().map((event, i) => <article key={`${event.id}-${i}`}><div><ShieldAlert size={17}/><Badge value={event.status}/></div><h3>{event.entityId}</h3><p>{event.message}</p><small>{event.id} · {event.source}</small><p className="anomaly-consequence">{event.status === 'conflict' ? 'Conflicting same-scope evidence is preserved for review. Disputed inventory cannot be treated as usable.' : event.status === 'stale' ? 'An older update was retained as evidence and cannot overwrite newer trusted state.' : 'This claim did not update trusted operational records; impact from rejected or unlinked data cannot be established.'}</p></article>)}</div> : <Empty title="No recorded trust anomalies" detail="Invalid, stale, and conflicting claims remain visible here when submitted. A clean journal does not establish that every external source is complete."/>}</Panel>
    <Panel title="Freight document review" eyebrow="EXTRACTED CLAIMS REQUIRE HUMAN REVIEW" action={canIngest ? <button className="button secondary small" onClick={() => open({ type: 'document' })}><Upload size={15}/>Upload document</button> : null}>{state.documents.length ? <div className="document-grid">{state.documents.map(document => <article className="document-card" key={document.id}><div className="document-heading"><span className="document-icon"><FileText size={22}/></span><div><h3>{document.filename}</h3><small>{document.source}{document.pageCount ? ` · ${document.pageCount} pages` : ''}{document.fileSizeBytes ? ` · ${(document.fileSizeBytes / 1024).toFixed(1)} KB` : ''} · {Math.round(document.confidence * 100)}% extraction confidence</small></div><Badge value={document.status}/></div>{document.status === 'processing' ? <p className="muted" style={{margin:'0.5rem 0'}}>Processing pages and extracting chunks asynchronously…</p> : document.status === 'failed' ? <p className="danger-text" style={{margin:'0.5rem 0'}}>{document.error || 'Document processing failed'}</p> : <><dl className="claim-fields"><div><dt>Shipment reference</dt><dd>{document.fields.shipmentId || 'Not extracted'}</dd></div><div><dt>Quantity</dt><dd>{document.fields.quantity ?? 'Not extracted'}</dd></div><div><dt>Date</dt><dd>{document.fields.date || 'Not extracted'}</dd></div></dl>{document.issues.length ? <ul className="document-issues">{document.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul> : <p className="muted">No extraction mismatch recorded.</p>}<details><summary>View document excerpt ({document.excerpt ? `${document.excerpt.length} chars` : 'none'})</summary><pre>{document.excerpt || document.text || 'No text was extracted. A scanned image needs manual review or a configured OCR service.'}</pre></details><ChunkViewer documentId={document.id}/></>}{document.status !== 'confirmed' && document.status !== 'processing' && document.status !== 'failed' && canReview ? <button className="button secondary small" disabled={pending} onClick={() => execute({ path: `/documents/${document.id}/confirm`, body: {} }, 'Document review confirmed and recorded in the decision trail.')}><FileCheck2 size={15}/>Confirm reviewed claim</button> : document.confirmedBy ? <p className="permission-note">Reviewed by {data.users.find(user => user.id === document.confirmedBy)?.name || document.confirmedBy}</p> : null}</article>)}</div> : <Empty title="No freight documents uploaded" detail="Upload a text PDF, TXT, CSV, or JSON document (up to 25 MB / 100 pages). Uncertain and unmatched fields remain claims until reviewed."/>}<div className="panel-foot">Review confirmation records acknowledgement of a claim. Document extraction does not silently overwrite inventory.</div></Panel>
    <Panel title="Event intake journal" eyebrow="APPEND-ONLY RAW EVIDENCE" action={<><label htmlFor="event-filter" className="sr-only">Filter event status</label><select id="event-filter" value={eventFilter} onChange={event => setEventFilter(event.target.value)}><option value="all">All event statuses</option>{['accepted', 'duplicate', 'invalid', 'conflict', 'stale', 'queued'].map(status => <option value={status} key={status}>{status}</option>)}</select></>}>{events.length ? <div className="table-scroll"><table><thead><tr><th>Event / source</th><th>Entity / type</th><th>Effective time · UTC</th><th>Received · UTC</th><th>Result</th><th>Claim</th></tr></thead><tbody>{events.map((event, i) => <tr key={`${event.id}-${event.receivedAt}-${i}`}><td><strong>{event.id}</strong><span className="table-sub">{event.source}</span></td><td>{event.entityId}<span className="table-sub">{event.type.replaceAll('_', ' ')}</span></td><td>{formatTime(event.time)}</td><td>{formatTime(event.receivedAt)}</td><td><Badge value={event.status}/><span className="table-sub journal-message">{event.message}</span></td><td><details><summary>Payload</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></td></tr>)}</tbody></table></div> : <Empty title="No events in this view" detail="Capture an event, submit a carrier webhook or import event records to begin an auditable intake journal."/>}</Panel>
  </>;
}

export function Collaboration({ data, execute, pending, navigate }: ViewProps) {
  const [filter, setFilter] = useState('open');
  const tasks = data.state.tasks.filter(task => filter === 'all' || task.status === filter);
  const openTasks = data.state.tasks.filter(task => task.status === 'open');
  const overdue = openTasks.filter(task => task.dueAt < data.state.clock);
  return <><SectionHeading title="Collaboration" detail="A shared incident, clear ownership, and the right organization boundary."/>
    <div className="mini-metrics"><div><FileCheck2 size={18}/><strong>{openTasks.length}</strong><span>open tasks</span></div><div><ShieldAlert size={18}/><strong>{overdue.length}</strong><span>past their due time</span></div><div><FileText size={18}/><strong>{data.state.tasks.filter(task => task.status === 'done').length}</strong><span>completed tasks</span></div><div><Wifi size={18}/><strong>{new Set(data.state.tasks.map(task => task.orgId)).size}</strong><span>participating organizations</span></div></div>
    <Panel title="Incident task board" eyebrow="COORDINATED RECOVERY" action={<><label htmlFor="task-filter" className="sr-only">Task status</label><select id="task-filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="open">Open tasks</option><option value="done">Completed tasks</option><option value="all">All tasks</option></select></>}>{tasks.length ? <div className="task-grid">{tasks.map(task => {
      const owner = data.users.find(user => user.id === task.ownerId);
      const canUpdate = task.orgId === data.actor.orgId && (data.actor.id === task.ownerId || (data.actor.orgId === 'focal' && ['manager', 'admin'].includes(data.actor.role)));
      const incident = data.state.incidents.find(candidate => candidate.id === task.incidentId);
      return <article className="task-card" key={task.id}><div><Badge value={task.status}/><span className="org-tag">{task.orgId}</span></div><h3>{task.title}</h3><button className="text-button" onClick={() => navigate('incidents', task.incidentId)}>{incident?.title || task.incidentId}</button><div className="task-owner"><span className="avatar small-avatar">{owner?.name.split(' ').map(word => word[0]).slice(0, 2).join('') || '?'}</span><div><strong>{owner?.name || task.ownerId}</strong><small>Due {formatTime(task.dueAt)} UTC</small></div></div>{task.status === 'open' && task.dueAt < data.state.clock ? <p className="danger-text permission-note">Past due in the synthetic scenario clock.</p> : null}{canUpdate ? <button className={`button ${task.status === 'open' ? 'primary' : 'secondary'} small`} disabled={pending} onClick={() => execute({ path: `/tasks/${task.id}`, body: { status: task.status === 'open' ? 'done' : 'open' } }, 'Task status updated for the incident team.')}>{task.status === 'open' ? 'Mark complete' : 'Reopen task'}</button> : <p className="permission-note">Only the assigned partner can update this task.</p>}</article>;
    })}</div> : <Empty title={filter === 'open' ? 'No open tasks' : 'No tasks in this view'} detail="Incident detection creates assigned tasks for operational and partner participants."/>}</Panel>
    <div className="insight-callout"><ShieldAlert size={20}/><div><strong>{data.actor.orgId === 'focal' ? 'Organization access is enforced by the server' : 'Your view is scoped to participating incidents'}</strong><p>Supplier participants receive permitted incident evidence and their assigned tasks. Internal orders, inventory, proposals and approval powers are restricted to the focal organization.</p></div></div>
  </>;
}

export function History({ data }: ViewProps) {
  const [search, setSearch] = useState('');
  const decisions = [...data.state.decisions].reverse().filter(decision => `${decision.action} ${decision.detail} ${decision.entityId}`.toLowerCase().includes(search.toLowerCase()));
  return <><SectionHeading title="Decision history" detail="Reconstruct the evidence, rules, reviewer, and outcome of every action."/>
    <Panel title="Autonomous Agent Execution Logs" eyebrow="INTELLIGENCE AUDIT TRAIL">
      <AiActivityFeed limit={6} />
    </Panel>
    <Panel title="Append-only audit trail" eyebrow={`${data.state.decisions.length} RECORDED DECISIONS`} action={<><label className="sr-only" htmlFor="audit-search">Search decision history</label><input id="audit-search" placeholder="Search actions or entities…" value={search} onChange={event => setSearch(event.target.value)}/></>}>{decisions.length ? <div className="audit-timeline">{decisions.map(decision => <article key={decision.id}><span className="audit-node"><FileCheck2 size={16}/></span><div className="audit-time">{formatTime(decision.at)}<small>UTC</small></div><div className="audit-content"><div className="audit-title"><h3>{decision.action.replaceAll('_', ' ')}</h3><code>{decision.entityId}</code></div><p>{decision.detail}</p><div className="audit-meta"><span>{data.users.find(user => user.id === decision.actorId)?.name || decision.actorId}</span><span>Rules: {decision.ruleVersion}</span>{decision.model ? <span>Model: {decision.model}</span> : null}</div><details><summary>Evidence & state change</summary><p><strong>Evidence:</strong> {decision.evidenceIds.join(' · ') || 'No linked evidence IDs'}</p><p><strong>Decision:</strong> {decision.id}</p><div className="snapshot-grid"><div><strong>Before</strong><pre>{decision.before !== undefined ? JSON.stringify(decision.before, null, 2) : 'No before snapshot recorded'}</pre></div><div><strong>After</strong><pre>{decision.after !== undefined ? JSON.stringify(decision.after, null, 2) : 'No after snapshot recorded'}</pre></div></div></details></div></article>)}</div> : <Empty title="No matching decisions" detail="Auditable changes will appear here after ingestion, planning, human review, and simulated execution."/>}</Panel>
  </>;
}
