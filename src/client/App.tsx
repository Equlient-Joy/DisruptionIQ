import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  FileCheck2,
  FileText,
  GitBranch,
  Layers3,
  ListChecks,
  Lock,
  LogOut,
  Mail,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  User,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { DashboardResponse, Role, Actor } from '../shared/types';
import { roleLabels } from '../shared/types';
import { request, useCommand, ApiError, type Command } from './api';
import type { Page, Dialog, ViewProps } from './model';
import { Badge, Empty, formatTime, Modal, Panel, SectionHeading } from './components/ui';
import { Overview, Incidents } from './components/operations';
import { Network, Inventory } from './components/resources';
import { Evidence, Collaboration, History } from './components/evidence';
import { WorkflowDialog } from './components/forms';

interface DemoUserDef {
  label: string;
  role: Role;
  email: string;
  name: string;
  orgId: 'focal' | 'partner';
  description: string;
}

const DEMO_ACCOUNTS: DemoUserDef[] = [
  {
    label: 'Operations Analyst',
    role: 'analyst',
    email: 'analyst@disruptioniq.local',
    name: 'Alex Rivera',
    orgId: 'focal',
    description: 'Correlate signals, assess order risk & generate recovery options',
  },
  {
    label: 'Supply Chain Manager',
    role: 'manager',
    email: 'manager@disruptioniq.local',
    name: 'Priya Sharma',
    orgId: 'focal',
    description: 'Authorize recovery plans, manage outages & assign collaborative tasks',
  },
  {
    label: 'Warehouse Operator',
    role: 'warehouse',
    email: 'warehouse@disruptioniq.local',
    name: 'Kabir Rao',
    orgId: 'focal',
    description: 'Inspect lot quality, quarantine stock & update receiving',
  },
  {
    label: 'Procurement Approver',
    role: 'procurement',
    email: 'procurement@disruptioniq.local',
    name: 'Ananya Iyer',
    orgId: 'focal',
    description: 'Authorize alternative supplier options & review freight documents',
  },
  {
    label: 'Administrator',
    role: 'admin',
    email: 'admin@disruptioniq.local',
    name: 'Dev Admin',
    orgId: 'focal',
    description: 'Full workspace administration, security & scenario reset controls',
  },
  {
    label: 'Partner Supplier: Nexus',
    role: 'analyst',
    email: 'partner@nexus-components.example',
    name: 'Maya Chen',
    orgId: 'partner',
    description: 'External partner portal with incident-scoped task collaboration',
  },
];

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<boolean>;
  loading: boolean;
  error?: string;
  defaultPassword?: string;
}

function LoginPage({ onLogin, loading, error, defaultPassword = 'disruption-demo' }: LoginProps) {
  const [email, setEmail] = useState('analyst@disruptioniq.local');
  const [password, setPassword] = useState(defaultPassword);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onLogin(email, password);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-brand-icon">
            <Activity size={28} strokeWidth={2} />
          </div>
          <h1>DisruptionIQ</h1>
          <p className="login-sub">From delivery delays to recovery plans</p>
          <span className="login-badge">Operational Control Room</span>
        </div>

        {error ? (
          <div className="login-error" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="login-email">
              <Mail size={14} /> Email address
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="user@disruptioniq.local"
            />
          </div>

          <div className="form-group">
            <label htmlFor="login-password">
              <Lock size={14} /> Password
            </label>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>

          <button type="submit" className="button primary login-button" disabled={loading}>
            {loading ? <RefreshCw size={16} className="spin" /> : <ArrowRight size={16} />}
            {loading ? 'Authenticating…' : 'Sign In'}
          </button>
        </form>

        <div className="demo-accounts-section">
          <div className="demo-accounts-heading">
            <Users size={14} />
            <span>Demo Account Switcher (1-click sign-in)</span>
          </div>
          <div className="demo-accounts-grid">
            {DEMO_ACCOUNTS.map(account => (
              <button
                key={account.email}
                type="button"
                className="demo-account-card"
                disabled={loading}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(defaultPassword);
                  void onLogin(account.email, defaultPassword);
                }}
              >
                <div className="demo-account-top">
                  <span className="demo-account-label">{account.label}</span>
                  <span className={`org-chip ${account.orgId}`}>{account.orgId}</span>
                </div>
                <div className="demo-account-user">{account.name}</div>
                <div className="demo-account-email">{account.email}</div>
                <div className="demo-account-desc">{account.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>('overview');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [commandSuccess, setCommandSuccess] = useState<string>();
  const [commandError, setCommandError] = useState<string>();
  const [loginError, setLoginError] = useState<string>();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const {
    data,
    isLoading,
    error: dashboardError,
    refetch,
  } = useQuery<DashboardResponse, Error>({
    queryKey: ['dashboard'],
    queryFn: () => request<DashboardResponse>('/dashboard'),
    retry: false,
    staleTime: 5_000,
  });

  const { data: demoData } = useQuery<{ users: Actor[]; demoPassword: string } | null>({
    queryKey: ['demo-users'],
    queryFn: () => request<{ users: Actor[]; demoPassword: string }>('/demo-users').catch(() => null),
    retry: false,
    enabled: !!dashboardError,
  });

  const command = useCommand();

  const execute = useCallback(
    async (cmd: Command, successMessage?: string): Promise<boolean> => {
      setCommandError(undefined);
      setCommandSuccess(undefined);
      try {
        await command.mutateAsync(cmd);
        if (successMessage) {
          setCommandSuccess(successMessage);
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Action failed';
        setCommandError(message);
        return false;
      }
    },
    [command],
  );

  const navigate = useCallback((targetPage: Page, incidentId?: string) => {
    setPage(targetPage);
    if (incidentId) {
      setSelectedIncidentId(incidentId);
    }
  }, []);

  const open = useCallback((targetDialog: Dialog) => {
    setCommandError(undefined);
    setDialog(targetDialog);
  }, []);

  useEffect(() => {
    if (commandSuccess) {
      const timer = setTimeout(() => setCommandSuccess(undefined), 6_000);
      return () => clearTimeout(timer);
    }
  }, [commandSuccess]);

  const handleLogin = useCallback(
    async (emailInput: string, passwordInput: string): Promise<boolean> => {
      setIsLoggingIn(true);
      setLoginError(undefined);
      try {
        await request('/login', { email: emailInput, password: passwordInput });
        await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        await refetch();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Authentication failed';
        setLoginError(msg);
        return false;
      } finally {
        setIsLoggingIn(false);
      }
    },
    [queryClient, refetch],
  );

  const handleLogout = useCallback(async () => {
    try {
      await request('/logout', {});
    } catch {
      // ignore
    } finally {
      queryClient.clear();
      await refetch();
    }
  }, [queryClient, refetch]);

  if (isLoading) {
    return (
      <div className="loading-screen">
        <Activity size={32} className="spin accent-icon" />
        <p>Loading DisruptionIQ operational picture…</p>
      </div>
    );
  }

  const isUnauthorized =
    (dashboardError instanceof ApiError && dashboardError.status === 401) ||
    dashboardError?.message?.includes('401') ||
    dashboardError?.message?.toLowerCase().includes('sign in');

  if (isUnauthorized || !data) {
    return (
      <LoginPage
        onLogin={handleLogin}
        loading={isLoggingIn}
        error={loginError}
        defaultPassword={demoData?.demoPassword || 'disruption-demo'}
      />
    );
  }

  if (dashboardError) {
    return (
      <div className="error-screen">
        <AlertTriangle size={36} className="danger-text" />
        <h2>Unable to load operational dashboard</h2>
        <p>{dashboardError.message}</p>
        <button className="button primary" onClick={() => refetch()}>
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  const { actor, state } = data;
  const activeIncidents = state.incidents.filter(inc => inc.status !== 'resolved');
  const anomaliesCount = state.events.filter(event => ['invalid', 'conflict', 'stale'].includes(event.status)).length;
  const queueCount = state.queue.length;
  const openTasksCount = state.tasks.filter(task => task.status === 'open').length;

  const canRunScenarios = actor.orgId === 'focal' && ['analyst', 'manager', 'admin'].includes(actor.role);
  const canReset = actor.orgId === 'focal' && actor.role === 'admin';

  const viewProps: ViewProps = {
    data,
    pending: command.isPending,
    execute,
    open,
    navigate,
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">
            <Activity size={22} strokeWidth={2.2} />
          </div>
          <div className="brand-text">
            <strong>DisruptionIQ</strong>
            <span>Control Room</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${page === 'overview' ? 'active' : ''}`}
            onClick={() => navigate('overview')}
          >
            <Activity size={18} />
            <span>Overview</span>
          </button>

          <button
            className={`nav-item ${page === 'incidents' ? 'active' : ''}`}
            onClick={() => navigate('incidents')}
          >
            <AlertTriangle size={18} />
            <span>Incidents & Recovery</span>
            {activeIncidents.length > 0 ? (
              <span className="nav-badge alert">{activeIncidents.length}</span>
            ) : null}
          </button>

          <button
            className={`nav-item ${page === 'network' ? 'active' : ''}`}
            onClick={() => navigate('network')}
          >
            <GitBranch size={18} />
            <span>Supply Network</span>
          </button>

          <button
            className={`nav-item ${page === 'inventory' ? 'active' : ''}`}
            onClick={() => navigate('inventory')}
          >
            <Box size={18} />
            <span>Inventory & Transport</span>
          </button>

          <button
            className={`nav-item ${page === 'evidence' ? 'active' : ''}`}
            onClick={() => navigate('evidence')}
          >
            <FileText size={18} />
            <span>Data & Evidence</span>
            {anomaliesCount + queueCount > 0 ? (
              <span className="nav-badge warning">{anomaliesCount + queueCount}</span>
            ) : null}
          </button>

          <button
            className={`nav-item ${page === 'collaboration' ? 'active' : ''}`}
            onClick={() => navigate('collaboration')}
          >
            <Users size={18} />
            <span>Collaboration</span>
            {openTasksCount > 0 ? (
              <span className="nav-badge info">{openTasksCount}</span>
            ) : null}
          </button>

          <button
            className={`nav-item ${page === 'history' ? 'active' : ''}`}
            onClick={() => navigate('history')}
          >
            <Clock size={18} />
            <span>Decision History</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="clock-indicator">
            <Clock size={13} />
            <span>{formatTime(state.clock)} UTC</span>
          </div>
          <div className="version-pill">
            <span>Workspace v{state.version}</span>
          </div>
        </div>
      </aside>

      {/* Main Area */}
      <div className="main-area">
        {/* Top Bar */}
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-title">
              <span className="topbar-logo-text">DisruptionIQ</span>
              <span className="topbar-divider">/</span>
              <span className="topbar-subtext">From delivery delays to recovery plans</span>
            </div>
          </div>

          <div className="topbar-center">
            {/* Status indicators */}
            <div className="status-indicators">
              {activeIncidents.length > 0 ? (
                <span className="status-pill status-pill-alert" title={`${activeIncidents.length} active disruptions`}>
                  <AlertTriangle size={13} />
                  <span>{activeIncidents.length} active disruptions</span>
                </span>
              ) : (
                <span className="status-pill status-pill-success" title="All incidents resolved">
                  <CheckCircle2 size={13} />
                  <span>Disruptions: 0 active</span>
                </span>
              )}

              <span
                className={`status-pill ${state.integrationOutage ? 'status-pill-outage' : 'status-pill-online'}`}
                title={state.integrationOutage ? 'Carrier integration is down; events queued' : 'Integration online'}
              >
                {state.integrationOutage ? <WifiOff size={13} /> : <Wifi size={13} />}
                <span>{state.integrationOutage ? 'Outage' : 'Online'}</span>
              </span>

              <span
                className={`status-pill ${data.aiConfigured ? 'status-pill-ai-ready' : 'status-pill-ai-disabled'}`}
                title={data.aiConfigured ? 'AI assessment enabled' : 'AI provider not configured'}
              >
                <Sparkles size={13} />
                <span>{data.aiConfigured ? 'AI Ready' : 'AI Not Configured'}</span>
              </span>

              <span className="status-pill status-pill-db" title={`Storage mode: ${data.database}`}>
                <Database size={13} />
                <span>{data.database}</span>
              </span>
            </div>
          </div>

          <div className="topbar-right">
            {/* Scenario buttons */}
            {canRunScenarios ? (
              <div className="scenario-controls">
                <button
                  type="button"
                  className="button secondary small scenario-button"
                  disabled={command.isPending}
                  onClick={() =>
                    execute(
                      { path: '/scenarios', body: { scenario: 'A' } },
                      'Scenario A executed: Shared supplier delay and warehouse outage triggered.',
                    )
                  }
                  title="Scenario A: delay and warehouse outage across multi-tier supplier paths"
                >
                  <Play size={13} />
                  <span>Scenario A (Delay + Outage)</span>
                </button>

                <button
                  type="button"
                  className="button secondary small scenario-button"
                  disabled={command.isPending}
                  onClick={() =>
                    execute(
                      { path: '/scenarios', body: { scenario: 'B' } },
                      'Scenario B executed: Cold-chain temperature excursion, document mismatch, and carrier outage triggered.',
                    )
                  }
                  title="Scenario B: temperature excursion, document mismatch, and carrier outage"
                >
                  <Play size={13} />
                  <span>Scenario B (Quality + Doc + Outage)</span>
                </button>
              </div>
            ) : null}

            {canReset ? (
              <button
                type="button"
                className="button secondary small reset-button"
                disabled={command.isPending}
                onClick={() => open({ type: 'reset' })}
                title="Reset synthetic workspace"
              >
                <RotateCcw size={13} />
                <span>Reset Demo</span>
              </button>
            ) : null}

            {/* Active User Chip */}
            <div className="user-chip">
              <span className="user-avatar">{actor.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</span>
              <div className="user-details">
                <span className="user-name">{actor.name}</span>
                <span className="user-role">{roleLabels[actor.role] || actor.role}</span>
              </div>
              <span className={`org-chip ${actor.orgId}`}>{actor.orgId}</span>
            </div>

            {/* Logout button */}
            <button
              type="button"
              className="icon-button logout-button"
              onClick={handleLogout}
              title="Sign out of DisruptionIQ"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        {/* Command Toast Feedback */}
        {commandSuccess ? (
          <div className="toast-banner toast-success" role="status">
            <CheckCircle2 size={17} />
            <span>{commandSuccess}</span>
            <button
              type="button"
              className="icon-button toast-close"
              aria-label="Dismiss notification"
              onClick={() => setCommandSuccess(undefined)}
            >
              <X size={15} />
            </button>
          </div>
        ) : null}

        {commandError ? (
          <div className="toast-banner toast-error" role="alert">
            <AlertTriangle size={17} />
            <span>{commandError}</span>
            <button
              type="button"
              className="icon-button toast-close"
              aria-label="Dismiss error"
              onClick={() => setCommandError(undefined)}
            >
              <X size={15} />
            </button>
          </div>
        ) : null}

        {/* Main Content Area */}
        <main className="content-container">
          {page === 'overview' && <Overview {...viewProps} />}
          {page === 'incidents' && <Incidents {...viewProps} selectedId={selectedIncidentId} />}
          {page === 'network' && <Network {...viewProps} />}
          {page === 'inventory' && <Inventory {...viewProps} />}
          {page === 'evidence' && <Evidence {...viewProps} />}
          {page === 'collaboration' && <Collaboration {...viewProps} />}
          {page === 'history' && <History {...viewProps} />}
        </main>
      </div>

      {/* Workflow Dialogs */}
      {dialog ? (
        <WorkflowDialog
          {...viewProps}
          dialog={dialog}
          close={() => setDialog(undefined)}
          error={commandError}
        />
      ) : null}
    </div>
  );
}
