import type { State, Actor } from '../../src/shared/types';
import { createSeedState } from './enterprise';
import { runScenario } from './scenarios';

export function buildRichSeedState(now = new Date('2026-10-30T06:00:00Z')): State {
  return createSeedState(now);
}

export function buildScenarioAState(now = new Date('2026-10-30T06:00:00Z')): State {
  const state = createSeedState(now);
  const analyst: Actor = { id: 'analyst-1', name: 'Alex Rivera', email: 'analyst@disruptioniq.demo', role: 'analyst', orgId: 'focal' };
  runScenario(state, 'A', analyst);
  return state;
}

export function buildScenarioBState(now = new Date('2026-10-30T06:00:00Z')): State {
  const state = createSeedState(now);
  const analyst: Actor = { id: 'analyst-1', name: 'Alex Rivera', email: 'analyst@disruptioniq.demo', role: 'analyst', orgId: 'focal' };
  runScenario(state, 'B', analyst);
  return state;
}
