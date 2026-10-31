import { pgTable, text, jsonb, integer, timestamp, index, check, numeric, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { State } from '../shared/types';

export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  state: jsonb('state').$type<State>().notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const users = pgTable('app_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull(),
  orgId: text('org_id').notNull(),
  passwordHash: text('password_hash').notNull(),
});

export const sessions = pgTable('app_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, t => [
  index('session_user_idx').on(t.userId),
  index('session_expiry_idx').on(t.expiresAt),
]);

export const suppliers = pgTable('suppliers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  tier: integer('tier').notNull().default(1),
  data: jsonb('data').notNull(),
}, t => [
  index('supplier_workspace_idx').on(t.workspaceId),
  check('supplier_tier_range', sql`${t.tier} BETWEEN 1 AND 10`),
]);

export const supplierCommitments = pgTable('supplier_commitments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  itemId: text('item_id').notNull(),
  expectedQuantity: integer('expected_quantity').notNull(),
  confirmedQuantity: integer('confirmed_quantity').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, t => [
  index('commitment_workspace_idx').on(t.workspaceId),
  index('commitment_supplier_idx').on(t.supplierId, t.itemId),
  check('commitment_quantity_valid', sql`${t.expectedQuantity} > 0 AND ${t.confirmedQuantity} >= 0 AND ${t.confirmedQuantity} <= ${t.expectedQuantity}`),
  check('commitment_status_valid', sql`${t.status} IN ('ready','delayed','broken','fulfilled')`),
  check('commitment_fulfillment_valid', sql`${t.status} <> 'fulfilled' OR ${t.confirmedQuantity} = ${t.expectedQuantity}`),
]);

export const warehouses = pgTable('warehouses', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  data: jsonb('data').notNull(),
}, t => [
  index('warehouse_workspace_idx').on(t.workspaceId),
  check('warehouse_capacity_nonnegative', sql`${t.capacity} >= 0`),
]);

export const shipments = pgTable('shipments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  quantity: integer('quantity').notNull(),
  eta: timestamp('eta', { withTimezone: true }).notNull(),
  data: jsonb('data').notNull(),
}, t => [
  index('shipment_workspace_idx').on(t.workspaceId),
  index('shipment_supplier_idx').on(t.supplierId),
  index('shipment_warehouse_idx').on(t.warehouseId),
  check('shipment_quantity_nonnegative', sql`${t.quantity} >= 0`),
]);

export const inventoryLots = pgTable('inventory_lots', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  itemId: text('item_id').notNull(),
  quantity: integer('quantity').notNull(),
  reserved: integer('reserved').notNull(),
  status: text('status').notNull(),
  data: jsonb('data').notNull(),
}, t => [
  index('lot_workspace_idx').on(t.workspaceId),
  index('lot_warehouse_item_idx').on(t.warehouseId, t.itemId),
  check('lot_quantity_valid', sql`${t.quantity} >= 0 AND ${t.reserved} >= 0 AND ${t.reserved} <= ${t.quantity}`),
]);

export const orders = pgTable('customer_orders', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  data: jsonb('data').notNull(),
}, t => [
  index('order_workspace_idx').on(t.workspaceId),
  index('order_warehouse_deadline_idx').on(t.warehouseId, t.deadline),
]);

export const orderLines = pgTable('order_lines', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  itemId: text('item_id').notNull(),
  quantity: integer('quantity').notNull(),
  fulfilled: integer('fulfilled').notNull(),
}, t => [
  index('line_order_idx').on(t.orderId),
  check('line_quantity_valid', sql`${t.quantity} > 0 AND ${t.fulfilled} >= 0 AND ${t.fulfilled} <= ${t.quantity}`),
]);

export const integrationConnections = pgTable('integration_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
  failureCount: integer('failure_count').notNull().default(0),
  circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
}, t => [
  index('integration_conn_ws_idx').on(t.workspaceId),
  check('integration_conn_kind_check', sql`${t.kind} IN ('carrier','warehouse','supplier','document','ai')`),
  check('integration_conn_status_check', sql`${t.status} IN ('online','degraded','offline','recovering')`),
]);

export const integrationInbox = pgTable('integration_inbox', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  integrationId: text('integration_id').notNull().references(() => integrationConnections.id),
  sourceEventId: text('source_event_id').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  sourceSequence: integer('source_sequence'),
  correlationId: text('correlation_id'),
  payload: jsonb('payload').notNull(),
  eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  replayLineage: jsonb('replay_lineage').notNull().default(sql`'[]'::jsonb`),
}, t => [
  index('inbox_ws_idx').on(t.workspaceId),
  index('inbox_integration_idx').on(t.integrationId),
  index('inbox_pending_idx').on(t.nextAttemptAt, t.id),
  check('inbox_status_check', sql`${t.status} IN ('pending','processing','processed','failed','dead_letter')`),
]);

export const documentRecords = pgTable('document_records', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  filename: text('filename').notNull(),
  fileSizeBytes: integer('file_size_bytes').notNull(),
  pageCount: integer('page_count'),
  mimeType: text('mime_type').notNull(),
  source: text('source').notNull(),
  status: text('status').notNull(),
  confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0.000'),
  issues: jsonb('issues').notNull().default(sql`'[]'::jsonb`),
  extractedFields: jsonb('extracted_fields').notNull().default(sql`'{}'::jsonb`),
  excerpt: text('excerpt'),
  confirmedBy: text('confirmed_by').references(() => users.id),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, t => [
  index('doc_records_ws_idx').on(t.workspaceId),
  index('doc_records_confirmed_by_idx').on(t.confirmedBy),
  check('doc_records_status_check', sql`${t.status} IN ('uploading','processing','ready','matched','mismatch','review','confirmed','failed')`),
]);

export const documentFiles = pgTable('document_files', {
  id: text('id').primaryKey().references(() => documentRecords.id, { onDelete: 'cascade' }),
  data: bytea('data').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const documentJobs = pgTable('document_jobs', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documentRecords.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index('doc_jobs_ws_idx').on(t.workspaceId),
  index('doc_jobs_doc_idx').on(t.documentId),
  index('doc_jobs_pending_idx').on(t.createdAt, t.id),
  check('doc_jobs_status_check', sql`${t.status} IN ('queued','processing','completed','failed')`),
]);

export const documentChunks = pgTable('document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documentRecords.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  pageNumber: integer('page_number'),
  charStart: integer('char_start').notNull(),
  charEnd: integer('char_end').notNull(),
  content: text('content').notNull(),
}, t => [
  index('doc_chunks_doc_idx').on(t.documentId, t.chunkIndex),
]);

export const agentExecutionLogs = pgTable('agent_execution_logs', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  agent: text('agent').notNull(),
  feature: text('feature').notNull(),
  action: text('action').notNull(),
  accessedEntities: text('accessed_entities').notNull(),
  actorId: text('actor_id'),
  summary: text('summary').notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  model: text('model').notNull(),
}, t => [
  index('idx_agent_logs_timestamp').on(t.timestamp),
  index('idx_agent_logs_feature').on(t.feature),
]);
