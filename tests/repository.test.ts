import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Repository } from '../src/server/repository';
import * as schema from '../src/server/schema';
import { hashPassword, verifyPassword } from '../src/server/auth';
import { buildRichSeedState } from './fixtures/demo-scenarios';
process.env.DEMO_MODE = 'true';

describe('PostgreSQL persistence and atomic changes', () => {
  const repo = new Repository();
  beforeAll(async () => {
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildRichSeedState()));
  }, 30000);
  afterAll(async () => { await repo.close(); });
  test('links survive a read and a failed transaction leaves state unchanged', async () => {
    const before = await repo.read();
    expect(before.shipments.every(s => before.suppliers.some(x => x.id === s.supplierId))).toBe(true);
    await expect(repo.mutate(s => { s.lots[0]!.reserved = s.lots[0]!.quantity + 1; })).rejects.toThrow();
    expect((await repo.read()).lots[0]!.reserved).toBe(before.lots[0]!.reserved);
  });
  test('concurrent mutations see current stock and cannot allocate it twice', async () => {
    await repo.mutate(s => { s.lots[0]!.quantity = 50; s.lots[0]!.reserved = 0; });
    const reserve = () => repo.mutate(s => {
      const lot = s.lots[0]!;
      if (lot.quantity - lot.reserved < 40) throw new Error('Insufficient stock');
      lot.reserved += 40; return lot.reserved;
    });
    const results = await Promise.allSettled([reserve(),reserve()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.read()).lots[0]!.reserved).toBe(40);
  });
  test('projections reconcile removed normalized rows when state entities are deleted', async () => {
    // Insert a lot via state mutation
    await repo.mutate(s => {
      s.lots.push({ id: 'temp-lot-1', itemId: 'controller', name: 'Temp Lot', warehouseId: s.warehouses[0]!.id, quantity: 15, reserved: 0, status: 'available', version: 1 });
    });
    const rowsBefore = await (repo as any).db.select().from(schema.inventoryLots).where(eq(schema.inventoryLots.id, 'temp-lot-1'));
    expect(rowsBefore).toHaveLength(1);

    // Remove the lot via state mutation
    await repo.mutate(s => {
      s.lots = s.lots.filter(l => l.id !== 'temp-lot-1');
    });
    const rowsAfter = await (repo as any).db.select().from(schema.inventoryLots).where(eq(schema.inventoryLots.id, 'temp-lot-1'));
    expect(rowsAfter).toHaveLength(0);
  });
  test('password hashes are salted and sessions authenticate server-side', async () => {
    const hash = hashPassword('correct-password');
    expect(hash).not.toContain('correct-password');
    expect(verifyPassword('correct-password',hash)).toBe(true);
    expect(verifyPassword('incorrect-password',hash)).toBe(false);
    await repo.createSession('test-token','analyst-1');
    expect((await repo.actorForSession('test-token'))?.role).toBe('analyst');
    expect(await repo.actorForSession('wrong-token')).toBeNull();
    await repo.deleteSession('test-token');
    expect(await repo.actorForSession('test-token')).toBeNull();
  });
  test('agent execution logs persist, sort descending, and filter by feature', async () => {
    await repo.saveAgentLog({
      id: 'log-1',
      timestamp: '2026-10-31T01:00:00.000Z',
      agent: 'triage',
      feature: 'incidents',
      action: 'triage_incident',
      accessedEntities: ['inc-1', 'order-1'],
      actorId: 'analyst-1',
      summary: 'Triaged incident inc-1',
      status: 'success',
      latencyMs: 120,
      model: 'gemini-2.5-flash',
    });

    await repo.saveAgentLog({
      id: 'log-2',
      timestamp: '2026-10-31T02:00:00.000Z',
      agent: 'advisor',
      feature: 'plans',
      action: 'evaluate_plan',
      accessedEntities: ['plan-1'],
      summary: 'Advised plan approval',
      status: 'success',
      latencyMs: 250,
      model: 'gemini-2.5-pro',
    });

    await repo.saveAgentLog({
      id: 'log-3',
      timestamp: '2026-10-31T03:00:00.000Z',
      agent: 'copilot',
      feature: 'chat',
      action: 'query_inventory',
      accessedEntities: ['warehouse-1'],
      actorId: 'manager-1',
      summary: 'Answered inventory inquiry',
      status: 'fallback',
      latencyMs: 50,
      model: 'gemini-2.5-flash',
    });

    // All logs sorted descending by timestamp
    const allLogs = await repo.getAgentLogs();
    expect(allLogs.length).toBeGreaterThanOrEqual(3);
    expect(allLogs[0]!.id).toBe('log-3');
    expect(allLogs[1]!.id).toBe('log-2');
    expect(allLogs[2]!.id).toBe('log-1');
    expect(allLogs[0]!.accessedEntities).toEqual(['warehouse-1']);
    expect(allLogs[1]!.actorId).toBeUndefined();
    expect(allLogs[2]!.actorId).toBe('analyst-1');

    // Filter by feature
    const planLogs = await repo.getAgentLogs({ feature: 'plans' });
    expect(planLogs.length).toBe(1);
    expect(planLogs[0]!.id).toBe('log-2');
    expect(planLogs[0]!.feature).toBe('plans');

    // Limit parameter
    const limitedLogs = await repo.getAgentLogs({ limit: 2 });
    expect(limitedLogs.length).toBe(2);
    expect(limitedLogs[0]!.id).toBe('log-3');
    expect(limitedLogs[1]!.id).toBe('log-2');
  });
});
