// Server helpers: Supabase service client, admin check, API key storage (AES-256-GCM).
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { PROVIDERS } from "./providers.mjs";

export function serviceClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Verifies the caller's Supabase session token and that they are listed in `admins`.
export async function requireAdmin(req, sb) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: row } = await sb.from("admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return row ? data.user : null;
}

function cipherKey() {
  const s = process.env.KEYS_SECRET;
  if (!s || s.length < 16) return null;
  return crypto.createHash("sha256").update(s).digest();
}
export function canStoreKeys() { return !!cipherKey(); }

export function encrypt(plain) {
  const k = cipherKey(); if (!k) throw new Error("Set KEYS_SECRET (16+ characters) in Vercel before saving keys in the portal");
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
export function decrypt(blob) {
  const k = cipherKey(); if (!k) throw new Error("KEYS_SECRET is missing, so keys saved in the portal can't be read");
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
export const hint = (key) => (key.length > 8 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "••••");

// Portal-saved key wins; otherwise the Vercel environment variable.
export async function resolveKey(sb, provider) {
  const { data } = await sb.from("ai_keys").select("key_cipher").eq("provider", provider).maybeSingle();
  if (data?.key_cipher) return { key: decrypt(data.key_cipher), source: "portal" };
  const env = process.env[PROVIDERS[provider].envKey];
  return env ? { key: env, source: "vercel" } : { key: null, source: null };
}

export async function loadSettings(sb) {
  const { data } = await sb.from("ai_settings").select("*").eq("id", 1).maybeSingle();
  const s = data || {};
  const provider = PROVIDERS[s.provider] ? s.provider : (PROVIDERS[process.env.AI_PROVIDER] ? process.env.AI_PROVIDER : "claude");
  return {
    provider,
    models: {
      claude: s.model_claude || PROVIDERS.claude.defaultModel,
      openai: s.model_openai || PROVIDERS.openai.defaultModel,
      gemini: s.model_gemini || PROVIDERS.gemini.defaultModel,
    },
    maxSearches: Math.min(30, Math.max(1, Number(s.max_searches) || 12)),
    enabled: s.enabled !== false,
  };
}
