import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/client/App';
import { ApiError } from '../src/client/api';
import { AiCopilotDrawer } from '../src/client/components/ai-copilot';
import { WorkflowDialog } from '../src/client/components/forms';
import { createEmptyState } from '../src/domain/seed';

async function renderFailedDashboard(status: number, demo = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } } });
  if (demo) client.setQueryData(['demo-users'], { users: [{ id: 'configured-analyst', name: 'Configured Analyst', email: 'configured@example.test', role: 'analyst', orgId: 'focal' }], demoPassword: 'demo-password' });
  await client.fetchQuery({ queryKey: ['dashboard'], queryFn: () => Promise.reject(new ApiError('Service unavailable', status)) }).catch(() => {});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  client.clear();
  return html;
}

describe('dashboard loading and login states', () => {
  test('server failures show a retryable error instead of the login screen', async () => {
    const html = await renderFailedDashboard(503);
    expect(html).toContain('Unable to load operational dashboard');
    expect(html).not.toContain('login-card');
  });
  test('private login does not advertise demo credentials or accounts', async () => {
    const html = await renderFailedDashboard(401);
    expect(html).toContain('login-card');
    expect(html).not.toContain('demo-account-card');
    expect(html).not.toContain('disruption-demo');
    expect(html).not.toContain('analyst@disruptioniq.demo');
  });
  test('enabled demo login retains account switching', async () => {
    expect(await renderFailedDashboard(401, true)).toContain('demo-account-card');
  });
  test('demo sign-in cards use the identities returned by the server', async () => {
    const html = await renderFailedDashboard(401, true);
    expect(html).toContain('Configured Analyst');
    expect(html).toContain('configured@example.test');
    expect(html).not.toContain('Alex Rivera');
    expect(html).not.toContain('Nexus');
  });
  test('copilot suggestions do not reference a nonexistent sample shipment', () => {
    const actor = { id: 'operator', name: 'Operator', email: 'operator@example.test', role: 'analyst', orgId: 'focal' } as const;
    const html = renderToStaticMarkup(<AiCopilotDrawer isOpen onClose={() => {}} navigate={() => {}} activePage="overview" actor={actor}/>);
    expect(html).not.toContain('shipment-atlas');
  });
  test('event intake requires an explicit payload rather than prefilling synthetic values', () => {
    const client = new QueryClient();
    const actor = { id: 'operator', name: 'Operator', email: 'operator@example.test', role: 'analyst', orgId: 'focal' } as const;
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><WorkflowDialog
      dialog={{ type: 'event' }} close={() => {}} pending={false} open={() => {}} navigate={() => {}} execute={async () => true}
      data={{ actor, users: [actor], state: createEmptyState(), impacts: [], aiConfigured: false, database: 'test' }}
    /></QueryClientProvider>);
    expect(html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]).toBe('');
    client.clear();
  });
});
