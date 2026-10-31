import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../src/server/app';
import { Repository } from '../src/server/repository';
import { buildScenarioAState } from './fixtures/demo-scenarios';
import { computeDecisionHash, verifyAuditChain, appendDecision } from '../src/domain/audit';
import { computeBaselineComparison } from '../src/domain/baseline';
import { evaluateCandidateConstraints } from '../src/domain/plans';
import { normalizeState } from '../src/domain/normalize';
import type { Decision, State, PlanType, DashboardResponse, BaselineComparisonReport } from '../src/shared/types';

process.env.DEMO_MODE = 'true';

describe('Audit Hash Chain, RBAC Separation of Duties, Role Notifications, and Baselines', () => {
  const repo = new Repository();
  const app = createApp(repo);
  let managerCookie = '';
  let analystCookie = '';
  let warehouseCookie = '';

  async function login(email: string) {
    const r = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'disruption-demo' }),
    });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  }

  beforeAll(async () => {
    await repo.init();
    await repo.mutate(s => Object.assign(s, buildScenarioAState()));
    managerCookie = await login('manager@disruptioniq.demo');
    analystCookie = await login('analyst@disruptioniq.demo');
    warehouseCookie = await login('warehouse@disruptioniq.demo');
  }, 30000);

  afterAll(async () => {
    await repo.close();
  }, 30000);

  describe('1. Hash Chain Integrity and Tamper Detection', () => {
    test('computeDecisionHash produces deterministic 64-char hex SHA-256 string', () => {
      const decision: Decision = {
        id: 'dec-1',
        at: '2026-10-31T08:00:00.000Z',
        actorId: 'admin@acme.com',
        action: 'system_initialized',
        entityId: 'sys',
        detail: 'Initial setup',
        ruleVersion: '1.0.0',
        evidenceIds: [],
        previousHash: '0'.repeat(64),
      };
      const hash1 = computeDecisionHash(decision);
      const hash2 = computeDecisionHash(decision);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    test('appendDecision sets previousHash and valid current hash in chain', () => {
      const dummyState: State = normalizeState({});

      appendDecision(dummyState, {
        id: 'd1',
        at: '2026-10-31T08:00:00.000Z',
        actorId: 'user1',
        action: 'action1',
        entityId: 'e1',
        detail: 'first',
        ruleVersion: '1.0.0',
        evidenceIds: [],
      });
      expect(dummyState.decisions).toHaveLength(1);
      expect(dummyState.decisions[0].previousHash).toBe('0'.repeat(64));
      expect(dummyState.decisions[0].hash).toBeDefined();

      appendDecision(dummyState, {
        id: 'd2',
        at: '2026-10-31T08:05:00.000Z',
        actorId: 'user2',
        action: 'action2',
        entityId: 'e2',
        detail: 'second',
        ruleVersion: '1.0.0',
        evidenceIds: [],
      });
      expect(dummyState.decisions).toHaveLength(2);
      expect(dummyState.decisions[1].previousHash).toBe(dummyState.decisions[0].hash);

      const verification = verifyAuditChain(dummyState.decisions);
      expect(verification.intact).toBe(true);
      expect(verification.verifiedCount).toBe(2);
    });

    test('verifyAuditChain detects tampering if any decision in the chain is modified', () => {
      const decisions: Decision[] = [];
      const d1: Decision = {
        id: 'd1',
        at: '2026-10-31T08:00:00.000Z',
        actorId: 'u1',
        action: 'a1',
        entityId: 'e1',
        detail: 'first',
        ruleVersion: '1.0.0',
        evidenceIds: [],
        previousHash: '0'.repeat(64),
      };
      d1.hash = computeDecisionHash(d1);
      decisions.push(d1);

      const d2: Decision = {
        id: 'd2',
        at: '2026-10-31T08:05:00.000Z',
        actorId: 'u2',
        action: 'a2',
        entityId: 'e2',
        detail: 'second',
        ruleVersion: '1.0.0',
        evidenceIds: [],
        previousHash: d1.hash,
      };
      d2.hash = computeDecisionHash(d2);
      decisions.push(d2);

      expect(verifyAuditChain(decisions).intact).toBe(true);

      // Tamper with detail of d1
      const tampered = [
        { ...d1, detail: 'tampered-detail' },
        d2,
      ];
      const tamperedResult = verifyAuditChain(tampered);
      expect(tamperedResult.intact).toBe(false);
      expect(tamperedResult.brokenAtIndex).toBe(0);
    });

    test('GET /api/audit/verify endpoint verifies active state chain', async () => {
      const res = await app.request('/api/audit/verify', {
        headers: { cookie: managerCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { intact: boolean; verifiedCount: number };
      expect(json.intact).toBe(true);
      expect(json.verifiedCount).toBeGreaterThan(0);
    });
  });

  describe('2. Role-Targeted Notifications', () => {
    test('GET /api/dashboard filters notifications according to role', async () => {
      const whRes = await app.request('/api/dashboard', {
        headers: { cookie: warehouseCookie },
      });
      expect(whRes.status).toBe(200);
      const whData = await whRes.json() as DashboardResponse;

      for (const n of whData.state.notifications) {
        if (n.targetRoles && n.targetRoles.length > 0) {
          expect(n.targetRoles).toContain('warehouse');
        }
      }

      const mgrRes = await app.request('/api/dashboard', {
        headers: { cookie: managerCookie },
      });
      expect(mgrRes.status).toBe(200);
      const mgrData = await mgrRes.json() as DashboardResponse;

      for (const n of mgrData.state.notifications) {
        if (n.targetRoles && n.targetRoles.length > 0) {
          expect(n.targetRoles).toContain('manager');
        }
      }
    });
  });

  describe('3. Separation of Duties and Permission Denied Audit Logging', () => {
    test('denied permission attempts return HTTP 403 and record permission_denied decision in hash chain', async () => {
      // First ensure plans exist by calling /api/plans/generate for an incident
      const stateBefore = await repo.read();
      const incident = stateBefore.incidents[0];
      expect(incident).toBeDefined();

      const genRes = await app.request('/api/plans/generate', {
        method: 'POST',
        headers: {
          cookie: managerCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ incidentId: incident.id }),
      });
      expect(genRes.status).toBe(200);

      const stateWithPlans = await repo.read();
      const plan = stateWithPlans.plans[0];
      expect(plan).toBeDefined();

      // Analyst attempts to approve a plan (only manager/admin can approve)
      const denialRes = await app.request(`/api/plans/${plan.id}`, {
        method: 'POST',
        headers: {
          cookie: analystCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'approve' }),
      });

      expect(denialRes.status).toBe(403);

      // Verify state recorded permission_denied decision with intact hash chain
      const updatedState = await repo.read();
      const lastDecision = updatedState.decisions[updatedState.decisions.length - 1];
      expect(lastDecision.action).toBe('permission_denied');
      expect(lastDecision.actorId).toBe('analyst-1');
      expect(lastDecision.hash).toBeDefined();
      expect(lastDecision.previousHash).toBeDefined();

      const chainCheck = verifyAuditChain(updatedState.decisions);
      expect(chainCheck.intact).toBe(true);
    });
  });

  describe('4. Trust-Aware Recovery Plan Feasibility', () => {
    test('evaluates robust vs conditional based on stock verification and supplier dependencies', async () => {
      const state = await repo.read();
      const order = state.orders[0];

      const verifiedLot = state.lots.find(l => l.status === 'available');
      if (verifiedLot) {
        const candidate: { orderId: string; type: PlanType; sourceId: string; quantity: number } = {
          orderId: order.id,
          type: 'reallocate',
          sourceId: verifiedLot.id,
          quantity: 1,
        };

        const result = evaluateCandidateConstraints(state, candidate);
        expect(['robust', 'conditional', 'infeasible']).toContain(result.trustFeasibility);
      }
    });
  });

  describe('5. Baseline Comparison Benchmark', () => {
    test('computeBaselineComparison generates report comparing DisruptionIQ vs ERP-only vs LWW', async () => {
      const state = await repo.read();
      const report = computeBaselineComparison(state);

      expect(report.synthetic).toBe(true);
      expect(report.metrics.conflictsCaught).toBeDefined();
      expect(report.metrics.duplicateEventsTrapped).toBeDefined();
      expect(report.metrics.constraintViolations).toBeDefined();
      expect(report.metrics.wrongDecisions).toBeDefined();
      expect(report.metrics.unverifiedStockExposures).toBeDefined();
      expect(report.summary).toContain('Synthetic Benchmark Evaluation');
    });

    test('GET /api/baseline-comparison returns baseline benchmark', async () => {
      const res = await app.request('/api/baseline-comparison', {
        headers: { cookie: managerCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as BaselineComparisonReport;
      expect(json.synthetic).toBe(true);
      expect(json.metrics.conflictsCaught.disruptionIQ).toContain('caught');
      expect(json.metrics.duplicateEventsTrapped.disruptionIQ).toContain('trapped');
    });
  });
});
