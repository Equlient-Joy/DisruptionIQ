import { useState, type FormEvent } from 'react';
import { CircleCheck, FileText, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import type { EventType } from '../../shared/types';
import type { Dialog, ViewProps } from '../model';
import { ErrorNotice, formatTime, Modal, money, number } from './ui';

type FormProps = ViewProps & { close: () => void; error?: string };
export function WorkflowDialog(props: FormProps & { dialog: Dialog }) {
  if (props.dialog.type === 'plan') return <PlanDialog {...props} dialog={props.dialog}/>;
  if (props.dialog.type === 'event') return <EventDialog {...props}/>;
  if (props.dialog.type === 'import') return <ImportDialog {...props}/>;
  if (props.dialog.type === 'document') return <DocumentDialog {...props}/>;
  return <ResetDialog {...props}/>;
}

function PlanDialog(props: FormProps & { dialog: Extract<Dialog, { type: 'plan' }> }) {
  const { dialog: { plan, action }, close, execute, pending, error, data } = props;
  const [quantity, setQuantity] = useState(plan.quantity);
  const [confirmed, setConfirmed] = useState(false);
  const [breakGlassReason, setBreakGlassReason] = useState('');
  const isHighRisk = plan.riskLevel === 'high';
  const isFirstApproval = isHighRisk && plan.status === 'proposed';

  const title = action === 'break_glass'
    ? 'Break-glass emergency execution'
    : action === 'approve'
      ? isFirstApproval
        ? 'Record first independent approval'
        : 'Confirm recovery execution'
      : action === 'modify'
        ? 'Modify recovery quantity'
        : 'Reject this proposal';

  async function submit(event: FormEvent) {
    event.preventDefault();
    let body: Record<string, unknown> = { action };
    let successMsg = 'Proposal rejected and the decision recorded.';

    if (action === 'break_glass') {
      body = { action: 'approve', breakGlass: true, breakGlassReason, confirmed: true };
      successMsg = 'Break-glass emergency execution recorded. Retrospective review scheduled.';
    } else if (action === 'approve') {
      body = { action: 'approve', confirmed };
      successMsg = isFirstApproval
        ? 'First independent approval recorded. Awaiting second approval.'
        : 'Recovery approved and simulated execution recorded.';
    } else if (action === 'modify') {
      body = { action: 'modify', quantity };
      successMsg = 'Proposal modified and revalidated. Previous approvals invalidated.';
    }

    const ok = await execute({ path: `/plans/${plan.id}`, body }, successMsg);
    if (ok) close();
  }

  return (
    <Modal title={title} detail={`${plan.orderId} · ${plan.type.replaceAll('_', ' ')} · proposal v${plan.version}`} onClose={close}>
      <form onSubmit={submit} className="modal-form">
        <div className="approval-summary">
          <div><span>Recovery quantity</span><strong>{number(plan.quantity)} units</strong></div>
          <div><span>Incremental cost</span><strong>{money(plan.costCents)}</strong></div>
          <div><span>Risk tier</span><strong>{(plan.riskLevel || 'routine').toUpperCase()}</strong></div>
          <div><span>Reviewer</span><strong>{data.actor.name} ({data.actor.role})</strong></div>
        </div>

        {action === 'break_glass' ? (
          <>
            <div className="insight-callout" style={{ borderColor: '#fca5a5', background: '#fef2f2', color: '#991b1b' }}>
              <ShieldAlert size={20} />
              <p>
                <strong>EMERGENCY BYPASS:</strong> Break-glass execution bypasses independent two-person review under administrator authority.
                A detailed justification of at least 20 characters is required and an auditable retrospective review flag will be attached.
              </p>
            </div>
            <label>
              Operational emergency justification (minimum 20 characters)
              <textarea
                minLength={20}
                required
                value={breakGlassReason}
                onChange={event => setBreakGlassReason(event.target.value)}
                rows={3}
                placeholder="Explain why independent second approval cannot be completed in time..."
              />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />
              <span>I confirm emergency single-administrator execution under break-glass protocol.</span>
            </label>
          </>
        ) : action === 'approve' ? (
          <>
            <div className="insight-callout">
              <ShieldCheck size={20} />
              <p>
                {isFirstApproval
                  ? 'This is a high-risk recovery proposal. Recording the first approval establishes intent only; no inventory or capacity will be allocated until a distinct second approver confirms execution.'
                  : 'The server rechecks permissions, current inventory, quality, capacity, and deadlines. Confirmation simulates the operational change and appends the evidence and outcome to the audit trail.'}
              </p>
            </div>
            <label className="checkbox-label">
              <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />
              <span>
                {isFirstApproval
                  ? 'I have reviewed the evidence and record the first independent approval.'
                  : 'I have reviewed the evidence and authorize this simulated recovery execution.'}
              </span>
            </label>
          </>
        ) : action === 'modify' ? (
          <>
            <label>
              New quantity (whole units)
              <input type="number" min="1" step="1" required value={quantity} onChange={event => setQuantity(Number(event.target.value))} />
            </label>
            <p className="form-help">The changed proposal becomes a new version; all prior approvals are cleared and constraints must pass before approval.</p>
          </>
        ) : (
          <p className="form-help">Rejecting closes this proposal without executing it. The original evidence and rejection remain in the audit trail.</p>
        )}

        {error ? <ErrorNotice message={error} /> : null}

        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>Cancel</button>
          <button
            type="submit"
            className={`button ${action === 'reject' || action === 'break_glass' ? 'danger' : 'primary'}`}
            disabled={
              pending ||
              (action === 'approve' && !confirmed) ||
              (action === 'break_glass' && (!confirmed || breakGlassReason.trim().length < 20))
            }
          >
            {action === 'approve' || action === 'break_glass' ? <CircleCheck size={16} /> : null}
            {pending
              ? 'Saving…'
              : action === 'break_glass'
                ? 'Execute break-glass'
                : action === 'approve'
                  ? isFirstApproval
                    ? 'Record 1st approval'
                    : 'Confirm & simulate execution'
                  : action === 'modify'
                    ? 'Save modified proposal'
                    : 'Reject proposal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const payloadExamples: Record<EventType, Record<string, unknown>> = {
  supplier_delay: { delayHours: 48 }, shipment_eta: { eta: '' }, stock_count: { quantity: 40, meaning: 'on_hand' },
  warehouse_outage: { status: 'outage' },
  shipment_status: { status: 'in_transit' },
};
function EventDialog({ data, execute, close, pending, error }: FormProps) {
  const [type, setType] = useState<EventType>('supplier_delay');
  const [id, setId] = useState(() => `manual-${crypto.randomUUID().slice(0, 8)}`);
  const [source, setSource] = useState('operator');
  const [entityId, setEntityId] = useState(data.state.suppliers[0]?.id || '');
  const [time, setTime] = useState(data.state.clock);
  const [payload, setPayload] = useState(JSON.stringify(payloadExamples.supplier_delay, null, 2));
  const [webhook, setWebhook] = useState(false);
  const [secret, setSecret] = useState('');
  const [localError, setLocalError] = useState('');
  const entities = type === 'supplier_delay' ? data.state.suppliers.map(item => ({ id: item.id, name: item.name })) : type === 'stock_count' ? data.state.lots.map(item => ({ id: item.id, name: item.name })) : type === 'warehouse_outage' ? data.state.warehouses.map(item => ({ id: item.id, name: item.name })) : data.state.shipments.map(item => ({ id: item.id, name: item.id }));
  function changeType(next: EventType) {
    setType(next);
    const nextPayload = next === 'shipment_eta' ? { eta: data.state.shipments[0]?.eta || data.state.clock } : payloadExamples[next];
    setPayload(JSON.stringify(nextPayload, null, 2));
    setEntityId(next === 'supplier_delay' ? data.state.suppliers[0]?.id || '' : next === 'warehouse_outage' ? data.state.warehouses[0]?.id || '' : next === 'stock_count' ? data.state.lots[0]?.id || '' : data.state.shipments[0]?.id || '');
    setLocalError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocalError('');
    let parsed: unknown;
    try { parsed = JSON.parse(payload); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { setLocalError('Payload must be a valid JSON object.'); return; }
    if (!Number.isFinite(Date.parse(time))) { setLocalError('Effective time must be a valid ISO timestamp.'); return; }
    const ok = await execute({ path: webhook ? '/webhooks/carrier' : '/events', body: { id, source, type, entityId, time, payload: parsed }, ...(webhook ? { headers: { 'x-webhook-secret': secret } } : {}) }, 'Event captured. Review the journal for its reconciliation result.');
    if (ok) close();
  }
  return <Modal title="Capture an operational event" detail="Preserve a source claim and let the server validate its operational effect." onClose={close}><form className="modal-form" onSubmit={submit}><div className="form-grid"><label>Event type<select value={type} onChange={event => changeType(event.target.value as EventType)}>{Object.keys(payloadExamples).map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label><label>Entity<select required value={entityId} onChange={event => setEntityId(event.target.value)}>{entities.length ? entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name} · {entity.id}</option>) : <option value="">No matching records</option>}</select></label><label>Event ID / idempotency key<input required value={id} onChange={event => setId(event.target.value)}/></label><label>Source<input required value={source} onChange={event => setSource(event.target.value)}/></label></div><label>Effective time · ISO UTC<input required value={time} onChange={event => setTime(event.target.value)}/></label><label>Payload · JSON<textarea className="code-input" rows={5} required value={payload} onChange={event => setPayload(event.target.value)} spellCheck={false}/></label><label className="checkbox-label"><input type="checkbox" checked={webhook} onChange={event => setWebhook(event.target.checked)}/><span>Submit through the simulated carrier webhook</span></label>{webhook ? <label>Carrier webhook secret<input type="password" required autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)}/><span className="form-help">Use the configured WEBHOOK_SECRET. Local demo default: local-carrier-demo.</span></label> : null}<p className="form-help">The sample payload is editable. Reusing an event ID safely tests duplicate handling. During an integration outage the claim is queued.</p>{localError || error ? <ErrorNotice message={localError || error!}/> : null}<div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary" disabled={pending || !entities.length}>{pending ? 'Submitting…' : webhook ? 'Submit carrier webhook' : 'Capture event'}</button></div></form></Modal>;
}

const templates: Record<string, string> = {
  suppliers: 'id,name,tier,facility,components,approved,leadHours,minOrder,capacity,unitCostCents,orgId\n',
  warehouses: 'id,name,region,capacity,status\n',
  lots: 'id,itemId,name,warehouseId,quantity,reserved,status,version\n',
  shipments: 'id,supplierId,warehouseId,itemId,quantity,status,eta,baselineEta,etaHistory,lotId\n',
  orders: 'id,customer,itemId,warehouseId,quantity,fulfilled,deadline,priority,penaltyCents,status\n',
  events: 'id,source,type,entityId,time,payload\n',
};

function ImportDialog({ execute, close, pending, error }: FormProps) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [entity, setEntity] = useState('events');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await execute({ path: '/import', body: { format, entity, content } }, 'Import processed. Review operational records and the event journal for results.');
    if (ok) close();
  }
  return <Modal title="Import operational records" detail="Load your CSV or JSON into the linked, persisted workspace." onClose={close}><form onSubmit={submit} className="modal-form"><div className="form-grid"><label>Record type<select value={entity} onChange={event => setEntity(event.target.value)}>{['events', 'suppliers', 'warehouses', 'lots', 'shipments', 'orders'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Format<select value={format} onChange={event => setFormat(event.target.value as 'csv' | 'json')}><option value="csv">CSV</option><option value="json">JSON</option></select></label></div><div style={{display:'flex',gap:'0.5rem',alignItems:'center',marginBottom:'0.5rem'}}><button type="button" className="button secondary small" onClick={() => { setFormat('csv'); setContent(templates[entity] || ''); }}>Insert {entity} CSV header</button><span className="form-help" style={{margin:0}}>Quickly populate header columns</span></div><label className="file-picker"><Upload size={22}/><strong>{filename || 'Choose a CSV or JSON file'}</strong><span>Or paste its contents below · maximum 2 MB</span><input type="file" accept=".csv,.json,text/csv,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setLocalError('Import files must be 2 MB or smaller.'); return; } setLocalError(''); setFilename(file.name); setFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'); setContent(await file.text()); }}/></label><label>File contents<textarea className="code-input" required rows={9} value={content} onChange={event => setContent(event.target.value)} placeholder={format === 'csv' ? 'CSV header row followed by records' : '[ { "id": "...", ... } ]'} spellCheck={false}/></label><p className="form-help">Use shared record field names. JSON is an array of records; CSV uses field-name headers. Structured fields such as arrays and event payloads use JSON within the field. References, quantities and timestamps are validated before commit.</p>{localError || error ? <ErrorNotice message={localError || error!}/> : null}<div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary" disabled={pending || !content.trim()}>{pending ? 'Importing…' : 'Validate & import'}</button></div></form></Modal>;
}

function DocumentDialog({ execute, close, pending, error }: FormProps) {
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState<File>();
  const [filename, setFilename] = useState('manifest.txt');
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    let body: unknown;
    if (mode === 'file') { if (!file) return; const form = new FormData(); form.append('file', file); body = form; } else body = { filename, text };
    if (await execute({ path: '/documents', body }, 'Document submitted for asynchronous ingestion and chunking.')) close();
  }
  return <Modal title="Add a freight document" detail="Extract shipment reference, quantity and date, then review the evidence." onClose={close}><form onSubmit={submit} className="modal-form"><div className="segmented"><button type="button" className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>Upload file</button><button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>Paste text</button></div>{mode === 'file' ? <label className="file-picker"><FileText size={28}/><strong>{file?.name || 'Choose a freight document'}</strong><span>Text PDF, TXT, CSV or JSON · maximum 25 MB</span><input type="file" required accept=".pdf,.txt,.csv,.json,application/pdf,text/plain,text/csv,application/json" onChange={event => { const next = event.target.files?.[0]; if (next && next.size > 26_214_400) { setLocalError('Document must be 25 MB or smaller.'); setFile(undefined); return; } setLocalError(''); setFile(next); }}/></label> : <><label>Source filename<input required value={filename} onChange={event => setFilename(event.target.value)}/></label><label>Source text<textarea rows={8} required value={text} onChange={event => setText(event.target.value)} placeholder={'Shipment: SH-001\nQuantity: 100\nDate: 2026-10-30'}/></label></>}<p className="form-help">Text PDFs and documents up to 25 MB / 100 pages are ingested asynchronously into page-aware chunks. Scanned images without extractable text remain manual-review claims.</p>{localError || error ? <ErrorNotice message={localError || error!}/> : null}<div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary" disabled={pending || mode === 'file' && !file}><Upload size={15}/>{pending ? 'Uploading…' : 'Upload & ingest'}</button></div></form></Modal>;
}

function ResetDialog({ execute, close, pending, error }: FormProps) {
  const [confirmed, setConfirmed] = useState(false);
  return <Modal title="Clear operational workspace" detail="Administrator action · clears operational records while preserving audit trail" onClose={close}><form className="modal-form" onSubmit={async event => { event.preventDefault(); if (confirmed && await execute({ path: '/reset', body: {} }, 'Operational workspace cleared.')) close(); }}><p>This clears current operational records (suppliers, warehouses, inventory, shipments, orders, incidents, events, recovery plans, and documents). An auditable workspace-cleared decision is appended to the audit trail.</p><label className="checkbox-label"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>I confirm clearing all operational data from the workspace.</span></label>{error ? <ErrorNotice message={error}/> : null}<div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button danger" disabled={pending || !confirmed}>{pending ? 'Clearing…' : 'Clear workspace'}</button></div></form></Modal>;
}
