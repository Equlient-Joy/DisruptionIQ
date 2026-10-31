import { afterEach, expect, test } from 'bun:test';
import { request, ApiError } from '../src/client/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('a successful non-JSON response is reported as a protocol error', async () => {
  globalThis.fetch = (async () => new Response('<html>Sign in</html>', { status: 200 })) as unknown as typeof fetch;
  await expect(request('/dashboard')).rejects.toBeInstanceOf(ApiError);
});

test('a proxy failure retains its HTTP status even when its body is HTML', async () => {
  globalThis.fetch = (async () => new Response('<html>Unavailable</html>', { status: 503 })) as unknown as typeof fetch;
  try { await request('/dashboard'); throw new Error('Expected request failure'); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(503); }
});
