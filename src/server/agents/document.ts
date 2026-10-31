import type { State, AgentExecutionLog } from '../../shared/types';
import type { Repository } from '../repository';
import type { DocumentChunk } from './bus';
import { callAgentLLM } from './llm';

export interface DocumentReconcilerInput {
  documentId: string;
  chunks: DocumentChunk[];
  state: State;
  repo: Repository;
}

export async function runDocumentReconcilerAgent(input: {
  documentId: string;
  chunks: DocumentChunk[];
  state: State;
  repo: Repository;
}): Promise<AgentExecutionLog> {
  const startTime = performance.now();

  // Scoped data extraction (Least Privilege Principle)
  const claim = input.state.documents.find(d => d.id === input.documentId);
  const targetClaim = claim
    ? {
        id: claim.id,
        filename: claim.filename,
        status: claim.status,
        confidence: claim.confidence,
        fields: claim.fields,
        issues: claim.issues,
        excerpt: claim.excerpt,
      }
    : null;

  // Find matched shipment from claim fields or chunk contents
  const shipmentIdClaim = claim?.fields?.shipmentId;
  let shipment = shipmentIdClaim
    ? input.state.shipments.find(s => s.id === shipmentIdClaim)
    : undefined;

  // Search PGlite table directly if not in active state snapshot
  if (!shipment && shipmentIdClaim) {
    try {
      const dbShipments = await input.repo.searchTable('shipments', shipmentIdClaim);
      if (dbShipments.length > 0) {
        const row = dbShipments[0];
        const match = row?.data || row;
        if (match?.id) shipment = match;
      }
    } catch {
      // Graceful fallback
    }
  }

  if (!shipment && input.chunks.length > 0) {
    shipment = input.state.shipments.find(s =>
      input.chunks.some(c => c.content.includes(s.id))
    );
  }

  const matchedShipment = shipment
    ? {
        id: shipment.id,
        supplierId: shipment.supplierId,
        warehouseId: shipment.warehouseId,
        itemId: shipment.itemId,
        quantity: shipment.quantity,
        status: shipment.status,
        eta: shipment.eta,
      }
    : null;

  const chunksExcerpt = input.chunks.slice(0, 5).map(c => ({
    chunkIndex: c.chunkIndex,
    pageNumber: c.pageNumber,
    charRange: `${c.charStart ?? 0}-${c.charEnd ?? 0}`,
    contentSnippet: c.content.slice(0, 300),
  }));

  const accessedEntities = Array.from(
    new Set([input.documentId, shipment?.id].filter((x): x is string => Boolean(x)))
  );

  // Deterministic reconciliation
  let fallbackSummary: string;
  const claimedQty = claim?.fields?.quantity;
  const expectedQty = shipment?.quantity;

  if (!shipment) {
    fallbackSummary =
      `Freight document ${claim?.filename || input.documentId} processed (${input.chunks.length} chunks extracted). ` +
      `Shipment reference '${shipmentIdClaim || 'unspecified'}' does not match any active operational shipment. Manual operator review required.`;
  } else if (claimedQty !== undefined && expectedQty !== undefined) {
    if (claimedQty === expectedQty) {
      fallbackSummary =
        `Reconciliation confirmed for shipment ${shipment.id}: Extracted freight quantity (${claimedQty}) ` +
        `matches expected shipment baseline (${expectedQty} units) with 100% agreement. Document status: ${claim?.status || 'processing'}.`;
    } else {
      const variance = claimedQty - expectedQty;
      fallbackSummary =
        `Reconciliation variance flagged for shipment ${shipment.id}: Document claims ${claimedQty} units vs ` +
        `expected ${expectedQty} units (variance of ${variance > 0 ? `+${variance}` : `${variance}`} units). Investigation required before delivery sign-off.`;
    }
  } else {
    fallbackSummary =
      `Document matched to shipment ${shipment.id} (baseline: ${expectedQty} units), but no explicit quantity ` +
      `could be verified from extracted text. Document status: ${claim?.status || 'review'}.`;
  }

  let summary = fallbackSummary;
  let status: 'success' | 'fallback' = 'fallback';
  let model = 'deterministic-reconciler';

  // Grounded LLM reasoning when API key is provided
  const llmRes = await callAgentLLM({
    systemPrompt:
      'You are the DisruptionIQ Document Reconciler Agent. Reconcile freight documentation (bills of lading, packing lists, delivery receipts) against expected operational shipment records. Compare claimed quantities, dates, and freight notes. Highlight discrepancies, damage notations, or overages/shortages strictly based on the provided facts.',
    userPrompt: JSON.stringify({
      targetClaim,
      matchedShipment,
      chunksExcerpt,
    }),
  });

  if (llmRes) {
    summary = llmRes.text;
    status = 'success';
    model = llmRes.model;
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

  const log: AgentExecutionLog = {
    id: crypto.randomUUID(),
    timestamp: input.state.clock || new Date().toISOString(),
    agent: 'reconciler',
    feature: 'documents',
    action: 'reconcile_freight_document',
    accessedEntities,
    summary,
    status,
    latencyMs,
    model,
  };

  await input.repo.saveAgentLog(log);
  return log;
}
