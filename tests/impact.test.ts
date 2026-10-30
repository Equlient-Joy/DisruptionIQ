import { describe, expect, test } from 'bun:test';
import { createSeedState } from '../src/domain/seed';
import { runScenario } from '../src/domain/engine';
import { getImpact } from '../src/domain/impact';
import type { Actor, Order } from '../src/shared/types';

const analyst: Actor = { id: 'analyst-1', name: 'Analyst', email: 'a@test', role: 'analyst', orgId: 'focal' };

describe('interaction-aware impact assessment', () => {
  test('score is strictly bounded 0.0-10.0 with 1 decimal place and correct risk bands', () => {
    const state = createSeedState(new Date('2026-10-30T06:00:00Z'));
    runScenario(state, 'A', analyst);
    const impacts = getImpact(state);

    expect(impacts.length).toBeGreaterThan(0);
    for (const impact of impacts) {
      expect(impact.score).toBeGreaterThanOrEqual(0);
      expect(impact.score).toBeLessThanOrEqual(10);
      // Check 1 decimal place
      const decimalStr = impact.score.toString().split('.')[1] || '';
      expect(decimalStr.length).toBeLessThanOrEqual(1);

      if (impact.score < 4.0) {
        expect(impact.band).toBe('low');
      } else if (impact.score < 7.0) {
        expect(impact.band).toBe('moderate');
      } else if (impact.score < 9.0) {
        expect(impact.band).toBe('high');
      } else {
        expect(impact.band).toBe('critical');
      }
    }
  });

  test('zero shortage strictly yields 0.0 score with zero points for priority, deadline, or penalties', () => {
    const state = createSeedState(new Date('2026-10-30T06:00:00Z'));
    runScenario(state, 'A', analyst);

    // Create an order with critical priority, past deadline, large penalty, but plenty of inventory
    const safeOrder: Order = {
      id: 'order-safe-1',
      customer: 'Critical Client Inc',
      itemId: 'controller',
      warehouseId: 'warehouse-east',
      quantity: 10,
      fulfilled: 0,
      deadline: '2026-10-29T12:00:00Z', // already overdue!
      priority: 'critical',
      penaltyCents: 10_000_000, // $100k penalty!
      status: 'open',
    };
    state.orders.push(safeOrder);
    // Add extra inventory to warehouse-east so safeOrder has 0 shortage
    const lotEast = state.lots.find(l => l.id === 'lot-east');
    if (lotEast) {
      lotEast.quantity += 500;
    }
    // Link safeOrder to the active incident so getImpact evaluates it
    state.incidents[0].affectedOrderIds.push('order-safe-1');

    const impacts = getImpact(state);
    const safeImpact = impacts.find(i => i.orderId === 'order-safe-1');
    expect(safeImpact).toBeDefined();
    expect(safeImpact!.shortage).toBe(0);
    expect(safeImpact!.score).toBe(0.0);
    expect(safeImpact!.band).toBe('low');
    expect(safeImpact!.factorScores?.uncoveredDemand.score).toBe(0.0);
    expect(safeImpact!.factorScores?.deadlinePressure.score).toBe(0.0);
    expect(safeImpact!.factorScores?.recoveryFeasibility.score).toBe(0.0);
    expect(safeImpact!.factorScores?.cascadingExposure.score).toBe(0.0);
    expect(safeImpact!.factorScores?.businessConsequence.score).toBe(0.0);
  });

  test('bottleneck drivers list is capped at maximum 2 entries and full factor breakdown is auditable', () => {
    const state = createSeedState(new Date('2026-10-30T06:00:00Z'));
    runScenario(state, 'A', analyst);
    const impacts = getImpact(state);

    for (const impact of impacts) {
      expect(impact.drivers).toBeDefined();
      expect(impact.drivers!.length).toBeLessThanOrEqual(2);

      expect(impact.factorScores).toBeDefined();
      expect(impact.factorScores?.uncoveredDemand.maxScore).toBe(3.0);
      expect(impact.factorScores?.deadlinePressure.maxScore).toBe(2.0);
      expect(impact.factorScores?.recoveryFeasibility.maxScore).toBe(2.0);
      expect(impact.factorScores?.cascadingExposure.maxScore).toBe(1.5);
      expect(impact.factorScores?.businessConsequence.maxScore).toBe(1.5);
    }
  });

  test('missing or stale ETA evidence lowers confidence without artificially inflating risk score', () => {
    const state = createSeedState(new Date('2026-10-30T06:00:00Z'));
    runScenario(state, 'A', analyst);
    const initialImpacts = getImpact(state);
    const targetOrder = initialImpacts.find(i => i.shortage > 0);
    expect(targetOrder).toBeDefined();
    const initialScore = targetOrder!.score;

    // Simulate stale / missing ETA observations on shipments
    for (const sh of state.shipments) {
      sh.etaHistory = []; // strip observation history
    }

    const modifiedImpacts = getImpact(state);
    const updatedOrder = modifiedImpacts.find(i => i.orderId === targetOrder!.orderId);
    expect(updatedOrder).toBeDefined();

    // Severity should NOT increase just because history is missing
    expect(updatedOrder!.score).toBeLessThanOrEqual(initialScore);
    // But confidence should be reduced
    expect(['medium', 'low']).toContain(updatedOrder!.confidence!);
    expect(updatedOrder!.confidenceReasons?.length).toBeGreaterThan(0);
  });

  test('pure candidate evaluation in getImpact produces zero plan records and zero audit decisions', () => {
    const state = createSeedState(new Date('2026-10-30T06:00:00Z'));
    runScenario(state, 'A', analyst);
    const initialPlansCount = state.plans.length;
    const initialDecisionsCount = state.decisions.length;

    // Call getImpact repeatedly
    getImpact(state);
    getImpact(state);
    getImpact(state);

    expect(state.plans.length).toBe(initialPlansCount);
    expect(state.decisions.length).toBe(initialDecisionsCount);
  });
});
