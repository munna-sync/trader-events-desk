// Public browser config. The anon key is designed to be public; row-level security protects the data.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store"); // never cache, so new settings apply immediately after a redeploy
  // Works with variables added by hand or by Vercel's Supabase integration (which also adds NEXT_PUBLIC_ copies).
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
  res.status(200).json({ url, anonKey });
}
