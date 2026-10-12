// Admin-only API for the portal's "AI & discovery" tab.
// GET  -> provider status (which keys exist, where they come from, last 4 characters only)
// POST {action: "save-key", provider, key} | {action: "remove-key", provider}
//      {action: "test-key", provider} | {action: "run", area}
// The caller must send their Supabase session token and be listed in the `admins` table.
import { serviceClient, requireAdmin, encrypt, hint, resolveKey, loadSettings, canStoreKeys } from "../../lib/server.mjs";
import { PROVIDERS, testKey } from "../../lib/providers.mjs";
import { runDiscovery } from "../../lib/discovery.mjs";

export const config = { maxDuration: 300 };

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  let sb;
  try { sb = serviceClient(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  const admin = await requireAdmin(req, sb);
  if (!admin) return res.status(403).json({ ok: false, error: "Sign in with an admin account to use this." });

  try {
    if (req.method === "GET") {
      const { data: saved = [] } = await sb.from("ai_keys").select("provider,key_hint,updated_at");
      const settings = await loadSettings(sb);
      const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => {
        const row = saved.find((r) => r.provider === id);
        const env = process.env[p.envKey];
        return [id, {
          label: p.label, defaultModel: p.defaultModel, keyUrl: p.keyUrl, billingUrl: p.billingUrl, searchNote: p.searchNote, envKey: p.envKey,
          source: row ? "portal" : env ? "vercel" : null,
          hint: row ? row.key_hint : env ? hint(env) : null,
          updatedAt: row?.updated_at || null,
        }];
      }));
      return res.status(200).json({ ok: true, settings, providers, canStoreKeys: canStoreKeys(), cronSchedule: "15 0 * * * (UTC) = between 06:00 and 06:59 BDST" });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use GET or POST" });
    const body = await readBody(req);
    const provider = body.provider;
    if (["save-key", "remove-key", "test-key"].includes(body.action) && !PROVIDERS[provider]) return res.status(400).json({ ok: false, error: "Unknown provider" });

    if (body.action === "save-key") {
      const key = String(body.key || "").trim();
      if (key.length < 20) return res.status(400).json({ ok: false, error: "That doesn't look like a full API key." });
      const { error } = await sb.from("ai_keys").upsert({ provider, key_cipher: encrypt(key), key_hint: hint(key), updated_by: admin.id, updated_at: new Date().toISOString() });
      if (error) throw error;
      return res.status(200).json({ ok: true, message: `Saved. The key ending ${key.slice(-4)} is stored encrypted.` });
    }
    if (body.action === "remove-key") {
      const { error } = await sb.from("ai_keys").delete().eq("provider", provider);
      if (error) throw error;
      return res.status(200).json({ ok: true, message: "Removed the key saved in the portal." });
    }
    if (body.action === "test-key") {
      const { key, source } = await resolveKey(sb, provider);
      if (!key) return res.status(400).json({ ok: false, error: `No key found for ${PROVIDERS[provider].label}.` });
      const settings = await loadSettings(sb);
      const reply = await testKey(provider, key, settings.models[provider]);
      return res.status(200).json({ ok: true, message: `Key works (from ${source === "portal" ? "the portal" : "Vercel"}). Model ${settings.models[provider]} replied: ${reply}` });
    }
    if (body.action === "run") {
      const result = await runDiscovery(sb, { area: body.area || "auto", trigger: `manual:${admin.email || admin.id}`, deadline: Date.now() + 270_000 });
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
}
