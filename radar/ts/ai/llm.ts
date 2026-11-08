// Minimal OpenRouter chat client (OpenAI-compatible endpoint). Defaults to the free router: openrouter/free.
// JSON mode is requested where supported; output is parsed defensively because free models vary.

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface Llm {
    complete (messages: ChatMessage[], opts?: { json?: boolean, maxTokens?: number }): Promise<string>;
}

export class LlmUnavailable extends Error {}

export class OpenRouterClient implements Llm {
    apiKey: string;
    model: string;
    baseUrl: string;
    dailyLimit: number;
    used = 0;
    usedDate = '';
    fetchFn: typeof fetch;

    constructor (apiKey: string, model: string, baseUrl: string, dailyLimit: number, fetchFn: typeof fetch = fetch) {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl.replace (/\/$/, '');
        this.dailyLimit = dailyLimit;
        this.fetchFn = fetchFn;
    }

    private take (): void {
        const today = new Date ().toISOString ().slice (0, 10);
        if (today !== this.usedDate) {
            this.usedDate = today;
            this.used = 0;
        }
        if (this.used >= this.dailyLimit) {
            throw new LlmUnavailable ('daily AI request cap reached');
        }
        this.used += 1;
    }

    async complete (messages: ChatMessage[], opts: { json?: boolean, maxTokens?: number } = {}): Promise<string> {
        this.take ();
        const body: Record<string, unknown> = {
            model: this.model,
            messages,
            max_tokens: opts.maxTokens ?? 700,
            temperature: 0.2,
        };
        if (opts.json) {
            body.response_format = { type: 'json_object' };
        }
        let res: Response;
        try {
            res = await this.fetchFn (this.baseUrl + '/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + this.apiKey,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/ccxt/ccxt',
                    'X-Title': 'CCXT Radar',
                },
                body: JSON.stringify (body),
                signal: AbortSignal.timeout (45_000),
            });
        } catch (e: any) {
            throw new LlmUnavailable ('AI request failed: ' + (e?.message || e));
        }
        if (res.status === 429 || res.status >= 500) {
            throw new LlmUnavailable ('AI provider busy (HTTP ' + res.status + ')');
        }
        const data: any = await res.json ().catch (() => ({}));
        if (!res.ok) {
            throw new LlmUnavailable ('AI provider error (HTTP ' + res.status + '): ' + String (data?.error?.message || '').slice (0, 200));
        }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim () === '') {
            throw new LlmUnavailable ('AI returned an empty answer');
        }
        return content;
    }
}

// Extract the first JSON object from a model reply (handles ```json fences and leading prose).
export function extractJson (text: string): any {
    const fenced = text.match (/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf ('{');
    const end = candidate.lastIndexOf ('}');
    if (start === -1 || end <= start) {
        throw new Error ('no JSON object in reply');
    }
    return JSON.parse (candidate.slice (start, end + 1));
}
