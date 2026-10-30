import { test, expect, type Page } from '@playwright/test';

async function loginAs(page: Page, demoAccountText: string) {
  await page.goto('/');
  await page.waitForSelector('.login-card, .app-shell');
  if (await page.locator('.app-shell').isVisible()) {
    await page.locator('.logout-button').click();
    await expect(page.locator('.login-card')).toBeVisible();
  }
  const pill = page.locator('.demo-account-card').filter({ hasText: demoAccountText });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

test.describe.serial('DisruptionIQ End-to-End Operational Workflows', () => {
  test.beforeAll(async ({ request }) => {
    // Reset workspace to clean seed state before running workflow tests
    await request.post('/api/login', {
      data: { email: 'admin@disruptioniq.local', password: 'disruption-demo' },
    });
    await request.post('/api/reset', { data: {} });
  });

  test('a. Authentication and Demo Login', async ({ page }) => {
    // 1. Navigate to /
    await page.goto('/');

    // Ensure logged out for a clean test of login screen
    await page.waitForSelector('.login-card, .app-shell');
    if (await page.locator('.app-shell').isVisible()) {
      await page.locator('.logout-button').click();
    }

    // 2. Sees login screen
    await expect(page.locator('.login-card')).toBeVisible();
    await expect(page.locator('.login-header h1')).toHaveText('DisruptionIQ');
    await expect(page.locator('.login-sub')).toHaveText('From delivery delays to recovery plans');
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();

    // 3. Clicks "Operations Analyst" demo pill
    const analystPill = page.locator('.demo-account-card').filter({ hasText: 'Operations Analyst' });
    await expect(analystPill).toBeVisible();
    await analystPill.click();

    // 4. Verifies redirected to operational dashboard, showing user chip "Alex Rivera" and role "Operations Analyst"
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.user-chip')).toBeVisible();
    await expect(page.locator('.user-chip .user-name')).toHaveText('Alex Rivera');
    await expect(page.locator('.user-chip .user-role')).toHaveText('Operations Analyst');
    await expect(page.locator('.user-chip .org-chip')).toHaveText('focal');
  });

  test('b. Scenario A Workflow (Shared Delay + Outage & Separation of Duties)', async ({ page }) => {
    // Ensure logged in as Operations Analyst
    await loginAs(page, 'Operations Analyst');

    // 1. Clicks "Scenario A (Delay + Outage)"
    const scenarioABtn = page.getByRole('button', { name: /Scenario A \(Delay \+ Outage\)/i });
    await expect(scenarioABtn).toBeVisible();
    await scenarioABtn.click();

    // Verify notification toast
    await expect(page.locator('.toast-banner.toast-success')).toBeVisible();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Scenario A executed');

    // 2. Verifies active incidents appear in incident workspace (e.g., supplier delay, warehouse outage)
    await expect(page.locator('.status-pill-alert')).toBeVisible();

    // Navigate to Incidents view
    await page.getByRole('button', { name: /Incidents & Recovery/i }).click();
    await expect(page.locator('.incident-list .incident-row').first()).toBeVisible();

    // Select the first incident
    await page.locator('.incident-list .incident-row').first().click();

    // 3. Clicks "Generate recovery options" (or Recalculate options)
    const generateBtn = page.getByRole('button', { name: /(Generate recovery options|Recalculate options)/i });
    await expect(generateBtn).toBeVisible();
    await generateBtn.click();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Recovery options generated');

    // 4. Verifies all 4 options generated with constraint validation (reallocate, expedite, alternative supplier, split order)
    expect(await page.locator('.plan-card').count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole('heading', { name: 'Reallocate inventory' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Expedite shipment' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alternative supplier' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Split customer order' }).first()).toBeVisible();

    // Verify constraint validation is displayed
    const feasibilityBadges = page.locator('.plan-card .feasibility');
    await expect(feasibilityBadges.first()).toBeVisible();

    // 5. Tests plan modification: modifies quantity of a proposed plan that passes constraints
    const modifiableCard = page.locator('.plan-card').filter({ hasText: 'Passes current constraints' }).first();
    await expect(modifiableCard).toBeVisible();
    await modifiableCard.getByRole('button', { name: 'Modify' }).click();

    // Modal opens
    await expect(page.locator('.modal h2')).toContainText('Modify recovery quantity');
    const qtyInput = page.locator('.modal input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('60');
    await page.locator('.modal button[type="submit"]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Proposal modified and revalidated');

    // 6. Verifies separation of duties: Analyst cannot self-approve the plan
    // As the modifier and as an analyst, Review & confirm is not permitted
    await expect(modifiableCard.locator('.permission-note')).toBeVisible();
    await expect(modifiableCard.getByRole('button', { name: 'Review & confirm' })).toHaveCount(0);

    // 7. Logs out and logs in as "Supply Chain Manager" (manager@disruptioniq.local)
    await loginAs(page, 'Supply Chain Manager');
    await expect(page.locator('.user-chip .user-name')).toHaveText('Priya Sharma');

    // 8. Approves and executes the modified plan with explicit confirmation check
    await page.getByRole('button', { name: /Incidents & Recovery/i }).click();
    await page.locator('.incident-list .incident-row').first().click();

    const reviewConfirmCard = page.locator('.plan-card').filter({ hasText: 'Review & confirm' }).first();
    await expect(reviewConfirmCard).toBeVisible();
    await reviewConfirmCard.getByRole('button', { name: 'Review & confirm' }).click();

    // Confirmation modal check
    await expect(page.locator('.modal h2')).toContainText('Confirm simulated recovery');
    const submitBtn = page.locator('.modal button[type="submit"]');
    await expect(submitBtn).toBeDisabled();

    // Check explicit confirmation checkbox
    await page.locator('.modal input[type="checkbox"]').check();
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Recovery approved and simulated execution recorded');

    // 9. Verifies plan moves to executed status, order updates, and audit trail records execution
    await expect(page.locator('.plan-card').filter({ hasText: 'executed' })).toBeVisible();

    // Navigate to Decision History to verify execution record
    await page.locator('.sidebar-nav button', { hasText: 'Decision History' }).click();
    await expect(page.locator('.audit-content').filter({ hasText: /plan executed/i }).first()).toBeVisible();
  });

  test('c. Scenario B Workflow (Condition Excursion, Document Discrepancy & Outage Replay)', async ({ page }) => {
    // Ensure logged in as Supply Chain Manager (or Analyst) who can trigger scenarios
    await loginAs(page, 'Supply Chain Manager');

    // 1. Runs Scenario B
    const scenarioBBtn = page.getByRole('button', { name: /Scenario B \(Quality \+ Doc \+ Outage\)/i });
    await expect(scenarioBBtn).toBeVisible();
    await scenarioBBtn.click();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Scenario B executed');

    // 2. Verifies condition excursion and document claim appear
    // Navigate to Inventory & Transport: verifies quarantined lot and condition excursion
    await page.getByRole('button', { name: /Inventory & Transport/i }).click();
    await expect(page.locator('.condition-card.excursion')).toBeVisible();
    await expect(page.locator('.condition-card.excursion')).toContainText('37°C');
    await expect(page.locator('tr').filter({ hasText: 'quarantined' }).first()).toBeVisible();

    // 3. Logs in as Warehouse Operator (warehouse@disruptioniq.local)
    await loginAs(page, 'Warehouse Operator');
    await expect(page.locator('.user-chip .user-name')).toHaveText('Kabir Rao');

    // 4. Navigates to Data & Evidence: confirms reviewed freight document
    await page.getByRole('button', { name: /Data & Evidence/i }).click();
    const docCard = page.locator('.document-card').filter({ hasText: 'synthetic-atlas-manifest.txt' });
    await expect(docCard).toBeVisible();
    await docCard.getByRole('button', { name: 'Confirm reviewed claim' }).click();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Document review confirmed');
    await expect(docCard).toContainText('Reviewed by Kabir Rao');

    // 5. Toggles integration outage, captures an event, restores integration, and replays queue
    // Outage management requires manager or admin
    await loginAs(page, 'Supply Chain Manager');
    await page.getByRole('button', { name: /Data & Evidence/i }).click();

    // Verify outage is active in Scenario B
    await expect(page.locator('.continuity-banner.outage')).toBeVisible();

    // Capture an operational event during outage
    await page.getByRole('button', { name: 'Capture event' }).click();
    await expect(page.locator('.modal h2')).toContainText('Capture an operational event');
    await page.locator('.modal-footer button.primary').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Event captured');

    // Restore integration
    const restoreBtn = page.getByRole('button', { name: 'Restore integration' });
    await expect(restoreBtn).toBeVisible();
    await restoreBtn.click();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Integration restored');

    // Replay queue
    const replayBtn = page.getByRole('button', { name: 'Replay queue' });
    await expect(replayBtn).toBeVisible();
    await replayBtn.click();
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Queued events replayed');
  });

  test('d. Partner Scoping', async ({ page }) => {
    // 1. Logs in as Partner (partner@nexus-components.example)
    await loginAs(page, 'Partner Supplier: Nexus');

    // Verifies partner identity
    await expect(page.locator('.user-chip .user-name')).toHaveText('Maya Chen');
    await expect(page.locator('.user-chip .org-chip')).toHaveText('partner');

    // 2. Verifies internal controls, orders, and stock are hidden/redacted
    // Header controls for running scenarios and reset are hidden
    await expect(page.locator('.scenario-controls')).toHaveCount(0);
    await expect(page.locator('.reset-button')).toHaveCount(0);

    // Collaboration view shows scoped incident tasks
    await page.getByRole('button', { name: /Collaboration/i }).click();
    await expect(page.locator('.task-card').first()).toBeVisible();

    // Inventory view: internal lots are redacted/empty (usable stock is 0)
    await page.getByRole('button', { name: /Inventory & Transport/i }).click();
    await expect(page.locator('.mini-metrics strong').first()).toHaveText('0');

    // Overview: internal customer orders at risk are empty
    await page.getByRole('button', { name: /Overview/i }).click();
    await expect(page.getByText('No exposed customer orders')).toBeVisible();
  });

  test('e. Demo Reset', async ({ page }) => {
    // 1. Logs in as Admin (admin@disruptioniq.local)
    await loginAs(page, 'Administrator');

    // 2. Executes demo reset
    const resetBtn = page.locator('.reset-button');
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    // Modal with explicit confirmation
    await expect(page.locator('.modal h2')).toContainText('Reset the synthetic workspace');
    const resetSubmitBtn = page.locator('.modal button.danger');
    await expect(resetSubmitBtn).toBeDisabled();

    await page.locator('.modal input[type="checkbox"]').check();
    await expect(resetSubmitBtn).toBeEnabled();
    await resetSubmitBtn.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.toast-banner.toast-success')).toContainText('Synthetic workspace reset');

    // 3. Verifies workspace returns to seed state (0 active disruptions)
    await expect(page.locator('.status-pill-success')).toContainText('Disruptions: 0 active');

    // 4. Verifies audit trail retains demo reset decision
    await page.locator('.sidebar-nav button', { hasText: 'Decision History' }).click();
    await expect(page.locator('.audit-content').filter({ hasText: /demo reset/i }).first()).toBeVisible();
  });
});
