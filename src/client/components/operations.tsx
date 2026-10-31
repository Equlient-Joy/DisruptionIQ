import { Activity, ArrowRight, ArrowUpRight, Box, Check, ChevronRight, Clock3, GitBranch, Layers3, ListChecks, ShieldAlert, ShieldCheck, Sparkles, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Impact, Incident, RecoveryPlan } from '../../shared/types';
import type { ViewProps } from '../model';
import { Badge, Empty, formatTime, money, number, Panel, SectionHeading } from './ui';


const planNames = { reallocate: 'Reallocate inventory', expedite: 'Expedite shipment', alternative_supplier: 'Alternative supplier', split_order: 'Split customer order' };
const planIcons = { reallocate: Box, expedite: Zap, alternative_supplier: GitBranch, split_order: Layers3 };

export function RiskTable({ data, navigate, impacts = data.impacts }: Pick<ViewProps, 'data' | 'navigate'> & { impacts?: Impact[] }) {
  if (!impacts.length) return <Empty title="No exposed customer orders" detail="New disruptions will appear here with their shortage and risk factors."/>;
  const orders = new Map(data.state.orders.map(order => [order.id, order]));
  const sorted = [...impacts].sort((a, b) => b.score - a.score);
  return <div className="table-scroll"><table><thead><tr><th>Customer order</th><th>Priority</th><th>Shortage</th><th>Deadline · UTC</th><th>Risk score</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{sorted.map(impact => {
    const order = orders.get(impact.orderId);
    if (!order) return null;
    return <tr key={impact.orderId}>
      <td>
        <strong>{order.customer}</strong>
        <span className="table-sub">{order.id} · {order.itemId}</span>
        <details className="risk-factors">
          <summary>Why this order is at risk</summary>
          <ul>{impact.factors.map((factor, i) => <li key={i}>{factor}</li>)}</ul>
          {impact.factorScores ? (
            <div className="factor-breakdown" style={{ marginTop: '6px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <div>Uncovered demand: <strong>{impact.factorScores.uncoveredDemand.score.toFixed(1)}</strong></div>
              <div>Deadline pressure: <strong>{impact.factorScores.deadlinePressure.score.toFixed(1)}</strong></div>
              <div>Recovery feasibility: <strong>{impact.factorScores.recoveryFeasibility.score.toFixed(1)}</strong></div>
              <div>Cascading exposure: <strong>{impact.factorScores.cascadingExposure.score.toFixed(1)}</strong></div>
              <div>Business consequence: <strong>{impact.factorScores.businessConsequence.score.toFixed(1)}</strong></div>
            </div>
          ) : null}
          {impact.confidenceReasons?.length ? (
            <ul className="confidence-reasons" style={{ marginTop: '6px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {impact.confidenceReasons.map((reason, i) => <li key={i}>{reason}</li>)}
            </ul>
          ) : null}
          <div className="path-list">{impact.paths.map((path, i) => <span key={i}>{path}</span>)}</div>
        </details>
      </td>
      <td><Badge value={order.priority}/></td>
      <td><strong>{number(impact.shortage)}</strong><span className="table-sub">of {number(order.quantity)} units</span></td>
      <td>{formatTime(order.deadline)}<span className={`table-sub ${impact.hoursRemaining < 12 ? 'danger-text' : ''}`}>{impact.hoursRemaining <= 0 ? 'Deadline passed' : `${Math.round(impact.hoursRemaining)}h remaining`}</span></td>
      <td>
        <div className="score">
          <strong>{impact.score.toFixed(1)} / 10</strong>
          <div className="score-track"><span style={{ width: `${Math.min(100, (impact.score / 10) * 100)}%` }}/></div>
        </div>
        <div className="score-meta" style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
          <Badge value={impact.band || 'low'} label={`${impact.band || 'low'} risk`} />
          <Badge value={impact.confidence || 'high'} label={`${impact.confidence || 'high'} conf`} />
        </div>
        {impact.drivers?.length ? (
          <div className="driver-list" style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
            {impact.drivers.map((driver, i) => (
              <span key={i} className="driver-tag" style={{ fontSize: '0.72rem', background: 'var(--bg-subtle)', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--border-light)' }}>
                {driver}
              </span>
            ))}
          </div>
        ) : null}
      </td>
      <td><button className="icon-button" aria-label={`View incident for ${order.id}`} onClick={() => navigate('incidents', impact.incidentIds[0])}><ArrowUpRight size={18}/></button></td>
    </tr>;
  })}</tbody></table></div>;
}

function IncidentRow({ incident, onClick, state }: { incident: Incident; onClick: () => void; state?: 'selected' }) {
  return <button className={`incident-row ${state || ''}`} onClick={onClick}><span className={`incident-symbol ${incident.status}`}><TriangleAlert size={18}/></span><div><strong>{incident.title}</strong><span>{incident.affectedOrderIds.length} affected orders · {incident.alertCount} correlated alerts</span><small>{incident.id} · {formatTime(incident.createdAt)} UTC</small></div><ChevronRight size={17}/></button>;
}

function PlanCard({ plan, props }: { plan: RecoveryPlan; props: ViewProps }) {
  const { data, pending, open } = props;
  const Icon = planIcons[plan.type];
  const source = data.state.suppliers.find(item => item.id === plan.sourceId)?.name || data.state.warehouses.find(item => item.id === plan.sourceId)?.name || data.state.lots.find(item => item.id === plan.sourceId)?.name || plan.sourceId;
  const proposer = data.users.find(user => user.id === plan.createdBy)?.name || plan.createdBy;
  const own = plan.createdBy === data.actor.id || (plan.lastModifiedBy !== undefined && plan.lastModifiedBy === data.actor.id);
  const roleAllowsApproval = data.actor.orgId === 'focal' && (plan.type === 'alternative_supplier' ? ['procurement', 'admin'].includes(data.actor.role) : ['manager', 'admin'].includes(data.actor.role));
  const canPropose = ['analyst', 'manager', 'procurement', 'admin'].includes(data.actor.role) && data.actor.orgId === 'focal';
  const isAdmin = data.actor.orgId === 'focal' && data.actor.role === 'admin';
  const isHighRisk = plan.riskLevel === 'high';
  const validApprovals = (plan.approvals || []).filter(a => a.version === plan.version);
  const alreadyApprovedByMe = validApprovals.some(a => a.approverId === data.actor.id);
  const firstApprover = validApprovals[0] ? data.users.find(u => u.id === validApprovals[0].approverId)?.name || validApprovals[0].approverId : undefined;

  return (
    <article className={`plan-card ${plan.feasible ? '' : 'infeasible'}`}>
      <div className="plan-card-top">
        <span className="plan-icon"><Icon size={20}/></span>
        <div>
          <h3>{planNames[plan.type]}</h3>
          <span>{plan.orderId} · v{plan.version}</span>
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {plan.trustFeasibility ? (
            <Badge
              value={plan.trustFeasibility === 'robust' ? 'active' : plan.trustFeasibility === 'conditional' ? 'at-risk' : 'fail'}
              label={`${plan.trustFeasibility.toUpperCase()}`}
            />
          ) : null}
          <Badge value={plan.riskLevel || 'routine'} label={`${plan.riskLevel || 'routine'} risk`} />
          <Badge value={plan.status} />
        </div>
      </div>
      <div className="plan-values">
        <div><span>Recover</span><strong>{number(plan.quantity)} <small>units</small></strong></div>
        <div><span>Incremental cost</span><strong>{money(plan.costCents)}</strong></div>
      </div>
      <dl className="plan-detail">
        <div><dt>Source</dt><dd>{source}</dd></div>
        <div><dt>Arrival · UTC</dt><dd>{formatTime(plan.arrivesAt)}</dd></div>
      </dl>
      <div className={`feasibility ${plan.feasible ? 'pass' : 'fail'}`}>
        {plan.feasible ? <ShieldCheck size={16}/> : <TriangleAlert size={16}/>}
        <strong>{plan.feasible ? 'Passes current constraints' : 'Constraint check failed'}</strong>
      </div>
      {plan.reasons.length ? <ul className="constraint-reasons">{plan.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
      {plan.trustFeasibility === 'conditional' && plan.verificationAction ? (
        <div className="verification-callout" style={{ margin: '8px 0', padding: '6px 10px', fontSize: '0.8rem', background: '#fefce8', border: '1px solid #fef08a', borderRadius: '6px', color: '#854d0e' }}>
          <strong>Action to make robust:</strong> {plan.verificationAction}
        </div>
      ) : null}
      <p className="plan-rationale">{plan.rationale}</p>
      <details className="plan-evidence">
        <summary>Evidence & proposal trace</summary>
        <p>Proposed by {proposer}. Inventory version {plan.inventoryVersion}.</p>
        {validApprovals.length ? (
          <p>Approvals: {validApprovals.map(a => `${data.users.find(u => u.id === a.approverId)?.name || a.approverId} (${a.role})`).join(' · ')}</p>
        ) : null}
        {plan.breakGlass ? (
          <p style={{ color: '#b91c1c' }}>Break-glass executed by {data.users.find(u => u.id === plan.breakGlass?.actorId)?.name || plan.breakGlass.actorId}: {plan.breakGlass.reason} (Review: {plan.breakGlass.reviewStatus})</p>
        ) : null}
        <p>{plan.evidenceIds.length ? plan.evidenceIds.join(' · ') : 'No linked evidence IDs'}</p>
        <code>{plan.id}</code>
      </details>
      {plan.status === 'proposed' || plan.status === 'awaiting_second_approval' ? (
        <>
          <div className="plan-actions">
            {!isHighRisk ? (
              roleAllowsApproval && plan.feasible ? (
                <button className="button primary small" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'approve' })}>
                  <Check size={14}/>Confirm routine execution
                </button>
              ) : null
            ) : plan.status === 'proposed' ? (
              roleAllowsApproval && !own && plan.feasible ? (
                <button className="button primary small" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'approve' })}>
                  <Check size={14}/>Record 1st approval
                </button>
              ) : null
            ) : (
              roleAllowsApproval && !own && !alreadyApprovedByMe && plan.feasible ? (
                <button className="button primary small" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'approve' })}>
                  <Check size={14}/>Confirm 2nd approval & execute
                </button>
              ) : null
            )}
            {isAdmin && plan.feasible ? (
              <button className="button secondary small danger-text" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'break_glass' })}>
                <ShieldAlert size={14}/>Break-glass
              </button>
            ) : null}
            {canPropose ? (
              <button className="button secondary small" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'modify' })}>
                Modify
              </button>
            ) : null}
            {roleAllowsApproval || canPropose ? (
              <button className="text-button danger-text" disabled={pending} onClick={() => open({ type: 'plan', plan, action: 'reject' })}>
                Reject
              </button>
            ) : null}
          </div>
          {isHighRisk && own ? (
            <p className="permission-note">You proposed or modified this high-risk plan. Two independent authorized reviewers must approve it.</p>
          ) : isHighRisk && alreadyApprovedByMe ? (
            <p className="permission-note">You recorded the first approval. A distinct authorized reviewer must provide the second approval.</p>
          ) : isHighRisk && plan.status === 'awaiting_second_approval' ? (
            <p className="permission-note">1 of 2 approvals recorded (by {firstApprover}). Second approval will execute the recovery.</p>
          ) : !roleAllowsApproval ? (
            <p className="permission-note">Approval requires {plan.type === 'alternative_supplier' ? 'Procurement Approver' : 'Supply Chain Manager'} access.</p>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

export function Incidents(props: ViewProps & { selectedId?: string }) {
  const { data, execute, pending, navigate, selectedId } = props;
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const incidents = data.state.incidents.filter(incident => (filter === 'all' || incident.status === filter) && `${incident.title} ${incident.id}`.toLowerCase().includes(search.toLowerCase()));
  const selected = data.state.incidents.find(incident => incident.id === selectedId) || incidents[0];
  const plans = data.state.plans.filter(plan => plan.incidentId === selected?.id);
  const impacts = data.impacts.filter(impact => impact.incidentIds.includes(selected?.id || ''));
  const evidenceIds = new Set(plans.flatMap(plan => plan.evidenceIds));
  const events = data.state.events.filter(event => event.entityId === selected?.entityId || evidenceIds.has(event.id) || selected?.type === 'stock_shortage' && data.state.lots.some(lot => lot.id === event.entityId && lot.itemId === selected.entityId));
  const aiReports = data.state.aiReports.filter(report => report.incidentId === selected?.id);
  const canGenerate = data.actor.orgId === 'focal' && ['analyst', 'manager', 'procurement', 'admin'].includes(data.actor.role);
  useEffect(() => { props.selectEntity?.(selected?.id); }, [selected?.id, props.selectEntity]);
  return <><SectionHeading title="Incidents" detail="Find the problem, understand its impact, and trace the evidence."/>
    <div className="incident-workspace"><aside className="incident-sidebar panel"><div className="incident-toolbar"><label className="sr-only" htmlFor="incident-search">Search incidents</label><input id="incident-search" placeholder="Search incidents…" value={search} onChange={event => setSearch(event.target.value)}/><label className="sr-only" htmlFor="incident-filter">Incident status</label><select id="incident-filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="recovering">Recovering</option><option value="resolved">Resolved</option></select></div>{incidents.length ? <div className="incident-list">{incidents.map(incident => <IncidentRow key={incident.id} incident={incident} state={selected?.id === incident.id ? 'selected' : undefined} onClick={() => navigate('incidents', incident.id)}/>)}</div> : <Empty title="No incidents found" detail="Try another filter or capture an operational event."/>}</aside>
    {selected ? <div className="incident-detail"><Panel title={selected.title} eyebrow={`${selected.id} · ${selected.type.replaceAll('_', ' ')}`} action={<Badge value={selected.status}/>}><p className="incident-description">{selected.description}</p><div className="incident-meta"><span><Clock3 size={15}/>{formatTime(selected.createdAt)} UTC</span><span><Activity size={15}/>{selected.alertCount} correlated alerts</span><span><Box size={15}/>{selected.affectedOrderIds.length} linked orders</span></div><div className="evidence-strip"><strong>Root entity</strong><code>{selected.entityId}</code><span>{selected.memberOrgIds.length} participating organizations</span></div></Panel>
      <Panel title="Affected orders" eyebrow="DETERMINISTIC EXPOSURE"><RiskTable data={data} navigate={navigate} impacts={impacts}/></Panel>
      <div className="recovery-link-banner"><div><span className="eyebrow">NEXT STEP</span><h3>{plans.length ? `${plans.length} recovery options recorded` : 'Find a path to recovery'}</h3><p>Compare solutions, check constraints and review approvals in Recovery.</p></div><button className="button primary" onClick={() => navigate('recovery', selected.id)}>View recovery <ArrowRight size={16}/></button></div>
      <Panel title="AI decision support" eyebrow="GROUNDED IN INCIDENT EVIDENCE" action={canGenerate ? <button className="button secondary small" disabled={pending || !data.aiConfigured} onClick={() => execute({ path: `/ai/${selected.id}`, body: {} }, 'AI assessment added to the decision trail.')}><Sparkles size={16}/>Generate AI assessment</button> : null}>{!data.aiConfigured ? <div className="ai-unavailable"><Sparkles size={20}/><div><strong>AI provider is not configured</strong><p>Summaries and AI recommendations are unavailable. The server requires an authorized provider endpoint, model and key. Deterministic recovery validation remains available.</p></div></div> : null}{aiReports.length ? aiReports.map(report => <article className="ai-report" key={report.id}><div><Badge value={report.status}/><small>{report.model} · {formatTime(report.at)} UTC</small></div><p>{report.text}</p><details><summary>Evidence and input trace</summary><p>{report.evidenceIds.join(' · ') || 'No linked evidence'}</p>{report.inputHash ? <code>{report.inputHash}</code> : null}</details></article>) : data.aiConfigured ? <p className="muted">Request an assessment based on the current incident, ranked impacts, and validated alternatives.</p> : null}</Panel>
      <Panel title="Source evidence" eyebrow="OBSERVED CLAIMS">{events.length ? <div className="evidence-items">{events.map(event => <article key={`${event.id}-${event.receivedAt}`}><div><strong>{event.type.replaceAll('_', ' ')}</strong><Badge value={event.status}/></div><p>{event.message}</p><small>{event.id} · {event.source} · effective {formatTime(event.time)} UTC</small><details><summary>Raw payload</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></article>)}</div> : <Empty title="No direct event claims in this view" detail="Review Data & evidence for the full permitted intake journal. Dependency-derived incidents can reach downstream orders without a direct event on each order."/>}</Panel>
    </div> : <Panel title="Start an incident workflow"><Empty title="The incident workspace is clear" detail="Import operational records and capture an event from Data & evidence to assess exposure and recovery."/></Panel>}</div>
  </>;
}

export function Recovery(props: ViewProps & { selectedId?: string }) {
  const { data, pending, execute, navigate, selectedId } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [incidentFilter, setIncidentFilter] = useState(selectedId || 'all');
  useEffect(() => { if (selectedId) setIncidentFilter(data.state.plans.find(x => x.id === selectedId)?.incidentId || selectedId); }, [selectedId, data.state.plans]);
  useEffect(() => { props.selectEntity?.(incidentFilter === 'all' ? undefined : incidentFilter); }, [incidentFilter, props.selectEntity]);
  const canGenerate = data.actor.orgId === 'focal' && ['analyst', 'manager', 'procurement', 'admin'].includes(data.actor.role);
  const visiblePlans = data.state.plans.filter(x => (incidentFilter === 'all' || x.incidentId === incidentFilter) && (status === 'all' || x.status === status || status === 'feasible' && x.feasible || status === 'infeasible' && !x.feasible) && `${x.id} ${x.type} ${x.rationale} ${x.sourceId} ${data.state.incidents.find(i => i.id === x.incidentId)?.title || ''}`.toLowerCase().includes(search.toLowerCase()));
  const groups = data.state.incidents.filter(x => (incidentFilter === 'all' || x.id === incidentFilter) && (visiblePlans.some(p => p.incidentId === x.id) || !search && status === 'all' && x.status !== 'resolved'));
  return <><SectionHeading title="Recovery" detail="Compare the options. Understand the tradeoffs. Approve with confidence."/>
    <div className="mini-metrics"><div><ListChecks size={18}/><strong>{data.state.plans.filter(x => x.feasible && ['proposed', 'awaiting_second_approval'].includes(x.status)).length}</strong><span>awaiting approval</span></div><div><ShieldCheck size={18}/><strong>{data.state.plans.filter(x => x.status === 'executed').length}</strong><span>executed recoveries</span></div><div><GitBranch size={18}/><strong>{data.state.plans.filter(x => x.feasible).length}</strong><span>feasible options</span></div></div>
    <div className="filter-bar"><input aria-label="Search recovery proposals" placeholder="Search proposals, sources or incidents…" value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="Recovery incident" value={incidentFilter} onChange={e => setIncidentFilter(e.target.value)}><option value="all">All incidents</option>{data.state.incidents.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select><select aria-label="Recovery status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All proposal statuses</option><option value="feasible">Feasible options</option><option value="infeasible">Blocked options</option>{['proposed', 'awaiting_second_approval', 'executed', 'rejected', 'stale'].map(x => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}</select><span className="results-count">{visiblePlans.length} proposals</span></div>
    {groups.length ? groups.map(incident => <Panel key={incident.id} title={incident.title} eyebrow={`${incident.status.toUpperCase()} · ${incident.affectedOrderIds.length} AFFECTED ORDERS`} action={<div className="button-row"><button className="text-button" onClick={() => navigate('incidents', incident.id)}>View incident <ArrowRight size={14}/></button>{canGenerate ? <button className="button primary small" disabled={pending || incident.status === 'resolved'} onClick={() => execute({ path: '/plans/generate', body: { incidentId: incident.id } }, 'Recovery options generated against current constraints.')}><GitBranch size={15}/>{data.state.plans.some(x => x.incidentId === incident.id) ? 'Recalculate options' : 'Generate options'}</button> : null}</div>}><p className="panel-intro">Options are checked against current stock, quality, capacity and deadlines. Approval revalidates these constraints.</p>{visiblePlans.some(x => x.incidentId === incident.id) ? <div className="plan-grid recovery-plan-grid">{visiblePlans.filter(x => x.incidentId === incident.id).map(plan => <PlanCard key={plan.id} plan={plan} props={props}/>)}</div> : <Empty title="No recovery proposals yet" detail={canGenerate ? 'Generate options to compare inventory reallocation, expediting, alternative sourcing and split orders.' : 'An authorized operations user can generate proposals for this incident.'}/>}</Panel>) : <Panel title="Recovery queue"><Empty title="No matching recovery work" detail={data.state.incidents.length ? 'Try changing the filters or select an active incident.' : 'Recovery options will appear after delivered evidence creates an incident.'}/></Panel>}
    <BaselineComparisonPanel />
  </>;
}

function BaselineComparisonPanel() {
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    fetch('/api/baseline-comparison', { credentials: 'same-origin' })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setReport(data); })
      .catch(() => {});
  }, []);

  if (!report || !report.metrics) return null;

  return (
    <Panel
      title="Automated Baseline Comparison"
      eyebrow="SYNTHETIC BENCHMARK EVALUATION (F4)"
      action={<Badge value="low" label="Synthetic Evaluation" />}
    >
      <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
        {report.summary}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Evaluation Metric</th>
              <th style={{ color: '#047857' }}>DisruptionIQ (Hardened)</th>
              <th style={{ color: '#b45309' }}>ERP-Only Baseline</th>
              <th style={{ color: '#b91c1c' }}>Last-Write-Wins (LWW)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Injected Conflicts Caught</strong><div className="table-sub">{report.metrics.conflictsCaught.note}</div></td>
              <td><strong style={{ color: '#047857' }}>{report.metrics.conflictsCaught.disruptionIQ}</strong></td>
              <td><span>{report.metrics.conflictsCaught.erpOnly}</span></td>
              <td><span>{report.metrics.conflictsCaught.lastWriteWins}</span></td>
            </tr>
            <tr>
              <td><strong>Duplicate Events Trapped</strong><div className="table-sub">{report.metrics.duplicateEventsTrapped.note}</div></td>
              <td><strong style={{ color: '#047857' }}>{report.metrics.duplicateEventsTrapped.disruptionIQ}</strong></td>
              <td><span>{report.metrics.duplicateEventsTrapped.erpOnly}</span></td>
              <td><span>{report.metrics.duplicateEventsTrapped.lastWriteWins}</span></td>
            </tr>
            <tr>
              <td><strong>Constraint Violations</strong><div className="table-sub">{report.metrics.constraintViolations.note}</div></td>
              <td><strong style={{ color: '#047857' }}>{report.metrics.constraintViolations.disruptionIQ}</strong></td>
              <td><span style={{ color: '#b45309' }}>{report.metrics.constraintViolations.erpOnly} violations</span></td>
              <td><span style={{ color: '#b91c1c' }}>{report.metrics.constraintViolations.lastWriteWins} violations</span></td>
            </tr>
            <tr>
              <td><strong>Wrong Recovery Decisions</strong><div className="table-sub">{report.metrics.wrongDecisions.note}</div></td>
              <td><strong style={{ color: '#047857' }}>{report.metrics.wrongDecisions.disruptionIQ}</strong></td>
              <td><span style={{ color: '#b45309' }}>{report.metrics.wrongDecisions.erpOnly} wrong decisions</span></td>
              <td><span style={{ color: '#b91c1c' }}>{report.metrics.wrongDecisions.lastWriteWins} wrong decisions</span></td>
            </tr>
            <tr>
              <td><strong>Unverified Phantom Stock Allocated</strong><div className="table-sub">{report.metrics.unverifiedStockExposures.note}</div></td>
              <td><strong style={{ color: '#047857' }}>{report.metrics.unverifiedStockExposures.disruptionIQ}</strong></td>
              <td><span style={{ color: '#b45309' }}>{report.metrics.unverifiedStockExposures.erpOnly}</span></td>
              <td><span style={{ color: '#b91c1c' }}>{report.metrics.unverifiedStockExposures.lastWriteWins}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
