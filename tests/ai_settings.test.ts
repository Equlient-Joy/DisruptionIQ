import { expect, test } from 'bun:test';
import { callAgentLLM } from '../src/server/agents/llm';
import { aiConfigured } from '../src/server/ai';

test('disabled AI does not contact a provider even with configured keys', async () => {
  const previous = process.env.AI_FEATURES_ENABLED;
  const previousKey = process.env.AI_API_KEY;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.AI_FEATURES_ENABLED = 'false';
  process.env.AI_API_KEY = 'test-key';
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 503 }); }) as unknown as typeof fetch;
  try {
    expect(await callAgentLLM({ systemPrompt: 'test', userPrompt: 'test' })).toBeNull();
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.AI_FEATURES_ENABLED; else process.env.AI_FEATURES_ENABLED = previous;
    if (previousKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = previousKey;
  }
});

test('enabled AI contacts Gemini with gemini-3.8-flash by default when GEMINI_API_KEY is set', async () => {
  const prevEnabled = process.env.AI_FEATURES_ENABLED;
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevModel = process.env.GEMINI_MODEL;
  const prevAiKey = process.env.AI_API_KEY;
  const originalFetch = globalThis.fetch;

  let requestedUrl = '';
  let requestedBody: any = null;

  process.env.AI_FEATURES_ENABLED = 'true';
  process.env.GEMINI_API_KEY = 'gemini-secret-test-key';
  delete process.env.GEMINI_MODEL;
  delete process.env.AI_API_KEY;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    if (init?.body) {
      requestedBody = JSON.parse(String(init.body));
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Gemini 3.8 Flash response' }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  try {
    expect(aiConfigured()).toBe(true);
    const res = await callAgentLLM({
      systemPrompt: 'You are an intelligent triage agent.',
      userPrompt: 'Assess shipment risk.',
    });

    expect(res).not.toBeNull();
    expect(res?.model).toBe('gemini-3.8-flash');
    expect(res?.text).toBe('Gemini 3.8 Flash response');
    expect(requestedUrl).toContain('models/gemini-3.8-flash:generateContent');
    expect(requestedUrl).toContain('key=gemini-secret-test-key');
    expect(requestedBody.systemInstruction.parts[0].text).toBe('You are an intelligent triage agent.');
    expect(requestedBody.contents[0].parts[0].text).toBe('Assess shipment risk.');
  } finally {
    globalThis.fetch = originalFetch;
    if (prevEnabled === undefined) delete process.env.AI_FEATURES_ENABLED; else process.env.AI_FEATURES_ENABLED = prevEnabled;
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGemini;
    if (prevModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = prevModel;
    if (prevAiKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = prevAiKey;
  }
});
