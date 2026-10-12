// AI providers for daily discovery. Each one runs a live web search and returns the model's final text.
// Claude: Messages API + web_search tool. OpenAI: Responses API + web_search tool.
// Gemini: Interactions API + google_search tool.

export const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5-5",
    keyPrefix: "sk-ant-",
    keyUrl: "https://platform.claude.com/settings/keys",
    billingUrl: "https://platform.claude.com/settings/billing",
    searchNote: "Web search costs $10 per 1,000 searches plus normal token costs.",
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    keyPrefix: "sk-",
    keyUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/account/billing/overview",
    searchNote: "Web search is billed per tool call plus tokens; see OpenAI's pricing page.",
  },
  gemini: {
    label: "Gemini (Google)",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    keyPrefix: "",
    keyUrl: "https://aistudio.google.com/apikey",
    billingUrl: "https://aistudio.google.com/",
    searchNote: "Gemini 3+ includes 5,000 free search requests a month, then $14 per 1,000.",
  },
};

// Collect every "text" string in a response, in order. Works across all three response shapes.
export function collectText(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.text === "string") out.push(node.text);
    if (typeof node.output_text === "string") out.push(node.output_text);
    for (const [k, v] of Object.entries(node)) if (k !== "text" && k !== "output_text" && typeof v === "object") collectText(v, out);
  }
  return out;
}

async function post(url, headers, body, deadline) {
  const ms = Math.max(5_000, deadline - Date.now() - 15_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${raw.slice(0, 300)}`);
    return JSON.parse(raw);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timed out waiting for the AI provider");
    throw e;
  } finally { clearTimeout(timer); }
}

async function claude({ key, model, prompt, maxSearches, deadline, search = true }) {
  let messages = [{ role: "user", content: prompt }];
  const tools = search ? [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }] : undefined;
  for (let turn = 0; turn < 6; turn++) {
    const j = await post("https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: search ? 8000 : 20, messages, ...(tools ? { tools } : {}) }, deadline);
    // Long searches can pause; send the assistant turn back unchanged to continue.
    if (j.stop_reason === "pause_turn") { messages = [...messages, { role: "assistant", content: j.content }]; continue; }
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  throw new Error("Claude search did not finish within 6 turns");
}

async function openai({ key, model, prompt, deadline, search = true }) {
  const j = await post("https://api.openai.com/v1/responses", { authorization: `Bearer ${key}` },
    { model, input: prompt, ...(search ? { tools: [{ type: "web_search" }] } : { max_output_tokens: 20 }) }, deadline);
  if (typeof j.output_text === "string") return j.output_text;
  const msgs = (j.output || []).filter((o) => o.type === "message");
  return collectText(msgs).join("");
}

async function gemini({ key, model, prompt, deadline, search = true }) {
  const j = await post("https://generativelanguage.googleapis.com/v1beta/interactions", { "x-goog-api-key": key },
    { model, input: prompt, ...(search ? { tools: [{ type: "google_search" }] } : {}) }, deadline);
  const outSteps = (j.steps || []).filter((s) => s.type === "model_output");
  return collectText(outSteps.length ? outSteps : j).join("");
}

const CALL = { claude, openai, gemini };

export async function runSearch(provider, opts) {
  if (!CALL[provider]) throw new Error(`Unknown provider: ${provider}`);
  return CALL[provider](opts);
}

// Cheap call without web search, used by the portal's "Test key" button.
export async function testKey(provider, key, model) {
  const text = await runSearch(provider, { key, model, prompt: "Reply with the single word OK.", deadline: Date.now() + 45_000, search: false, maxSearches: 0 });
  return text.trim().slice(0, 40) || "(empty reply)";
}
