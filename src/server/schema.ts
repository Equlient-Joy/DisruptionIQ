import { pgTable, text, jsonb, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { State } from '../shared/types';

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(), state: jsonb('state').$type<State>().notNull(),
  version: integer('version').notNull().default(0), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
export const users = pgTable('app_users', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  role: text('role').notNull(), orgId: text('org_id').notNull(), passwordHash: text('password_hash').notNull(),
});
export const sessions = pgTable('app_sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, t => [index('session_user_idx').on(t.userId), index('session_expiry_idx').on(t.expiresAt)]);
export const suppliers = pgTable('suppliers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(), data: jsonb('data').notNull(),
}, t => [index('supplier_workspace_idx').on(t.workspaceId)]);
export const warehouses = pgTable('warehouses', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(), capacity: integer('capacity').notNull(), data: jsonb('data').notNull(),
}, t => [index('warehouse_workspace_idx').on(t.workspaceId), check('warehouse_capacity_nonnegative', sql`${t.capacity} >= 0`)]);
export const shipments = pgTable('shipments', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  quantity: integer('quantity').notNull(), eta: timestamp('eta', { withTimezone: true }).notNull(), data: jsonb('data').notNull(),
}, t => [index('shipment_workspace_idx').on(t.workspaceId), index('shipment_supplier_idx').on(t.supplierId), index('shipment_warehouse_idx').on(t.warehouseId), check('shipment_quantity_nonnegative', sql`${t.quantity} >= 0`)]);
export const inventoryLots = pgTable('inventory_lots', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id), itemId: text('item_id').notNull(),
  quantity: integer('quantity').notNull(), reserved: integer('reserved').notNull(), status: text('status').notNull(), data: jsonb('data').notNull(),
}, t => [index('lot_workspace_idx').on(t.workspaceId), index('lot_warehouse_item_idx').on(t.warehouseId,t.itemId), check('lot_quantity_valid', sql`${t.quantity} >= 0 AND ${t.reserved} >= 0 AND ${t.reserved} <= ${t.quantity}`)]);
export const orders = pgTable('customer_orders', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(), data: jsonb('data').notNull(),
}, t => [index('order_workspace_idx').on(t.workspaceId), index('order_warehouse_deadline_idx').on(t.warehouseId,t.deadline)]);
export const orderLines = pgTable('order_lines', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id),
  itemId: text('item_id').notNull(), quantity: integer('quantity').notNull(), fulfilled: integer('fulfilled').notNull(),
}, t => [index('line_order_idx').on(t.orderId), check('line_quantity_valid', sql`${t.quantity} > 0 AND ${t.fulfilled} >= 0 AND ${t.fulfilled} <= ${t.quantity}`)]);
