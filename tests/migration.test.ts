import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

test('startup upgrades quarantined inventory from the legacy constraint and remains idempotent', async () => {
  const db = new PGlite();
  const migration = await readFile(new URL('../src/server/migration.sql', import.meta.url), 'utf8');
  try {
    await db.exec(migration);
    await db.exec(`
      ALTER TABLE inventory_lots DROP CONSTRAINT inventory_lots_status_check;
      ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lots_status_check CHECK (status IN ('available','quarantined','disputed'));
      INSERT INTO workspaces (id, state) VALUES ('focal', '{}');
      INSERT INTO warehouses (id, workspace_id, name, capacity, data) VALUES ('legacy-warehouse', 'focal', 'Legacy', 100, '{}');
      INSERT INTO inventory_lots (id, workspace_id, warehouse_id, item_id, quantity, reserved, status, data)
      VALUES ('legacy-lot', 'focal', 'legacy-warehouse', 'item', 40, 10, 'quarantined', '{}');
    `);
    await db.exec(migration);
    await db.exec(migration);
    const result = await db.query('SELECT status, quantity, reserved FROM inventory_lots WHERE id = $1', ['legacy-lot']);
    expect(result.rows).toEqual([{ status: 'held', quantity: 40, reserved: 10 }]);
    await expect(db.query("UPDATE inventory_lots SET status = 'quarantined' WHERE id = $1", ['legacy-lot'])).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 30000);
