import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  FileCheck2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { AgentExecutionLog, AgentFeature, AgentType } from '../../shared/types';
import { request } from '../api';
import { formatTime } from './ui';

export interface AiActivityFeedProps {
  limit?: number;
  feature?: AgentFeature;
  className?: string;
}

function getAgentMeta(agent: AgentType) {
  switch (agent) {
    case 'triage':
      return {
        label: 'Triage Agent',
        icon: ShieldAlert,
        className: 'badge-agent-triage',
      };
    case 'advisor':
      return {
        label: 'Recovery Advisor',
        icon: Sparkles,
        className: 'badge-agent-advisor',
      };
    case 'reconciler':
      return {
        label: 'Document Reconciler',
        icon: FileCheck2,
        className: 'badge-agent-reconciler',
      };
    case 'copilot':
      return {
        label: 'Copilot',
        icon: Bot,
        className: 'badge-agent-copilot',
      };
    default:
      return {
        label: agent,
        icon: Activity,
        className: 'badge-agent-default',
      };
  }
}

export function AiActivityFeed({ limit = 10, feature, className = '' }: AiActivityFeedProps) {
  const {
    data: logs,
    isLoading,
    error,
  } = useQuery<AgentExecutionLog[], Error>({
    queryKey: ['agent-logs', limit, feature],
    queryFn: () => {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (feature) params.set('feature', feature);
      const queryStr = params.toString() ? `?${params.toString()}` : '';
      return request<AgentExecutionLog[]>(`/agent-logs${queryStr}`);
    },
    refetchInterval: 8_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className={`ai-activity-feed-loading ${className}`}>
        <Activity size={16} className="spin accent-icon" />
        <span>Loading agent execution audit log…</span>
      </div>
    );
  }

  if (error) {
    // If partner viewer or restricted, render a neutral message
    const isRestricted = error.message.includes('403') || error.message.toLowerCase().includes('partner');
    return (
      <div className={`ai-activity-feed-empty ${className}`}>
        <Clock size={16} className="muted" />
        <span>
          {isRestricted
            ? 'Agent telemetry is restricted to focal workspace operators.'
            : 'Agent logs temporarily unavailable.'}
        </span>
      </div>
    );
  }

  if (!logs || logs.length === 0) {
    return (
      <div className={`ai-activity-feed-empty ${className}`}>
        <Bot size={18} className="muted" />
        <span>No autonomous agent executions recorded yet. Triggers will log here in real-time.</span>
      </div>
    );
  }

  return (
    <div className={`ai-activity-feed ${className}`}>
      <div className="ai-activity-list">
        {logs.map(log => {
          const meta = getAgentMeta(log.agent);
          const Icon = meta.icon;
          const statusClass =
            log.status === 'success'
              ? 'status-pill-success'
              : log.status === 'error'
              ? 'status-pill-alert'
              : 'status-pill-warning';

          return (
            <article key={log.id} className="ai-activity-item">
              <div className="ai-activity-lead">
                <span className={`ai-agent-badge ${meta.className}`}>
                  <Icon size={12} strokeWidth={2} />
                  <span>{meta.label}</span>
                </span>
                <span className="ai-action-tag">
                  {log.action.replaceAll('_', ' ')}
                </span>
                <span className={`status-pill ${statusClass} ai-status-pill`}>
                  {log.status === 'success' ? (
                    <CheckCircle2 size={10} />
                  ) : (
                    <AlertTriangle size={10} />
                  )}
                  <span>{log.status}</span>
                </span>
                <span className="ai-activity-time">
                  <Clock size={11} />
                  <span>{formatTime(log.timestamp)} UTC</span>
                </span>
              </div>

              <div className="ai-activity-body">
                <p className="ai-activity-summary">{log.summary}</p>

                <div className="ai-activity-meta">
                  {log.accessedEntities.length > 0 ? (
                    <div className="ai-accessed-entities">
                      <span className="entities-label">Entities:</span>
                      {log.accessedEntities.map(ent => (
                        <code key={ent} className="entity-chip">
                          {ent}
                        </code>
                      ))}
                    </div>
                  ) : null}

                  <div className="ai-model-tag">
                    <Cpu size={11} />
                    <span>{log.model}</span>
                    <span className="latency-dot">·</span>
                    <span>{Math.round(log.latencyMs)}ms</span>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
