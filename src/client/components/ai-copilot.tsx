import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Box,
  CheckCircle2,
  Clock,
  GitBranch,
  RefreshCw,
  Send,
  Sparkles,
  User,
  X,
  Zap,
} from 'lucide-react';
import type { ActionCard, Actor, ChatMessage, SimulationDiff } from '../../shared/types';
import type { Page } from '../model';
import { request } from '../api';
import { formatTime, money, number } from './ui';

export interface AiCopilotDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  navigate: (page: Page, entityId?: string) => void;
  activePage: Page;
  activeEntityId?: string;
  actor: Actor;
  onTriggerActionCard?: (card: ActionCard) => void;
}

export function mapEntityToPage(entityType: string): Page {
  const t = entityType.toLowerCase();
  switch (t) {
    case 'incidents':
    case 'incident':
    case 'plans':
    case 'plan':
      return 'incidents';
    case 'orders':
    case 'order':
      return 'overview';
    case 'shipments':
    case 'shipment':
    case 'lots':
    case 'lot':
      return 'inventory';
    case 'warehouses':
    case 'warehouse':
    case 'suppliers':
    case 'supplier':
      return 'network';
    case 'tasks':
    case 'task':
      return 'collaboration';
    case 'events':
    case 'event':
    case 'documents':
    case 'document':
      return 'evidence';
    case 'decisions':
    case 'history':
      return 'history';
    default:
      if (['overview', 'incidents', 'network', 'inventory', 'evidence', 'collaboration', 'history'].includes(t)) {
        return t as Page;
      }
      return 'overview';
  }
}

function renderInlineFormatting(text: string, keyPrefix: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${idx}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${keyPrefix}-${idx}`} className="copilot-inline-code">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function renderFormattedMessage(
  text: string,
  onNavigate: (page: Page, entityId?: string) => void
): React.ReactNode {
  const linkRegex = /\[([^\]]+)\]\((app:\/\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)|https?:\/\/[^\s)]+)\)/g;
  const lines = text.split('\n');

  return (
    <div className="copilot-formatted-body">
      {lines.map((line, lineIdx) => {
        const isBullet = line.trim().startsWith('- ') || line.trim().startsWith('* ');
        const cleanLine = isBullet ? line.trim().replace(/^[-*]\s+/, '') : line;

        const elements: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        linkRegex.lastIndex = 0;
        while ((match = linkRegex.exec(cleanLine)) !== null) {
          if (match.index > lastIndex) {
            elements.push(
              renderInlineFormatting(cleanLine.substring(lastIndex, match.index), `${lineIdx}-${lastIndex}`)
            );
          }

          const label = match[1];
          const fullUrl = match[2];
          const appEntityType = match[3];
          const appEntityId = match[4];

          if (appEntityType && appEntityId) {
            elements.push(
              <button
                key={`deep-${lineIdx}-${match.index}`}
                type="button"
                className="copilot-deep-link"
                title={`Navigate to ${appEntityType} / ${appEntityId}`}
                onClick={() => {
                  const targetPage = mapEntityToPage(appEntityType);
                  onNavigate(targetPage, appEntityId);
                }}
              >
                {label}
              </button>
            );
          } else {
            elements.push(
              <a
                key={`ext-${lineIdx}-${match.index}`}
                href={fullUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="copilot-external-link"
              >
                {label}
              </a>
            );
          }

          lastIndex = match.index + match[0].length;
        }

        if (lastIndex < cleanLine.length) {
          elements.push(renderInlineFormatting(cleanLine.substring(lastIndex), `${lineIdx}-${lastIndex}`));
        }

        if (isBullet) {
          return (
            <div key={`line-${lineIdx}`} className="copilot-bullet-row">
              <span className="copilot-bullet-dot">•</span>
              <span className="copilot-bullet-content">{elements}</span>
            </div>
          );
        }

        if (cleanLine.trim() === '') {
          return <div key={`spacer-${lineIdx}`} className="copilot-paragraph-spacer" />;
        }

        return (
          <p key={`p-${lineIdx}`} className="copilot-paragraph">
            {elements}
          </p>
        );
      })}
    </div>
  );
}

export function ActionCardView({
  card,
  onTrigger,
}: {
  card: ActionCard;
  onTrigger?: (card: ActionCard) => void;
}) {
  return (
    <div className="copilot-action-card">
      <div className="copilot-action-card-header">
        <div className="copilot-action-card-title-group">
          <span className="copilot-action-card-icon">
            {card.cardType === 'lot_hold_prompt' ? <Box size={15} /> : <Zap size={15} />}
          </span>
          <strong className="copilot-action-card-title">{card.title}</strong>
        </div>
        <div className="copilot-action-card-badges">
          {card.risk ? (
            <span className={`risk-badge ${card.risk === 'high' ? 'risk-badge-high' : 'risk-badge-routine'}`}>
              {card.risk === 'high' ? 'High Risk' : 'Routine'}
            </span>
          ) : null}
          {card.cost !== undefined ? (
            <span className="copilot-card-cost">{money(card.cost)}</span>
          ) : null}
        </div>
      </div>
      <p className="copilot-action-card-detail">{card.detail}</p>
      <div className="copilot-action-card-footer">
        <button
          type="button"
          className="button primary small copilot-action-btn"
          onClick={() => onTrigger?.(card)}
        >
          <span>{card.buttonLabel}</span>
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}

export function SimulationDiffView({
  diff,
  onNavigate,
}: {
  diff: SimulationDiff;
  onNavigate: (page: Page, entityId?: string) => void;
}) {
  return (
    <div className="simulation-diff-panel">
      <div className="simulation-diff-header">
        <div className="simulation-diff-title">
          <GitBranch size={15} className="simulation-icon" />
          <span className="simulation-badge">{diff.entityType.toUpperCase()} SCENARIO</span>
        </div>
        <span className="simulation-entity-id">{diff.entityId}</span>
      </div>

      <p className="simulation-scenario-desc">{diff.scenarioDescription}</p>

      <div className="simulation-metrics-grid">
        <div className="simulation-metric-box">
          <span className="metric-box-label">Exposed Orders</span>
          <div className="metric-box-values">
            <span className="metric-baseline">{diff.baselineExposedOrders}</span>
            <span className="metric-arrow">→</span>
            <span className="metric-simulated">{diff.simulatedExposedOrders}</span>
            {diff.deltaExposedOrders > 0 ? (
              <span className="metric-delta delta-danger">+{diff.deltaExposedOrders}</span>
            ) : (
              <span className="metric-delta delta-neutral">{diff.deltaExposedOrders}</span>
            )}
          </div>
        </div>

        <div className="simulation-metric-box">
          <span className="metric-box-label">Total Shortage</span>
          <div className="metric-box-values">
            <span className="metric-baseline">{number(diff.baselineTotalShortage)}</span>
            <span className="metric-arrow">→</span>
            <span className="metric-simulated">{number(diff.simulatedTotalShortage)}</span>
            {diff.deltaShortage > 0 ? (
              <span className="metric-delta delta-danger">+{number(diff.deltaShortage)}</span>
            ) : (
              <span className="metric-delta delta-neutral">{number(diff.deltaShortage)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="simulation-recovery-summary">
        <div className="recovery-count">
          <strong>{diff.feasibleRecoveryCount}</strong> feasible recovery option{diff.feasibleRecoveryCount === 1 ? '' : 's'}
        </div>
        {diff.recommendedPlanType ? (
          <span className="badge badge-recommended">
            Recommended: {diff.recommendedPlanType.replaceAll('_', ' ')}
          </span>
        ) : null}
      </div>

      {diff.newlyBreachedOrders.length > 0 ? (
        <div className="simulation-breached-orders">
          <div className="breached-orders-heading">
            <AlertTriangle size={13} className="danger-text" />
            <span>Newly Breached Orders ({diff.newlyBreachedOrders.length})</span>
          </div>
          <ul className="breached-orders-list">
            {diff.newlyBreachedOrders.map(order => (
              <li key={order.orderId} className="breached-order-item">
                <button
                  type="button"
                  className="copilot-deep-link order-link"
                  onClick={() => onNavigate('overview', order.orderId)}
                  title={`Focus order ${order.orderId}`}
                >
                  {order.orderId}
                </button>
                <span className="customer-name">{order.customer}</span>
                <span className={`time-remaining ${order.hoursToDeadline <= 0 ? 'breached' : 'warning'}`}>
                  {order.hoursToDeadline <= 0 ? 'Breached' : `${Math.round(order.hoursToDeadline)}h remaining`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="simulation-no-breaches">
          <CheckCircle2 size={13} className="success-text" />
          <span>No newly breached orders in this scenario</span>
        </div>
      )}
    </div>
  );
}

const QUICK_PROMPTS = [
  'What if shipment-atlas is delayed 24h?',
  'Show high-risk orders with < 12h remaining',
  'What recovery options exist for the active incident?',
];

export function AiCopilotDrawer({
  isOpen,
  onClose,
  navigate,
  activePage,
  activeEntityId,
  actor,
  onTriggerActionCard,
}: AiCopilotDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pageLabels: Record<Page, string> = {
    overview: 'Overview',
    incidents: 'Incidents',
    network: 'Network',
    inventory: 'Inventory',
    evidence: 'Evidence',
    collaboration: 'Collaboration',
    history: 'History',
  };

  const contextLabel = activeEntityId
    ? `Context: ${pageLabels[activePage] || activePage} / ${activeEntityId}`
    : `Context: ${pageLabels[activePage] || activePage}`;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages.length, loading, scrollToBottom]);

  // Handle ESC key to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const sendMessage = useCallback(
    async (textToSend: string) => {
      const trimmed = textToSend.trim();
      if (!trimmed || loading) return;

      setError(undefined);
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };

      const updatedHistory = [...messages, userMessage];
      setMessages(updatedHistory);
      setInput('');
      setLoading(true);

      try {
        const reply = await request<ChatMessage>('/ai/chat', {
          message: trimmed,
          history: updatedHistory,
          currentContext: {
            page: activePage,
            entityId: activeEntityId,
          },
        });

        setMessages(prev => [...prev, reply]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Copilot service error';
        setError(errorMsg);
        const fallbackAssistantMessage: ChatMessage = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Unable to complete request: ${errorMsg}. Please try rephrasing or inspect network connectivity.`,
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, fallbackAssistantMessage]);
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, activePage, activeEntityId]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const handleQuickPromptClick = (prompt: string) => {
    void sendMessage(prompt);
  };

  if (!isOpen) return null;

  return (
    <div className="copilot-drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="copilot-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="DisruptionIQ Copilot"
        onClick={e => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <header className="copilot-header">
          <div className="copilot-header-brand">
            <div className="copilot-icon-badge">
              <Sparkles size={18} className="copilot-sparkle-icon" />
            </div>
            <div className="copilot-header-titles">
              <h2 className="copilot-title">DisruptionIQ Copilot</h2>
              <span className="copilot-context-pill" title={contextLabel}>
                {contextLabel}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button copilot-close-btn"
            onClick={onClose}
            aria-label="Close DisruptionIQ Copilot"
          >
            <X size={18} />
          </button>
        </header>

        {/* Message Container */}
        <div className="copilot-messages">
          {messages.length === 0 ? (
            <div className="copilot-welcome">
              <div className="welcome-avatar">
                <Bot size={26} strokeWidth={1.7} />
              </div>
              <h3>Hello, {actor.name.split(' ')[0]}</h3>
              <p>
                I am your DisruptionIQ Copilot. I analyze supply chain signals, simulate what-if delay scenarios,
                identify exposed customer orders, and propose actionable recovery plans.
              </p>
              <div className="welcome-prompts-label">Try asking:</div>
              <div className="copilot-quick-prompts-vertical">
                {QUICK_PROMPTS.map((prompt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="copilot-chip"
                    onClick={() => handleQuickPromptClick(prompt)}
                  >
                    <span>{prompt}</span>
                    <ArrowRight size={13} className="chip-arrow" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map(msg => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`copilot-message-row ${isUser ? 'user-row' : 'assistant-row'}`}
                >
                  <div className="copilot-message-avatar">
                    {isUser ? <User size={14} /> : <Bot size={14} />}
                  </div>
                  <div className="copilot-message-bubble">
                    <div className="copilot-message-meta">
                      <span className="sender-name">{isUser ? actor.name : 'DisruptionIQ Copilot'}</span>
                      <span className="timestamp">{formatTime(msg.timestamp)}</span>
                    </div>

                    <div className="copilot-message-content">
                      {renderFormattedMessage(msg.content, navigate)}
                    </div>

                    {/* Simulation Result Diff */}
                    {msg.simulationResult ? (
                      <SimulationDiffView diff={msg.simulationResult} onNavigate={navigate} />
                    ) : null}

                    {/* Action Cards */}
                    {msg.actionCards && msg.actionCards.length > 0 ? (
                      <div className="copilot-cards-container">
                        {msg.actionCards.map(card => (
                          <ActionCardView
                            key={card.id}
                            card={card}
                            onTrigger={onTriggerActionCard}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}

          {loading ? (
            <div className="copilot-message-row assistant-row loading-row">
              <div className="copilot-message-avatar">
                <Bot size={14} />
              </div>
              <div className="copilot-message-bubble loading-bubble">
                <div className="copilot-loading-indicator">
                  <RefreshCw size={14} className="spin accent-icon" />
                  <span>Analyzing network state & running recovery models…</span>
                </div>
              </div>
            </div>
          ) : null}

          {error && !loading ? (
            <div className="copilot-error-banner" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts Strip (Visible when messages exist) */}
        {messages.length > 0 ? (
          <div className="copilot-quick-prompts-bar">
            {QUICK_PROMPTS.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                className="copilot-chip-mini"
                disabled={loading}
                onClick={() => handleQuickPromptClick(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        {/* Input Form */}
        <form className="copilot-input-bar" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="copilot-text-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about disruptions, what-if scenarios, recovery…"
            disabled={loading}
          />
          <button
            type="submit"
            className="button primary small copilot-send-button"
            disabled={loading || !input.trim()}
            title="Send prompt to Copilot"
          >
            {loading ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}
            <span>Ask</span>
          </button>
        </form>
      </aside>
    </div>
  );
}
