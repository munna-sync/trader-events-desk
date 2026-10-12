// Run with: npm test   (no network needed; AI providers and the database are mocked)
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEvents, normalize, runDiscovery, pickArea, parseFeed } from "../lib/discovery.mjs";
import { encrypt, decrypt, hint } from "../lib/server.mjs";
import cron from "../api/cron/discover.js";

const today = "2026-10-12";
const good = { title: "Forex Expo Riyadh 2027", organizer: "Expo Co", start: "2027-02-10", end: "2027-02-11", startTime: "10:00", endTime: "18:00", tz: "Asia/Riyadh",
  venue: "RECC", city: "Riyadh", country: "Saudi Arabia", format: "In-person", status: "Registration Open", cost: "Free visitor pass", costMin: 0, url: "https://example.com/expo",
  sourceUrl: "https://example.com/expo", dateConfidence: "confirmed", description: "Forex brokers, prop firms and live trading sessions for retail traders.", categories: ["forex", "prop", "bogus"], niche: "forex" };

test("extracts the JSON array from tags or fenced code", () => {
  assert.equal(extractEvents(`notes <events>[${JSON.stringify(good)}]</events>`).length, 1);
  assert.equal(extractEvents("<events>\n```json\n[]\n```\n</events>").length, 0);
  assert.throws(() => extractEvents("<events>[{oops</events>"));
});

test("normalizes a valid event and drops invalid ones", () => {
  const r = normalize(good, { today, source: "ai:claude" });
  assert.equal(r.id, "forex-expo-riyadh-2027-2027-02-10");
  assert.deepEqual(r.categories, ["forex", "prop"]);
  assert.equal(r.niche, "forex");
  assert.deepEqual(r.groups, ["trading"]);
  assert.equal(r.cost_min, 0);
  assert.equal(r.approved, false);
  assert.equal(normalize({ ...good, start: "2026-01-01", end: "2026-01-02" }, { today, source: "x" }), null, "past event dropped");
  assert.equal(normalize({ ...good, start: "2030-01-01", end: "2030-01-01" }, { today, source: "x" }), null, "beyond 2-year horizon dropped");
  assert.equal(normalize({ ...good, title: "" }, { today, source: "x" }), null);
  const odd = normalize({ ...good, tz: "Mars/Base", startTime: "25:00", format: "", venue: "Zoom webinar", categories: [], sourceUrl: "", url: "ftp://x", dateConfidence: "confirmed" }, { today, source: "x" });
  assert.equal(odd.tz, "UTC"); assert.equal(odd.start_time, ""); assert.equal(odd.format, "Virtual"); assert.equal(odd.venue, "Online / Virtual");
  assert.equal(odd.url, null); assert.equal(odd.date_confidence, "tentative", "no source link means tentative");
  assert.ok(odd.categories.length > 0, "auto-tagged when the AI gave no categories");
});

test("rotates areas by day and supports all", () => {
  assert.equal(pickArea("all").length, 3);
  assert.deepEqual(pickArea("business"), ["business"]);
  const days = new Set([0, 1, 2].map((d) => pickArea("auto", new Date(Date.UTC(2026, 9, 12 + d)))[0]));
  assert.equal(days.size, 3);
});

test("parses iCal feeds with exclusive all-day end dates", () => {
  const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:Gold Outlook Webinar\nDTSTART:20261118T140000Z\nDTEND:20261118T150000Z\nLOCATION:Online\nEND:VEVENT\nBEGIN:VEVENT\nUID:2\nSUMMARY:Crypto Expo\nDTSTART;VALUE=DATE:20270301\nDTEND;VALUE=DATE:20270303\nEND:VEVENT\nEND:VCALENDAR";
  const [a, b] = parseFeed("ical", ics, "UTC");
  assert.equal(a.startTime, "14:00"); assert.equal(a.tz, "UTC");
  assert.equal(b.start, "2027-03-01"); assert.equal(b.end, "2027-03-02");
});

test("encrypts and decrypts saved keys", () => {
  process.env.KEYS_SECRET = "test-secret-with-enough-length";
  const blob = encrypt("sk-ant-api03-abcdefghijklmnop");
  assert.ok(!blob.includes("abcdefgh"));
  assert.equal(decrypt(blob), "sk-ant-api03-abcdefghijklmnop");
  assert.equal(hint("sk-ant-api03-abcdefghijklmnop"), "sk-ant…mnop");
});

// ---------- Fake Supabase client ----------
function fakeDb({ provider }) {
  const t = {
    events: [{ id: "sibos-2027", title: "Sibos 2027", start_date: "2027-10-11" }],
    ai_settings: [{ id: 1, provider, max_searches: 6, enabled: true }],
    ai_keys: [], event_sources: [], discovery_runs: [],
  };
  const q = (name) => {
    let rows = t[name] || [], filt = [];
    const api = {
      select() { return api; }, eq(c, v) { filt.push([c, v]); return api; },
      maybeSingle() { const r = rows.filter((x) => filt.every(([c, v]) => x[c] === v)); return Promise.resolve({ data: r[0] || null }); },
      upsert(rs) { (Array.isArray(rs) ? rs : [rs]).forEach((r) => { if (!t[name].some((x) => x.id === r.id)) t[name].push(r); }); return Promise.resolve({ error: null }); },
      insert(r) { t[name].push(r); return Promise.resolve({ error: null }); },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      then(res) { return Promise.resolve({ data: rows.filter((x) => filt.every(([c, v]) => x[c] === v)) }).then(res); },
    };
    return api;
  };
  return { from: q, tables: t };
}

const replies = {
  claude: (txt) => ({ stop_reason: "end_turn", content: [{ type: "server_tool_use" }, { type: "web_search_tool_result", content: [] }, { type: "text", text: txt }] }),
  openai: (txt) => ({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: txt, annotations: [] }] }] }),
  gemini: (txt) => ({ steps: [{ type: "google_search_call" }, { type: "model_output", content: [{ type: "text", text: txt }] }] }),
};

for (const provider of ["claude", "openai", "gemini"]) {
  test(`runs discovery end to end with ${provider}`, async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key-1234567890"; process.env.OPENAI_API_KEY = "sk-openai-env-1234567890"; process.env.GEMINI_API_KEY = "gemini-env-key-1234567890";
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      const dup = { ...good, title: "Sibos 2027", start: "2027-10-11", end: "2027-10-14" };
      const body = replies[provider](`Here you go <events>${JSON.stringify([good, dup, { title: "Old", start: "2025-01-01" }])}</events>`);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const sb = fakeDb({ provider });
    const r = await runDiscovery(sb, { area: "trading", trigger: "test", deadline: Date.now() + 120_000 });
    assert.equal(r.provider, provider);
    assert.equal(r.found, 3); assert.equal(r.added, 1); assert.equal(r.skipped, 2);
    assert.equal(sb.tables.events.length, 2);
    assert.equal(sb.tables.discovery_runs.length, 1);
    const call = seen[0];
    const expectUrl = { claude: "api.anthropic.com/v1/messages", openai: "api.openai.com/v1/responses", gemini: "generativelanguage.googleapis.com/v1beta/interactions" }[provider];
    assert.ok(call.url.includes(expectUrl), call.url);
    const sent = JSON.parse(call.init.body);
    if (provider === "claude") { assert.equal(sent.tools[0].type, "web_search_20250305"); assert.equal(call.init.headers["x-api-key"], process.env.ANTHROPIC_API_KEY); }
    if (provider === "openai") { assert.equal(sent.tools[0].type, "web_search"); assert.equal(call.init.headers.authorization, `Bearer ${process.env.OPENAI_API_KEY}`); }
    if (provider === "gemini") { assert.equal(sent.tools[0].type, "google_search"); assert.equal(call.init.headers["x-goog-api-key"], process.env.GEMINI_API_KEY); }
  });
}

test("Claude pause_turn is continued", async () => {
  let n = 0;
  globalThis.fetch = async (url, init) => {
    n++;
    const body = n === 1 ? { stop_reason: "pause_turn", content: [{ type: "server_tool_use" }] } : replies.claude("<events>[]</events>");
    if (n === 2) assert.equal(JSON.parse(init.body).messages.length, 2);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await runDiscovery(fakeDb({ provider: "claude" }), { area: "business", deadline: Date.now() + 120_000 });
  assert.equal(n, 2); assert.equal(r.added, 0); assert.equal(r.errors.length, 0);
});

test("missing key is reported, not thrown", async () => {
  delete process.env.OPENAI_API_KEY;
  const r = await runDiscovery(fakeDb({ provider: "openai" }), { area: "trading", deadline: Date.now() + 60_000 });
  assert.equal(r.added, 0); assert.match(r.errors[0].error, /No API key/);
});

test("cron endpoint rejects calls without the secret", async () => {
  process.env.CRON_SECRET = "cron-secret-123456";
  let code; const res = { status(c) { code = c; return this; }, json() { return this; } };
  await cron({ headers: {}, query: {} }, res);
  assert.equal(code, 401);
});
