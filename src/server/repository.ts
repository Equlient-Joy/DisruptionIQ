import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { eq, sql, gt, and, notInArray } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as schema from './schema';
import type { Actor, State } from '../shared/types';
import { createSeedState } from '../domain/seed';
import { demoActors, hashPassword, tokenHash, verifyPassword } from './auth';

type Database = ReturnType<typeof drizzleLite>;
export class Repository {
  readonly mode: string;
  private db: Database;
  private closeConnection: () => Promise<unknown>;
  private migration: () => Promise<unknown>;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(options: { url?: string; pglitePath?: string } = {}) {
    if (options.url) {
      const client = postgres(options.url, { max: 5, idle_timeout: 20, connect_timeout: 10 });
      this.db = drizzlePg(client) as unknown as Database;
      this.mode = 'PostgreSQL';
      this.closeConnection = () => client.end();
      this.migration = async () => client.unsafe(await readFile(new URL('./migration.sql', import.meta.url), 'utf8'));
    } else {
      if (options.pglitePath) mkdirSync(options.pglitePath, { recursive: true });
      const client = new PGlite(options.pglitePath);
      this.db = drizzleLite(client); this.mode = options.pglitePath ? 'PostgreSQL · embedded local' : 'PostgreSQL · isolated test';
      this.closeConnection = () => client.close();
      this.migration = async () => client.exec(await readFile(new URL('./migration.sql', import.meta.url), 'utf8'));
    }
  }
  async init(seed = true): Promise<void> {
    await this.migration();
    if (seed) {
      const existing = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id,'focal'));
      if (!existing.length) {
        const state = createSeedState();
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
    return structuredClone(row.state);
  }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    // The in-process queue also protects PGlite's single connection. FOR UPDATE
    // serializes independent PostgreSQL API processes on the workspace row.
    const job = this.pending.catch(() => {}).then(() => this.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const [row] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id,'focal')).for('update');
      if (!row) throw new Error('Workspace is not initialized.');
      const state = structuredClone(row.state);
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
    const warehouseIds = state.warehouses.map(w => w.id);

    if (lineIds.length === 0) await tx.delete(schema.orderLines);
    else await tx.delete(schema.orderLines).where(notInArray(schema.orderLines.id, lineIds));

    if (orderIds.length === 0) await tx.delete(schema.orders);
    else await tx.delete(schema.orders).where(notInArray(schema.orders.id, orderIds));

    if (lotIds.length === 0) await tx.delete(schema.inventoryLots);
    else await tx.delete(schema.inventoryLots).where(notInArray(schema.inventoryLots.id, lotIds));

    if (shipmentIds.length === 0) await tx.delete(schema.shipments);
    else await tx.delete(schema.shipments).where(notInArray(schema.shipments.id, shipmentIds));

    if (supplierIds.length === 0) await tx.delete(schema.suppliers);
    else await tx.delete(schema.suppliers).where(notInArray(schema.suppliers.id, supplierIds));

    if (warehouseIds.length === 0) await tx.delete(schema.warehouses);
    else await tx.delete(schema.warehouses).where(notInArray(schema.warehouses.id, warehouseIds));

    for (const s of state.suppliers) await tx.insert(schema.suppliers).values({id:s.id,workspaceId:'focal',name:s.name,data:s}).onConflictDoUpdate({target:schema.suppliers.id,set:{name:s.name,data:s}});
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
  async close() { await this.pending.catch(() => {}); await this.closeConnection(); }
}
export function configuredRepository(): Repository {
  if (process.env.DATABASE_MODE === 'pglite' || (!process.env.DATABASE_URL && process.env.DEMO_MODE === 'true')) return new Repository({pglitePath:process.env.PGLITE_PATH || '.data/postgres'});
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL for PostgreSQL, or explicitly set DATABASE_MODE=pglite for local development. See .env.example.');
  return new Repository({url:process.env.DATABASE_URL});
}
