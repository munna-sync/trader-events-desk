// Vercel Cron entry point (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
// You can also run it by hand: curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/discover?area=trading
import { serviceClient } from "../../lib/server.mjs";
import { runDiscovery } from "../../lib/discovery.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const started = Date.now();
  try {
    const result = await runDiscovery(serviceClient(), { area: req.query?.area, trigger: "cron", deadline: started + 270_000 });
    res.status(200).json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
