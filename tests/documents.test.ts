import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Repository } from '../src/server/repository';
import { createApp } from '../src/server/app';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_CHUNK_OVERLAP_CHARS,
  chunkPages,
  extractPages,
} from '../src/server/documents';

process.env.DEMO_MODE = 'true';

describe('large asynchronous document pipeline', () => {
  const repo = new Repository();
  const app = createApp(repo);
  let procurement = '', viewer = '';

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
    procurement = await login('procurement@disruptioniq.demo');
    viewer = await login('partner@disruptioniq.demo');
  }, 30000);

  afterAll(async () => {
    await repo.close();
  });

  test('chunkPages produces 4000-char chunks with 400-char overlap', () => {
    // Generate 7500 chars
    const sampleText = 'A'.repeat(7500);
    const chunks = chunkPages([{ pageNumber: 1, text: sampleText }]);

    expect(chunks.length).toBe(2);
    // Chunk 0: 0 to 4000
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(4000);
    expect(chunks[0]!.content.length).toBe(4000);

    // Chunk 1: 3600 to 7500
    expect(chunks[1]!.charStart).toBe(3600);
    expect(chunks[1]!.charEnd).toBe(7500);
    expect(chunks[1]!.content.length).toBe(3900);

    // Verify overlap is exactly 400 chars (4000 - 3600)
    expect(chunks[0]!.charEnd - chunks[1]!.charStart).toBe(DOCUMENT_CHUNK_OVERLAP_CHARS);
  });

  test('rejects payloads exceeding the 25 MB document limit', async () => {
    const oversized = new Uint8Array(DOCUMENT_MAX_BYTES + 10);
    await expect(extractPages('test.txt', oversized)).rejects.toThrow('25 MB');
  });

  test('upload returns 202 Accepted and processes document asynchronously', async () => {
    const docText = `Shipment: shipment-atlas\nQuantity: 120\nDate: 2026-10-30\n` + 'Description details. '.repeat(200);
    const res = await app.request('/api/documents?sync=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: procurement,
      },
      body: JSON.stringify({
        filename: 'freight-manifest.txt',
        text: docText,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('processing');
    expect(body.id).toBeDefined();
    expect(body.jobId).toBeDefined();

    // Verify document record via GET /api/documents/:id
    const getRes = await app.request(`/api/documents/${body.id}`, {
      headers: { cookie: procurement },
    });
    expect(getRes.status).toBe(200);
    const docData = await getRes.json();
    expect(docData.filename).toBe('freight-manifest.txt');
    expect(docData.pageCount).toBe(1);
    expect(docData.excerpt).toBeDefined();

    // Verify chunks via GET /api/documents/:id/chunks
    const chunksRes = await app.request(`/api/documents/${body.id}/chunks?limit=2`, {
      headers: { cookie: procurement },
    });
    expect(chunksRes.status).toBe(200);
    const chunksData = await chunksRes.json();
    expect(chunksData.items.length).toBeGreaterThan(0);
    expect(chunksData.total).toBeGreaterThan(0);
  });

  test('dashboard payload excludes full document text and retains excerpt', async () => {
    const dashRes = await app.request('/api/dashboard', {
      headers: { cookie: procurement },
    });
    expect(dashRes.status).toBe(200);
    const dashData = await dashRes.json();
    expect(dashData.state.documents.length).toBeGreaterThan(0);
    for (const doc of dashData.state.documents) {
      expect(doc.text).toBeUndefined();
      expect(typeof doc.excerpt).toBe('string');
      expect(doc.excerpt.length).toBeLessThanOrEqual(500);
    }
  });

  test('partner viewer cannot upload freight documents', async () => {
    const res = await app.request('/api/documents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: viewer,
      },
      body: JSON.stringify({
        filename: 'unauthorized.txt',
        text: 'Shipment: 123',
      }),
    });
    expect(res.status).toBe(403);
  });
});
