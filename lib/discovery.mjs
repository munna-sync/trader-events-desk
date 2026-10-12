// Daily discovery: ask the chosen AI provider to search the web for new events, read optional
// RSS/iCal/JSON feeds, validate and de-duplicate everything, auto-tag, and queue new events unapproved.
import { runSearch, PROVIDERS } from "./providers.mjs";
import { resolveKey, loadSettings } from "./server.mjs";
import { TAXONOMY, classifyEvent, groupsFor } from "./taxonomy.mjs";

export const AREAS = {
  trading: "Financial markets & trading: forex, crypto & Web3, gold & precious metals, signal-based/copy trading, prop firm trading, algorithmic & quant trading. Think trader expos, traders fairs, prop trading expos, crypto conferences and blockchain weeks, gold and precious metals conferences, iFX EXPO, Finance Magnates, Money Expo, MoneyShow, and public broker webinars (Tickmill, IG, XM, FXStreet, CME Group).",
  tradesaas: "Trade, SaaS & fintech: trade automation, trade services and trade finance (GTR, Sibos), global trade and import/export fairs (Canton Fair, DITF), logistics and supply chain shows, SaaS conferences, fintech festivals and weeks (Money20/20, Singapore FinTech Festival), embedded finance, regtech and compliance summits.",
  business: "Business, economy & leadership: world economy and macro forums (WEF and regional finance weeks), business growth, corporate leadership, venture capital and startup summits, wealth management forums, enterprise digital transformation and AI conferences.",
};
const AREA_KEYS = Object.keys(AREAS);
const ALL_IDS = TAXONOMY.flatMap((g) => g.cats.map((c) => c.id));
const TRADING_IDS = TAXONOMY[0].cats.map((c) => c.id);
const FORMATS = ["In-person", "Virtual", "Hybrid"];
const STATUSES = ["Registration Open", "Early Bird", "Upcoming", "Application Only", "Invite Only", "Sold Out"];
const YMD = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HORIZON_DAYS = 730;

export function pickArea(requested, now = new Date()) {
  if (requested === "all") return AREA_KEYS;
  if (AREA_KEYS.includes(requested)) return [requested];
  const day = Math.floor(now.getTime() / 864e5); // rotate one area per day
  return [AREA_KEYS[day % AREA_KEYS.length]];
}

export function buildPrompt(areaKey, existing, today, maxSearches) {
  const known = existing.slice(-300).map((e) => `- ${e.title} (${e.start_date})`).join("\n") || "(none yet)";
  return `You are the discovery agent for an events portal used from Bangladesh (BDST, UTC+6). Today is ${today}.

Find NEW upcoming events in this area that individual professionals, traders or investors can attend as participants (in-person conferences, expos, summits, or public online webinars):
${AREAS[areaKey]}
Include regional events in Bangladesh, India, UAE, Saudi Arabia, Singapore, Hong Kong, Southeast Asia, UK, Europe, US and Africa. Look mainly at the next 12 months, plus major annual events that have already published dates up to 24 months ahead. Exclude private or closed meetings and anything already over.

Use up to ${maxSearches} web searches. Only include an event if a search result from the organiser or a reputable listing shows its start date. Never invent dates, times, prices or venues; use "" or null when unknown. If only a third-party snippet confirms the date, set "dateConfidence" to "tentative".

Already listed (do not repeat these):
${known}

Reply with ONLY a JSON array inside <events></events> tags, at most 20 items, each like:
{"title":"","organizer":"","start":"YYYY-MM-DD","end":"YYYY-MM-DD","startTime":"HH:MM or empty","endTime":"HH:MM or empty","tz":"IANA zone of the venue, e.g. Asia/Dubai","venue":"","city":"","country":"","format":"In-person|Virtual|Hybrid","status":"Registration Open|Early Bird|Upcoming|Application Only|Invite Only|Sold Out","cost":"as published or Not published","costMin":number in USD or null (0 if free),"language":"English","url":"official page","sourceUrl":"page where you confirmed the date","dateConfidence":"confirmed|tentative","description":"2-3 sentences in your own words on what participants learn or experience","categories":["up to 5 of: ${ALL_IDS.join(", ")}"],"niche":"the single best category id"}
If you find nothing new, reply <events>[]</events>.`;
}

export function extractEvents(text) {
  const all = [...String(text).matchAll(/<events>([\s\S]*?)<\/events>/g)];
  let body = all.length ? all[all.length - 1][1] : null;
  if (body == null) { const m = String(text).match(/\[\s*{[\s\S]*}\s*\]/); body = m ? m[0] : "[]"; }
  body = body.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { const arr = JSON.parse(body); return Array.isArray(arr) ? arr : []; } catch { throw new Error("The AI reply was not valid JSON"); }
}

const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "event";
const httpUrl = (u) => (/^https?:\/\/\S+$/i.test(String(u || "")) ? String(u) : null);
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
export const dedupeKey = (title, start) => String(title).toLowerCase().replace(/20\d\d/g, "").replace(/[^a-z]+/g, "") + "|" + String(start).slice(0, 7);

// Turns one raw item into a database row, or null if it fails validation.
export function normalize(x, { today, source }) {
  const title = clip(x.title, 200); if (!title) return null;
  const start = String(x.start || ""); if (!YMD.test(start) || isNaN(Date.parse(start))) return null;
  let end = YMD.test(String(x.end || "")) ? x.end : start; if (end < start) end = start;
  const horizon = new Date(Date.parse(today) + HORIZON_DAYS * 864e5).toISOString().slice(0, 10);
  if (end < today || start > horizon) return null;
  const text = `${x.title} ${x.venue || ""} ${x.city || ""}`;
  const format = FORMATS.includes(x.format) ? x.format : /online|virtual|webinar|zoom/i.test(text) ? "Virtual" : "In-person";
  const description = clip(x.description, 900) || "";
  let categories = (Array.isArray(x.categories) ? x.categories : []).filter((c) => ALL_IDS.includes(c)).slice(0, 5);
  const auto = classifyEvent(title, description);
  if (!categories.length) categories = auto.categories;
  const niche = ALL_IDS.includes(x.niche) ? x.niche : (categories.find((c) => TRADING_IDS.includes(c)) && auto.niche) || categories[0] || null;
  if (niche && !categories.includes(niche)) categories = [niche, ...categories].slice(0, 5);
  const costMin = x.costMin === 0 || x.costMin === "0" ? 0 : Number.isFinite(Number(x.costMin)) && x.costMin !== null && x.costMin !== "" ? Math.max(0, Number(x.costMin)) : null;
  const sourceUrl = httpUrl(x.sourceUrl) || httpUrl(x.url);
  return {
    id: `${slug(title)}-${start}`, title, organizer: clip(x.organizer, 160),
    start_date: start, end_date: end,
    start_time: HHMM.test(String(x.startTime || "")) ? x.startTime : "", end_time: HHMM.test(String(x.endTime || "")) ? x.endTime : "",
    tz: validTz(x.tz) ? x.tz : "UTC",
    venue: format === "Virtual" ? "Online / Virtual" : clip(x.venue, 160), city: format === "Virtual" ? null : clip(x.city, 80), country: format === "Virtual" ? null : clip(x.country, 80),
    format, status: STATUSES.includes(x.status) ? x.status : "Upcoming",
    cost: clip(x.cost, 200) || "Not published", cost_min: costMin, language: clip(x.language, 40) || "English",
    url: httpUrl(x.url), source_url: sourceUrl,
    date_confidence: x.dateConfidence === "confirmed" && sourceUrl ? "confirmed" : "tentative",
    description, categories, niche, groups: groupsFor(categories),
    approved: false, auto_tagged: true, source,
  };
}

// ---------- Optional feeds (event_sources table) ----------
const strip = (s = "") => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function splitDT(v, tz = "UTC") {
  if (!v) return null; const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : "", tz: m[6] ? "UTC" : tz };
  m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) { if (m[3] && m[3] !== "Z") { const d = new Date(s); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), tz: "UTC" }; } return { date: m[1], time: m[2] || "", tz: m[3] ? "UTC" : tz }; }
  const d = new Date(s); return isNaN(d) ? null : { date: d.toISOString().slice(0, 10), time: "", tz: "UTC" };
}
const tag = (xml, n) => { const m = xml.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i")); return m ? strip(m[1]) : (xml.match(new RegExp(`<${n}[^>]*href="([^"]+)"`, "i"))?.[1] ?? ""); };
export function parseFeed(kind, body, tz) {
  const out = [];
  if (kind === "ical") {
    for (const blk of body.replace(/\r?\n[ \t]/g, "").split("BEGIN:VEVENT").slice(1)) {
      const f = {}; let tzid = "";
      for (const line of blk.split(/\r?\n/)) { const i = line.indexOf(":"); if (i < 0) continue; const head = line.slice(0, i), k = head.split(";")[0].toUpperCase(); if (k === "DTSTART") tzid = head.match(/TZID=([^;]+)/)?.[1] || tzid; f[k] = line.slice(i + 1).replace(/\\n/g, " ").replace(/\\,/g, ","); }
      const s = splitDT(f.DTSTART, tzid || tz), e = splitDT(f.DTEND, tzid || tz);
      let end = e?.date; if (/DTEND;VALUE=DATE:/i.test(blk) && end && s && end > s.date) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - 1); end = d.toISOString().slice(0, 10); }
      out.push({ title: f.SUMMARY, start: s?.date, startTime: s?.time, end, endTime: e?.time, tz: s?.tz, url: f.URL, sourceUrl: f.URL, venue: f.LOCATION, description: f.DESCRIPTION, dateConfidence: "confirmed" });
    }
  } else if (kind === "rss") {
    for (const it of body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []) {
      const s = splitDT(tag(it, "ev:startdate") || tag(it, "startDate"), tz); if (!s) continue; // pubDate is not an event date
      const e = splitDT(tag(it, "ev:enddate") || tag(it, "endDate"), tz);
      out.push({ title: tag(it, "title"), start: s.date, startTime: s.time, end: e?.date, endTime: e?.time, tz: s.tz, url: tag(it, "link"), sourceUrl: tag(it, "link"), venue: tag(it, "ev:location") || tag(it, "location"), description: strip(tag(it, "description") || tag(it, "summary")), dateConfidence: "confirmed" });
    }
  } else {
    const j = JSON.parse(body); const list = Array.isArray(j) ? j : j.events || j.items || j.data || [];
    for (const o of list) {
      const s = splitDT(o.start?.local ?? o.start ?? o.startDate, o.start?.timezone ?? o.timezone ?? tz), e = splitDT(o.end?.local ?? o.end ?? o.endDate, o.end?.timezone ?? o.timezone ?? tz);
      out.push({ title: o.name?.text ?? o.title ?? o.name, start: s?.date, startTime: s?.time, end: e?.date, endTime: e?.time, tz: s?.tz, url: o.url, sourceUrl: o.url, venue: o.venue?.name ?? o.location, city: o.city, country: o.country, format: o.online_event || o.is_online ? "Virtual" : undefined, cost: o.is_free ? "Free" : o.price ?? o.cost, costMin: o.is_free ? 0 : null, description: strip(o.description?.text ?? o.description ?? ""), organizer: o.organizer?.name ?? o.organizer, dateConfidence: "confirmed" });
    }
  }
  return out;
}

// ---------- Orchestration ----------
export async function runDiscovery(sb, { area, trigger = "cron", deadline = Date.now() + 270_000 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const settings = await loadSettings(sb);
  const areas = pickArea(area);
  const errors = [], raw = [];
  const { data: existing = [] } = await sb.from("events").select("id,title,start_date");
  const ids = new Set(existing.map((e) => e.id)), keys = new Set(existing.map((e) => dedupeKey(e.title, e.start_date)));

  if (!settings.enabled && trigger === "cron") return { skippedRun: true, reason: "Discovery is turned off in the portal" };

  const provider = settings.provider, model = settings.models[provider];
  let keyInfo = { key: null };
  try { keyInfo = await resolveKey(sb, provider); } catch (e) { errors.push({ source: provider, error: e.message }); }
  if (!keyInfo.key) errors.push({ source: provider, error: `No API key for ${PROVIDERS[provider].label}. Add one in Admin > AI & discovery or set ${PROVIDERS[provider].envKey} in Vercel.` });
  else {
    const perArea = Math.max(4, Math.floor(settings.maxSearches / areas.length));
    for (const a of areas) {
      if (Date.now() > deadline - 45_000) { errors.push({ source: provider, error: `Stopped before "${a}" to stay inside the time limit` }); break; }
      try {
        const text = await runSearch(provider, { key: keyInfo.key, model, prompt: buildPrompt(a, existing, today, perArea), maxSearches: perArea, deadline });
        extractEvents(text).forEach((x) => raw.push({ x, source: `ai:${provider}` }));
      } catch (e) { errors.push({ source: `${provider} (${a})`, error: String(e.message || e).slice(0, 300) }); }
    }
  }

  const { data: feeds = [] } = await sb.from("event_sources").select("*").eq("is_active", true);
  for (const f of feeds) {
    if (Date.now() > deadline - 15_000) break;
    try {
      const r = await fetch(f.url, { headers: { "user-agent": "TraderEventsDesk/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      parseFeed(f.kind, await r.text(), f.default_tz || "UTC").forEach((x) => raw.push({ x, source: `feed:${f.name}` }));
      await sb.from("event_sources").update({ last_status: "ok", last_synced_at: new Date().toISOString() }).eq("id", f.id);
    } catch (e) {
      errors.push({ source: f.name, error: e.message });
      await sb.from("event_sources").update({ last_status: `error: ${e.message}` }).eq("id", f.id);
    }
  }

  const rows = []; let skipped = 0;
  for (const { x, source } of raw) {
    const row = normalize(x, { today, source });
    if (!row) { skipped++; continue; }
    const k = dedupeKey(row.title, row.start_date);
    if (ids.has(row.id) || keys.has(k)) { skipped++; continue; }
    ids.add(row.id); keys.add(k); rows.push(row);
  }
  if (rows.length) {
    const { error } = await sb.from("events").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) errors.push({ source: "database", error: error.message });
  }
  const notes = rows.length ? `Queued: ${rows.slice(0, 8).map((r) => `${r.title} (${r.start_date})`).join("; ")}${rows.length > 8 ? "; ..." : ""}` : "No new events.";
  await sb.from("discovery_runs").insert({ area: areas.join(","), provider: `${provider}:${model}`, trigger, found: raw.length, added: rows.length, skipped, notes, errors });
  return { provider, model, areas, found: raw.length, added: rows.length, skipped, errors, queued: rows.map((r) => r.title) };
}
