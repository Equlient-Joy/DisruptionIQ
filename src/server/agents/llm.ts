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
  const geminiKey = process.env.GEMINI_API_KEY;
  const aiKey = process.env.AI_API_KEY;

  if (!geminiKey && !aiKey) {
    return null;
  }

  // Google Gemini API integration
  if (geminiKey) {
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: options.systemPrompt }],
          },
          contents: [
            { role: 'user', parts: [{ text: options.userPrompt }] },
          ],
          generationConfig: {
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxTokens ?? 800,
          },
        }),
      });

      if (!res.ok) {
        console.warn(`[AgentLLM] Gemini request returned HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return { text: text.trim(), model };
      }
      return null;
    } catch (err) {
      console.warn('[AgentLLM] Error calling Gemini API:', err);
      return null;
    }
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
