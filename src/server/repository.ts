import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { eq, sql, gt, and, notInArray, desc } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as schema from './schema';
import type { Actor, State, AgentType, AgentFeature, AgentExecutionLog } from '../shared/types';
import { AgentEventBus } from './agents/bus';
import { createEmptyState } from '../domain/seed';
import { normalizeState } from '../domain/normalize';
import { integrationForEvent } from '../domain/events';
import { demoActors, hashPassword, tokenHash, verifyPassword } from './auth';
import {
  DocumentStorage,
  PostgresDocumentStorage,
  extractPages,
  chunkPages,
  parseDocumentFields,
} from './documents';

function safeParseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

type Database = ReturnType<typeof drizzleLite>;
export class Repository {
  readonly agentBus = new AgentEventBus();
  readonly mode: string;
  readonly documentStorage: DocumentStorage;
  private db: Database;
  private closeConnection: () => Promise<unknown>;
  private migration: () => Promise<unknown>;
  private pending: Promise<unknown> = Promise.resolve();
  private agentExecutionLogs: AgentExecutionLog[] = [];
  constructor(options: { url?: string; pglitePath?: string } = {}) {
    if (options.url) {
      const client = postgres(options.url, { max: 5, idle_timeout: 20, connect_timeout: 10 });
      this.db = drizzlePg(client) as unknown as Database;
      this.mode = 'PostgreSQL';
      this.closeConnection = () => client.end();
      this.migration = async () => client.unsafe(await readFile(new URL('./migration.sql', import.meta.url), 'utf8'));
    } else {
      const isMemory = !options.pglitePath || options.pglitePath.startsWith('memory');
      const pgliteDir = isMemory ? undefined : options.pglitePath;
      if (pgliteDir) mkdirSync(pgliteDir, { recursive: true });
      const client = new PGlite(pgliteDir);
      this.db = drizzleLite(client); this.mode = pgliteDir ? 'PostgreSQL · embedded local' : 'PostgreSQL · isolated test';
      this.closeConnection = () => client.close();
      this.migration = async () => client.exec(await readFile(new URL('./migration.sql', import.meta.url), 'utf8'));
    }
    this.documentStorage = new PostgresDocumentStorage(this.db);
  }
  async init(seed = true): Promise<void> {
    await this.migration();
    if (seed) {
      const existing = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id,'focal'));
      if (!existing.length) {
        const state = normalizeState(createEmptyState());
        await this.db.transaction(async tx => {
          await tx.insert(schema.workspaces).values({ id:'focal', state, version:state.version }).onConflictDoNothing();
          await this.projections(tx, state);
        });
      }
      if (process.env.DEMO_MODE === 'true') {
        for (const actor of demoActors) {
          await this.db.insert(schema.users).values({ ...actor, passwordHash: hashPassword(process.env.DEMO_PASSWORD || 'disruption-demo') }).onConflictDoNothing();
        }
      }
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
        await this.db.insert(schema.users).values({id:'bootstrap-admin',name:'Administrator',email:process.env.ADMIN_EMAIL.toLowerCase(),role:'admin',orgId:'focal',passwordHash:hashPassword(process.env.ADMIN_PASSWORD)}).onConflictDoNothing();
      }
    }
  }
  async read(): Promise<State> {
    const [row] = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id,'focal'));
    if (!row) throw new Error('Workspace is not initialized. Run db:seed.');
    const state = normalizeState(structuredClone(row.state));
    for (const conn of state.integrations || []) {
      conn.backlogCount = (state.queue || []).filter(e => integrationForEvent(e.type) === conn.kind).length;
    }
    return state;
  }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    // The in-process queue also protects PGlite's single connection. FOR UPDATE
    // serializes independent PostgreSQL API processes on the workspace row.
    const job = this.pending.catch(() => {}).then(() => this.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const [row] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id,'focal')).for('update');
      if (!row) throw new Error('Workspace is not initialized.');
      const state = normalizeState(structuredClone(row.state));
      const result = fn(state);
      if (result instanceof Promise) throw new Error('Network/async work cannot run inside a state transaction.');
      state.version = Math.max(state.version, row.version) + 1;
      await this.projections(tx, state);
      await tx.update(schema.workspaces).set({ state, version:state.version, updatedAt:new Date() }).where(eq(schema.workspaces.id,'focal'));
      return structuredClone(result);
    }));
    this.pending = job;
    return job;
  }
  private async projections(tx: any, state: State) {
    const lineIds = state.orders.map(o => `${o.id}-line`);
    const orderIds = state.orders.map(o => o.id);
    const lotIds = state.lots.map(l => l.id);
    const shipmentIds = state.shipments.map(s => s.id);
    const supplierIds = state.suppliers.map(s => s.id);
    const commitmentIds = state.suppliers.flatMap(s => (s.commitments || []).map(c => `${s.id}:${c.itemId}`));
    const warehouseIds = state.warehouses.map(w => w.id);

    if (lineIds.length === 0) await tx.delete(schema.orderLines);
    else await tx.delete(schema.orderLines).where(notInArray(schema.orderLines.id, lineIds));

    if (orderIds.length === 0) await tx.delete(schema.orders);
    else await tx.delete(schema.orders).where(notInArray(schema.orders.id, orderIds));

    if (lotIds.length === 0) await tx.delete(schema.inventoryLots);
    else await tx.delete(schema.inventoryLots).where(notInArray(schema.inventoryLots.id, lotIds));

    if (shipmentIds.length === 0) await tx.delete(schema.shipments);
    else await tx.delete(schema.shipments).where(notInArray(schema.shipments.id, shipmentIds));

    if (commitmentIds.length === 0) await tx.delete(schema.supplierCommitments);
    else await tx.delete(schema.supplierCommitments).where(notInArray(schema.supplierCommitments.id, commitmentIds));

    if (supplierIds.length === 0) await tx.delete(schema.suppliers);
    else await tx.delete(schema.suppliers).where(notInArray(schema.suppliers.id, supplierIds));

    if (warehouseIds.length === 0) await tx.delete(schema.warehouses);
    else await tx.delete(schema.warehouses).where(notInArray(schema.warehouses.id, warehouseIds));

    for (const s of state.suppliers) {
      await tx.insert(schema.suppliers).values({id:s.id,workspaceId:'focal',name:s.name,tier:s.tier,data:s}).onConflictDoUpdate({target:schema.suppliers.id,set:{name:s.name,tier:s.tier,data:s}});
      for (const c of s.commitments || []) {
        const fields = { id: `${s.id}:${c.itemId}`, workspaceId: 'focal', supplierId: s.id, itemId: c.itemId, expectedQuantity: c.expectedQuantity, confirmedQuantity: c.confirmedQuantity, dueAt: new Date(c.dueAt), status: c.status, updatedAt: new Date(c.updatedAt) };
        await tx.insert(schema.supplierCommitments).values(fields).onConflictDoUpdate({target:schema.supplierCommitments.id,set:fields});
      }
    }
    for (const w of state.warehouses) await tx.insert(schema.warehouses).values({id:w.id,workspaceId:'focal',name:w.name,capacity:w.capacity,data:w}).onConflictDoUpdate({target:schema.warehouses.id,set:{name:w.name,capacity:w.capacity,data:w}});
    for (const s of state.shipments) {
      const fields={id:s.id,workspaceId:'focal',supplierId:s.supplierId,warehouseId:s.warehouseId,quantity:s.quantity,eta:new Date(s.eta),data:s};
      await tx.insert(schema.shipments).values(fields).onConflictDoUpdate({target:schema.shipments.id,set:fields});
    }
    for (const l of state.lots) {
      const fields={id:l.id,workspaceId:'focal',warehouseId:l.warehouseId,itemId:l.itemId,quantity:l.quantity,reserved:l.reserved,status:l.status,data:l};
      await tx.insert(schema.inventoryLots).values(fields).onConflictDoUpdate({target:schema.inventoryLots.id,set:fields});
    }
    for (const o of state.orders) {
      const fields={id:o.id,workspaceId:'focal',warehouseId:o.warehouseId,deadline:new Date(o.deadline),data:o};
      await tx.insert(schema.orders).values(fields).onConflictDoUpdate({target:schema.orders.id,set:fields});
      const line={id:`${o.id}-line`,orderId:o.id,itemId:o.itemId,quantity:o.quantity,fulfilled:o.fulfilled};
      await tx.insert(schema.orderLines).values(line).onConflictDoUpdate({target:schema.orderLines.id,set:line});
    }
    for (const conn of state.integrations || []) {
      const fields = {
        id: conn.id,
        workspaceId: 'focal',
        kind: conn.kind,
        name: conn.name,
        status: conn.status,
        reason: conn.reason || null,
        failureCount: conn.failureCount || 0,
        circuitOpenUntil: conn.circuitOpenUntil ? new Date(conn.circuitOpenUntil) : null,
        lastSuccessAt: conn.lastSuccessAt ? new Date(conn.lastSuccessAt) : null,
        updatedAt: new Date(conn.updatedAt || state.clock),
        data: conn,
      };
      await tx.insert(schema.integrationConnections).values(fields).onConflictDoUpdate({
        target: schema.integrationConnections.id,
        set: fields,
      });
    }
  }
  async recordInbox(item: {
    integrationId: string;
    sourceEventId: string;
    payload: unknown;
    eventTime: Date;
    schemaVersion?: number;
    sourceSequence?: number;
    correlationId?: string;
  }) {
    const id = `inbox-${crypto.randomUUID()}`;
    await this.db.insert(schema.integrationInbox).values({
      id,
      workspaceId: 'focal',
      integrationId: item.integrationId,
      sourceEventId: item.sourceEventId,
      schemaVersion: item.schemaVersion || 1,
      sourceSequence: item.sourceSequence || null,
      correlationId: item.correlationId || null,
      payload: item.payload as any,
      eventTime: item.eventTime,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: new Date(),
      replayLineage: [],
    });
    return id;
  }
  async insertDocumentRecord(doc: {
    id: string;
    filename: string;
    fileSizeBytes: number;
    mimeType: string;
    source: string;
    status: string;
  }): Promise<void> {
    await this.db.insert(schema.documentRecords).values({
      id: doc.id,
      workspaceId: 'focal',
      filename: doc.filename,
      fileSizeBytes: doc.fileSizeBytes,
      mimeType: doc.mimeType,
      source: doc.source,
      status: doc.status,
      confidence: '0.000',
      issues: [],
      extractedFields: {},
      createdAt: new Date(),
    }).onConflictDoNothing();
  }

  async createDocumentJob(id: string, documentId: string): Promise<void> {
    await this.db.insert(schema.documentJobs).values({
      id,
      documentId,
      workspaceId: 'focal',
      status: 'queued',
      attemptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  async getDocument(id: string) {
    const [row] = await this.db.select().from(schema.documentRecords).where(eq(schema.documentRecords.id, id));
    return row || null;
  }

  async getDocumentChunks(documentId: string, options: { cursor?: number; limit?: number } = {}) {
    const cursor = options.cursor ?? 0;
    const limit = Math.min(options.limit ?? 10, 50);
    const chunks = await this.db
      .select()
      .from(schema.documentChunks)
      .where(and(eq(schema.documentChunks.documentId, documentId), sql`${schema.documentChunks.chunkIndex} >= ${cursor}`))
      .orderBy(schema.documentChunks.chunkIndex)
      .limit(limit + 1);
    const hasMore = chunks.length > limit;
    const items = hasMore ? chunks.slice(0, limit) : chunks;
    const nextCursor = hasMore ? items[items.length - 1]!.chunkIndex + 1 : null;
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.documentChunks)
      .where(eq(schema.documentChunks.documentId, documentId));
    return { items, nextCursor, hasMore, total: count ?? 0 };
  }

  async processDocument(documentId: string, jobId: string, expectedGeneration: number): Promise<void> {
    const initial = await this.read();
    if ((initial.workspaceGeneration ?? 1) !== expectedGeneration || !initial.documents.some(d => d.id === documentId)) return;
    await this.db.update(schema.documentJobs).set({
      status: 'processing',
      updatedAt: new Date(),
    }).where(eq(schema.documentJobs.id, jobId));

    const [docRecord] = await this.db.select().from(schema.documentRecords).where(eq(schema.documentRecords.id, documentId));
    if (!docRecord) {
      await this.db.update(schema.documentJobs).set({ status: 'failed', error: 'Document record not found', updatedAt: new Date() }).where(eq(schema.documentJobs.id, jobId));
      return;
    }

    try {
      const data = await this.documentStorage.loadFile(documentId);
      if (!data) throw new Error('File content not found in storage');

      const { pages, source } = await extractPages(docRecord.filename, data);
      const chunks = chunkPages(pages);
      const fullText = pages.map(p => p.text).join('\n');
      const { fields, issues, confidence, excerpt } = parseDocumentFields(fullText);

      const state = await this.read();
      const shipment = state.shipments.find(s => s.id === fields.shipmentId);
      if (fields.shipmentId && !shipment) issues.push('Shipment reference does not match an operational record');
      if (shipment && fields.quantity !== undefined && shipment.quantity !== fields.quantity) {
        issues.push(`Quantity mismatch: document ${fields.quantity}, shipment ${shipment.quantity}; raw claim does not override trusted stock`);
      }
      const uncertain = !fullText.trim() || !fields.shipmentId || fields.quantity === undefined || !fields.date || !shipment;
      const status = uncertain ? 'review' : issues.length ? 'mismatch' : 'matched';

      if (chunks.length > 0) {
        await this.db.insert(schema.documentChunks).values(
          chunks.map(c => ({
            id: `${documentId}-chunk-${c.chunkIndex}`,
            documentId,
            chunkIndex: c.chunkIndex,
            pageNumber: c.pageNumber,
            charStart: c.charStart,
            charEnd: c.charEnd,
            content: c.content,
          }))
        ).onConflictDoNothing();
      }

      await this.db.update(schema.documentRecords).set({
        status,
        confidence: confidence.toFixed(3),
        issues,
        extractedFields: fields,
        excerpt,
        pageCount: pages.length,
        processedAt: new Date(),
      }).where(eq(schema.documentRecords.id, documentId));

      await this.db.update(schema.documentJobs).set({
        status: 'completed',
        updatedAt: new Date(),
      }).where(eq(schema.documentJobs.id, jobId));

      const applied = await this.mutate(s => {
        const claim = s.documents.find(d => d.id === documentId);
        if ((s.workspaceGeneration ?? 1) !== expectedGeneration || !claim) return false;
        claim.pageCount = pages.length;
        claim.excerpt = excerpt;
        claim.fields = fields;
        claim.confidence = confidence;
        claim.status = status;
        claim.issues = issues;
        claim.source = source;
        claim.processedAt = s.clock;
        if (status !== 'matched') {
          s.notifications.push({
            id: `notif-${crypto.randomUUID()}`,
            at: s.clock,
            message: `${claim.filename}: document ${claim.status} requires review`,
            read: false,
            orgId: 'focal',
          });
        }
        return true;
      });

      if (!applied) return;
      const s = await this.read();
      if ((s.workspaceGeneration ?? 1) !== expectedGeneration || !s.documents.some(d=>d.id===documentId)) return;
      this.agentBus.publish('document:extracted', {
        documentId,
        chunks: chunks.map(c => ({
          documentId,
          chunkIndex: c.chunkIndex,
          pageNumber: c.pageNumber,
          charStart: c.charStart,
          charEnd: c.charEnd,
          content: c.content,
        })),
        state: s,
      });
    } catch (err: any) {
      const errorMsg = err?.message || 'Document processing failed';
      await this.db.update(schema.documentRecords).set({
        status: 'failed',
        error: errorMsg,
        processedAt: new Date(),
      }).where(eq(schema.documentRecords.id, documentId));
      await this.db.update(schema.documentJobs).set({
        status: 'failed',
        error: errorMsg,
        updatedAt: new Date(),
      }).where(eq(schema.documentJobs.id, jobId));
      await this.mutate(s => {
        if ((s.workspaceGeneration ?? 1) !== expectedGeneration) return;
        const claim = s.documents.find(d => d.id === documentId);
        if (claim) {
          claim.status = 'failed';
          claim.error = errorMsg;
        }
      });
    }
  }

  async saveAgentLog(log: AgentExecutionLog): Promise<void> {
    this.agentExecutionLogs.push(structuredClone(log));
    try {
      await this.db.insert(schema.agentExecutionLogs).values({
        id: log.id,
        timestamp: log.timestamp,
        agent: log.agent,
        feature: log.feature,
        action: log.action,
        accessedEntities: JSON.stringify(log.accessedEntities || []),
        actorId: log.actorId || null,
        summary: log.summary,
        status: log.status,
        latencyMs: log.latencyMs,
        model: log.model,
      }).onConflictDoNothing();
    } catch {
      // In-memory fallback if database table is unavailable
    }
  }

  async getAgentLogs(filter?: { feature?: AgentFeature; limit?: number }): Promise<AgentExecutionLog[]> {
    const limit = filter?.limit || 50;
    try {
      const baseQuery = filter?.feature
        ? this.db.select().from(schema.agentExecutionLogs).where(eq(schema.agentExecutionLogs.feature, filter.feature))
        : this.db.select().from(schema.agentExecutionLogs);
      const rows = await baseQuery
        .orderBy(desc(schema.agentExecutionLogs.timestamp))
        .limit(limit);

      return rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        agent: r.agent as AgentType,
        feature: r.feature as AgentFeature,
        action: r.action,
        accessedEntities: safeParseJsonArray(r.accessedEntities),
        actorId: r.actorId || undefined,
        summary: r.summary,
        status: r.status as 'success' | 'fallback' | 'error',
        latencyMs: r.latencyMs,
        model: r.model,
      }));
    } catch {
      let logs = [...this.agentExecutionLogs];
      if (filter?.feature) {
        logs = logs.filter(l => l.feature === filter.feature);
      }
      logs.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
      return logs.slice(0, limit);
    }
  }

  async getAllTableNames(): Promise<string[]> {
    return [
      'workspaces',
      'app_users',
      'app_sessions',
      'suppliers',
      'warehouses',
      'shipments',
      'inventory_lots',
      'customer_orders',
      'order_lines',
      'integration_connections',
      'integration_inbox',
      'document_records',
      'document_files',
      'document_jobs',
      'document_chunks',
      'agent_execution_logs',
    ];
  }

  async searchTable(tableName: string, searchTerm?: string, limit = 50): Promise<any[]> {
    const validTables = await this.getAllTableNames();
    if (!validTables.includes(tableName)) {
      throw new Error(`Unknown table: ${tableName}`);
    }
    const safeLimit = Math.max(1, Math.min(limit, 200));
    if (!searchTerm || !searchTerm.trim()) {
      const res = await (this.db as any).execute(sql.raw(`SELECT * FROM ${tableName} LIMIT ${safeLimit}`));
      return (res.rows || res) as any[];
    }
    const cleanTerm = searchTerm.replace(/'/g, "''");
    const query = `SELECT * FROM ${tableName} WHERE CAST(row_to_json(${tableName}.*) AS TEXT) ILIKE '%${cleanTerm}%' LIMIT ${safeLimit}`;
    const res = await (this.db as any).execute(sql.raw(query));
    return (res.rows || res) as any[];
  }

  async searchAllTables(searchTerm: string, limitPerTable = 10): Promise<Record<string, any[]>> {
    const tables = await this.getAllTableNames();
    const results: Record<string, any[]> = {};
    for (const table of tables) {
      try {
        const rows = await this.searchTable(table, searchTerm, limitPerTable);
        if (rows.length > 0) {
          results[table] = rows;
        }
      } catch {
        // Continue searching remaining tables
      }
    }
    return results;
  }

  async users(): Promise<Actor[]> {
    const rows=await this.db.select().from(schema.users);
    return rows.map(({passwordHash:_,...actor}) => actor as Actor);
  }
  async authenticate(email: string,password: string): Promise<Actor | null> {
    const normalized = email.toLowerCase().replace('@disruptioniq.local', '@disruptioniq.demo').replace('@nexus-components.example', '@disruptioniq.demo');
    const [row]=await this.db.select().from(schema.users).where(eq(schema.users.email,normalized));
    // Equalize credential-check work for nonexistent identities.
    const valid=verifyPassword(password,row?.passwordHash || '0'.repeat(32)+':'+ '0'.repeat(128));
    if (!row || !valid) return null;
    const {passwordHash:_,...actor}=row; return actor as Actor;
  }
  async createSession(token: string,userId: string) {
    await this.db.insert(schema.sessions).values({tokenHash:tokenHash(token),userId,expiresAt:new Date(Date.now()+8*3600000)});
  }
  async actorForSession(token: string): Promise<Actor | null> {
    const [row]=await this.db.select({ actor:schema.users }).from(schema.sessions).innerJoin(schema.users,eq(schema.sessions.userId,schema.users.id)).where(and(eq(schema.sessions.tokenHash,tokenHash(token)),gt(schema.sessions.expiresAt,new Date())));
    if (!row) return null;
    const {passwordHash:_,...actor}=row.actor; return actor as Actor;
  }
  async deleteSession(token: string) { await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash,tokenHash(token))); }
  async close() { await this.agentBus.waitForIdle(); this.agentBus.clear(); await this.pending.catch(() => {}); await this.closeConnection(); }
}
export function configuredRepository(): Repository {
  if (process.env.DATABASE_MODE === 'pglite' || (!process.env.DATABASE_URL && process.env.DEMO_MODE === 'true')) return new Repository({pglitePath:process.env.PGLITE_PATH === 'memory://' ? undefined : process.env.PGLITE_PATH || '.data/postgres'});
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL for PostgreSQL, or explicitly set DATABASE_MODE=pglite for local development. See .env.example.');
  return new Repository({url:process.env.DATABASE_URL});
}
