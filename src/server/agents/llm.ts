import { aiEnabled } from '../ai';

export interface LLMResponse {
  text: string;
  model: string;
}

export async function callAgentLLM(options: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<LLMResponse | null> {
  if (!aiEnabled()) return null;
  const geminiKey = process.env.GEMINI_API_KEY;
  const aiKey = process.env.AI_API_KEY;

  if (!geminiKey && !aiKey) {
    return null;
  }

  // Google Gemini API integration
  if (geminiKey) {
    const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    // List of models to try in sequence if primary model encounters rate limits (429), 404, or timeouts
    const candidateModels = Array.from(new Set([
      primaryModel,
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
      'gemini-3.5-flash',
      'gemini-2.5-flash-lite',
    ]));

    for (const model of candidateModels) {
      // Step A: Attempt standard generateContent (compatible with test mocks and v1beta)
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: options.systemPrompt }],
            },
            contents: [
              { role: 'user', parts: [{ text: options.userPrompt }] },
            ],
            generationConfig: {
              temperature: options.temperature ?? 0.2,
              maxOutputTokens: options.maxTokens ?? 1000,
            },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim().length > 0) {
            return { text: text.trim(), model };
          }
        } else {
          console.warn(`[AgentLLM] Gemini generateContent (${model}) returned HTTP ${res.status}`);
        }
      } catch (err: any) {
        console.warn(`[AgentLLM] Gemini generateContent (${model}) error:`, err?.message || err);
      }

      // Step B: Attempt modern Google Interactions API (v1beta/interactions)
      try {
        const interactionsUrl = 'https://generativelanguage.googleapis.com/v1beta/interactions';
        const res = await fetch(interactionsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey,
          },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            model,
            system_instruction: options.systemPrompt,
            input: options.userPrompt,
            generation_config: {
              temperature: options.temperature ?? 0.2,
              max_output_tokens: options.maxTokens ?? 1000,
            },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            steps?: Array<{
              type: string;
              content?: Array<{ text?: string; type?: string }>;
            }>;
            outputText?: string;
            output_text?: string;
          };

          const text =
            data?.steps?.find(s => s.type === 'model_output')?.content?.[0]?.text ||
            data?.outputText ||
            data?.output_text;

          if (text && text.trim().length > 0) {
            return { text: text.trim(), model };
          }
        } else {
          console.warn(`[AgentLLM] Gemini Interactions (${model}) returned HTTP ${res.status}`);
        }
      } catch (err: any) {
        console.warn(`[AgentLLM] Gemini Interactions (${model}) error:`, err?.message || err);
      }
    }

    return null;
  }

  // OpenAI-compatible endpoint integration
  if (aiKey) {
    const endpoint = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    try {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiKey}`,
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 800,
          messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: options.userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        console.warn(`[AgentLLM] AI provider returned HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };

      const text = data?.choices?.[0]?.message?.content;
      if (text) {
        return { text: text.trim(), model };
      }
      return null;
    } catch (err) {
      console.warn('[AgentLLM] Error calling AI provider:', err);
      return null;
    }
  }

  return null;
}
