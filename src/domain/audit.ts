import { createHash } from 'node:crypto';
import type { Decision, State } from '../shared/types';

export const GENESIS_HASH = '0'.repeat(64);

export function computeDecisionHash(decision: {
  id: string;
  at: string;
  actorId: string;
  action: string;
  entityId: string;
  ruleVersion: string;
  detail?: string;
  evidenceIds?: string[];
  previousHash?: string;
}): string {
  const payload = [
    decision.previousHash || GENESIS_HASH,
    decision.id,
    decision.at,
    decision.actorId,
    decision.action,
    decision.entityId,
    decision.ruleVersion,
    decision.detail || '',
    JSON.stringify(decision.evidenceIds || []),
  ].join(':');
  return createHash('sha256').update(payload).digest('hex');
}

export function appendDecision(
  state: State,
  decision: Omit<Decision, 'previousHash' | 'hash'>
): Decision {
  const prevDecision =
    state.decisions.length > 0 ? state.decisions[state.decisions.length - 1] : undefined;
  const previousHash = prevDecision?.hash || GENESIS_HASH;

  const fullDecision: Decision = {
    ...decision,
    previousHash,
    hash: '',
  };
  fullDecision.hash = computeDecisionHash(fullDecision);

  state.decisions.push(fullDecision);
  state.version += 1;
  return fullDecision;
}

export function verifyAuditChain(decisions: Decision[]): {
  intact: boolean;
  verifiedCount: number;
  genesisHash: string;
  latestHash?: string;
  brokenAtIndex?: number;
  error?: string;
} {
  if (!decisions || decisions.length === 0) {
    return {
      intact: true,
      verifiedCount: 0,
      genesisHash: GENESIS_HASH,
    };
  }

  for (let i = 0; i < decisions.length; i++) {
    const curr = decisions[i];
    const expectedPrev = i === 0 ? GENESIS_HASH : decisions[i - 1].hash;

    if (!curr.hash) {
      return {
        intact: false,
        verifiedCount: i,
        genesisHash: GENESIS_HASH,
        brokenAtIndex: i,
        error: `Decision at index ${i} (${curr.id}) is missing cryptographic hash.`,
      };
    }

    if (curr.previousHash !== expectedPrev) {
      return {
        intact: false,
        verifiedCount: i,
        genesisHash: GENESIS_HASH,
        brokenAtIndex: i,
        error: `Broken hash chain at index ${i} (${curr.id}): expected previous hash ${expectedPrev}, found ${curr.previousHash}`,
      };
    }

    const calculatedHash = computeDecisionHash(curr);
    if (curr.hash !== calculatedHash) {
      return {
        intact: false,
        verifiedCount: i,
        genesisHash: GENESIS_HASH,
        brokenAtIndex: i,
        error: `Tampered hash at index ${i} (${curr.id}): computed ${calculatedHash}, found ${curr.hash}`,
      };
    }
  }

  return {
    intact: true,
    verifiedCount: decisions.length,
    genesisHash: GENESIS_HASH,
    latestHash: decisions[decisions.length - 1]?.hash,
  };
}

export function ensureAuditChain(decisions: Decision[]): Decision[] {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d.previousHash || d.previousHash !== prevHash || !d.hash) {
      d.previousHash = prevHash;
      d.hash = computeDecisionHash(d);
    }
    prevHash = d.hash;
  }
  return decisions;
}
