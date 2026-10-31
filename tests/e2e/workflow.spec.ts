import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createSeedState } from '../fixtures/enterprise';

async function loginAs(page: Page, account: string) {
  await page.goto('/');
  await page.locator('.login-card, .app-shell').waitFor();
  if (await page.locator('.app-shell').isVisible()) await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('.demo-account-card').filter({ hasText: account }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function seedWorkspace(request: APIRequestContext) {
  const dashboard = await (await request.get('/api/dashboard')).json();
  const state = createSeedState(new Date(dashboard.state.clock));
  for (const entity of ['suppliers', 'warehouses', 'lots', 'shipments', 'orders'] as const) {
    const response = await request.post('/api/import', { data: { entity, format: 'json', content: JSON.stringify(state[entity]) } });
    expect(response.ok()).toBe(true);
    expect((await response.json()).errors).toEqual([]);
  }
  return state;
}
async function openEvidence(page: Page) {
  await page.getByRole('button', { name: /Data & Evidence/i }).click();
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/login', { data: { email: 'admin@disruptioniq.demo', password: 'disruption-demo' } })).ok()).toBe(true);
  expect((await request.post('/api/reset', { data: {} })).ok()).toBe(true);
});

test('demo login starts with an empty workspace', async ({ page }) => {
  await loginAs(page, 'Operations Analyst');
  await expect(page.locator('.user-name')).toHaveText('Operations Analyst');
  await expect(page.getByText('No exposed customer orders', { exact: true })).toBeVisible();
  await expect(page.locator('.reset-button')).toHaveCount(0);
});
test('server failures display a retryable error', async ({ page }) => {
  await page.route('**/api/dashboard', route => route.fulfill({ status: 503, json: { error: 'Service unavailable' } }));
  await page.goto('/');
  await expect(page.getByText('Unable to load operational dashboard')).toBeVisible();
  await expect(page.locator('.login-card')).toHaveCount(0);
  await page.unroute('**/api/dashboard');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.login-card')).toBeVisible();
});
test('partial import results show rejected rows in the dialog', async ({ page }) => {
  await loginAs(page, 'Operations Analyst');
  await openEvidence(page);
  await page.getByRole('button', { name: 'Import CSV / JSON' }).click();
  const modal = page.locator('.modal');
  await modal.getByLabel('Record type').selectOption('warehouses');
  await modal.getByLabel('Format').selectOption('json');
  await modal.getByLabel('File contents').fill(JSON.stringify([
    { id: 'valid', name: 'Valid Warehouse', region: 'West', capacity: 100, status: 'online' },
    { id: 'invalid', name: 'Invalid Warehouse', region: 'West', capacity: -1, status: 'online' },
  ]));
  await modal.getByRole('button', { name: 'Validate & import' }).click();
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/1 of 2 records accepted/)).toBeVisible();
  await expect(modal.getByText(/Row 2:/)).toBeVisible();
});
test('capture and independently authorize a high-risk recovery', async ({ page, request }) => {
  const state = await seedWorkspace(request);
  await loginAs(page, 'Operations Analyst');
  await openEvidence(page);
  await page.getByRole('button', { name: 'Capture event', exact: true }).click();
  const modal = page.locator('.modal');
  await modal.getByLabel('Entity').selectOption(state.suppliers[0]!.id);
  await modal.getByLabel('Payload · JSON').fill('{"delayHours":24}');
  await modal.getByRole('button', { name: 'Capture event', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: /Incidents & Recovery/i }).click();
  await page.getByRole('button', { name: 'Generate recovery options' }).click();
  for (const name of ['Reallocate inventory', 'Expedite shipment', 'Alternative supplier', 'Split customer order']) {
    await expect(page.getByRole('heading', { name }).first()).toBeVisible();
  }
  const card = page.locator('.plan-card').filter({ has: page.getByRole('heading', { name: 'Expedite shipment' }) }).first();
  await expect(card).toContainText('Passes current constraints');
  await card.getByRole('button', { name: 'Modify', exact: true }).click();
  await modal.locator('input[type=number]').fill('90');
  await modal.getByRole('button', { name: 'Save modified proposal' }).click();
  await expect(modal).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Record 1st approval' })).toHaveCount(0);
  await loginAs(page, 'Supply Chain Manager');
  await page.getByRole('button', { name: /Incidents & Recovery/i }).click();
  await card.getByRole('button', { name: 'Record 1st approval' }).click();
  await expect(modal.getByRole('button', { name: 'Record 1st approval' })).toBeDisabled();
  await modal.locator('input[type=checkbox]').check();
  await modal.getByRole('button', { name: 'Record 1st approval' }).click();
  await expect(card).toContainText('awaiting second approval');
  await loginAs(page, 'Administrator');
  await page.getByRole('button', { name: /Incidents & Recovery/i }).click();
  await card.getByRole('button', { name: 'Confirm 2nd approval & execute' }).click();
  await modal.locator('input[type=checkbox]').check();
  await modal.getByRole('button', { name: 'Confirm & simulate execution' }).click();
  await expect(card).toContainText('executed');
  await page.getByRole('button', { name: 'Decision History', exact: true }).click();
  await expect(page.locator('.audit-content').filter({ hasText: /plan executed/i }).first()).toBeVisible();
});
test('carrier outage and preview preserve queued state until replay', async ({ page, request }) => {
  const state = await seedWorkspace(request);
  await loginAs(page, 'Supply Chain Manager');
  await openEvidence(page);
  const carrier = page.locator('.integration-card').filter({ hasText: 'carrier-api' });
  await carrier.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.continuity-banner.outage')).toBeVisible();
  expect((await request.post('/api/events', { data: { id: 'queued-carrier', source: 'carrier', type: 'shipment_eta', entityId: state.shipments[0]!.id, time: state.clock, payload: { eta: state.shipments[0]!.eta } } })).ok()).toBe(true);
  await page.reload();
  await openEvidence(page);
  await page.route('**/api/integrations/carrier-api/replay', route => route.fulfill({ status: 503, json: { error: 'Replay preview unavailable' } }));
  await carrier.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Replay preview unavailable');
  await page.unroute('**/api/integrations/carrier-api/replay');
  await carrier.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText(/Preview: 1 queued events/)).toBeVisible();
  await expect(carrier).toContainText('1 queued events');
  await carrier.getByRole('button', { name: 'Restore', exact: true }).click();
  await carrier.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(carrier).toContainText('0 queued events');
});
test('procurement uploads documents and can retry failed chunk reads', async ({ page, request }) => {
  const state = await seedWorkspace(request);
  await loginAs(page, 'Procurement Approver');
  await openEvidence(page);
  await page.getByRole('button', { name: 'Upload document' }).click();
  const modal = page.locator('.modal');
  await modal.getByRole('button', { name: 'Paste text' }).click();
  await modal.getByLabel('Source filename').fill('workflow-manifest.txt');
  await modal.getByLabel('Source text').fill('Shipment: ' + state.shipments[0]!.id + '\nQuantity: ' + state.shipments[0]!.quantity + '\nDate: 2026-10-31');
  await modal.getByRole('button', { name: 'Upload & ingest' }).click();
  const doc = page.locator('.document-card');
  await expect(doc.getByRole('button', { name: 'View extracted chunks' })).toBeVisible({ timeout: 15000 });
  await page.route('**/api/documents/*/chunks?*', route => route.fulfill({ status: 503, json: { error: 'Chunk service unavailable' } }));
  await doc.getByRole('button', { name: 'View extracted chunks' }).click();
  await expect(doc.getByRole('alert')).toContainText('Chunk service unavailable');
  await page.unroute('**/api/documents/*/chunks?*');
  await doc.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(doc.getByText(/Chunk #0/)).toBeVisible();
});
test('failed sign out retains the current session and shows the error', async ({ page }) => {
  await loginAs(page, 'Operations Analyst');
  await page.route('**/api/logout', route => route.fulfill({ status: 503, json: { error: 'Sign out unavailable' } }));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Sign out unavailable');
});
test('partner views hide internal controls and activity', async ({ page, request }) => {
  await seedWorkspace(request);
  await loginAs(page, 'Partner Viewer');
  await expect(page.locator('.org-chip.partner')).toHaveText('partner');
  await expect(page.getByText('Autonomous Agent Activity', { exact: true })).toHaveCount(0);
  await openEvidence(page);
  await expect(page.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Capture event', exact: true })).toHaveCount(0);
});
test('administrator clearing requires confirmation and preserves audit', async ({ page, request }) => {
  await seedWorkspace(request);
  await loginAs(page, 'Administrator');
  await page.getByRole('button', { name: 'Clear workspace', exact: true }).click();
  const modal = page.locator('.modal');
  const submit = modal.getByRole('button', { name: 'Clear workspace', exact: true });
  await expect(submit).toBeDisabled();
  await modal.locator('input[type=checkbox]').check();
  await submit.click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: 'Decision History', exact: true }).click();
  await expect(page.locator('.audit-content').filter({ hasText: /demo reset/i }).first()).toBeVisible();
});
