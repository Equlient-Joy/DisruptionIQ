import { Activity, ArrowRight, Bell, Box, ChevronRight, ListChecks, ShieldCheck } from 'lucide-react';
import type { ViewProps } from '../model';
import { Empty, formatTime, number, Panel, SectionHeading } from './ui';
import { RiskTable } from './operations';
import { NetworkGraph } from './network-graph';
import { ActivityPanel } from './history-view';

export function Overview(props: ViewProps) {
  const { data, navigate } = props;
  const { state } = data;
  const active = state.incidents.filter(x => x.status !== 'resolved');
  const resolved = state.incidents.filter(x => x.status === 'resolved').length;
  const pending = state.plans.filter(x => x.feasible && ['proposed', 'awaiting_second_approval'].includes(x.status));
  const metrics = [
    { label: 'Active incidents', value: active.length, detail: `${active.filter(x => x.status === 'recovering').length} in recovery`, Icon: Activity, tone: 'orange', page: 'incidents' as const },
    { label: 'Orders at risk', value: data.impacts.length, detail: `${number(data.impacts.reduce((sum, x) => sum + x.shortage, 0))} uncovered units`, Icon: Box, tone: 'red', page: 'incidents' as const },
    { label: 'Awaiting approval', value: pending.length, detail: 'Feasible proposals needing review', Icon: ListChecks, tone: 'blue', page: 'recovery' as const },
    { label: 'Recovery progress', value: state.incidents.length ? `${Math.round(resolved / state.incidents.length * 100)}%` : '—', detail: state.incidents.length ? `${resolved} of ${state.incidents.length} incidents resolved` : 'No incidents recorded yet', Icon: ShieldCheck, tone: 'teal', page: 'recovery' as const },
  ];
  return <><SectionHeading title="Dashboard" detail="Your supply chain at a glance. See what needs attention."><span className="workspace-date">{formatTime(state.clock)} UTC</span></SectionHeading><NetworkGraph {...props}/>
    <div className="metrics dashboard-metrics">{metrics.map(({ label, value, detail, Icon, tone, page }) => <button key={label} className="metric" onClick={() => navigate(page)}><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon size={19}/></span></div><strong className="metric-value">{value}</strong><span className="metric-note">{detail}</span></button>)}</div>
    <div className="dashboard-insights"><Panel title="Priority orders" eyebrow="WHERE ACTION MATTERS" action={<button className="text-button" onClick={() => navigate('incidents')}>View incidents <ArrowRight size={14}/></button>}><RiskTable data={data} navigate={navigate}/></Panel><Panel title="Incident watch" eyebrow="ACTIVE & RECOVERING" action={<span className="count-pill">{active.length}</span>}>{active.length ? <div className="incident-list">{active.slice(0, 5).map(x => <button key={x.id} className="incident-row" onClick={() => navigate('incidents', x.id)}><span className={`incident-symbol ${x.status}`}><Activity size={17}/></span><div><strong>{x.title}</strong><span>{x.affectedOrderIds.length} affected orders · {x.status}</span></div><ChevronRight size={17}/></button>)}</div> : <Empty title="No active incidents recorded" detail="New disruptions appear here when delivered evidence identifies them."/>}</Panel></div>
    <div className="dashboard-insights activity-insights"><ActivityPanel {...props}/><Panel title="Team updates" eyebrow="YOUR ORGANIZATION" action={<Bell size={17} className="muted"/>}>{state.notifications.length ? <div className="notifications">{state.notifications.slice(-6).reverse().map(x => <div key={x.id}><span className="notification-dot"/><div><p>{x.message}</p><small>{formatTime(x.at)} UTC{x.targetRoles?.length ? ` · For: ${x.targetRoles.join(', ')}` : ''}</small></div>{x.incidentId ? <button className="icon-button" aria-label="Open notification incident" onClick={() => navigate('incidents', x.incidentId)}><ChevronRight size={15}/></button> : null}</div>)}</div> : <Empty title="No team updates yet" detail="Notifications will appear as evidence and decisions arrive."/>}{pending.length ? <div className="approval-callout"><strong>{pending.length} recovery proposal{pending.length === 1 ? '' : 's'} awaiting review</strong><button className="text-button" onClick={() => navigate('recovery')}>Open recovery <ArrowRight size={14}/></button></div> : null}</Panel></div>
  </>;
}
