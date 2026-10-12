// Public browser config. The anon key is designed to be public; row-level security protects the data.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ url: process.env.SUPABASE_URL || null, anonKey: process.env.SUPABASE_ANON_KEY || null });
}
