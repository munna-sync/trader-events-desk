# Trader Events Desk on Vercel

The same portal as the claude.ai version (timeframe tabs, BDST and UTC times, My plan, admin review queue), running on your own Vercel site with a Supabase database. The daily discovery job runs on Vercel and can use **Claude, ChatGPT (OpenAI) or Gemini**, which you choose in the portal.

```
Browser (public/index.html + backend.js)
   │  reads events, saves plans, admin edits      ──►  Supabase (Postgres + email sign-in + row-level security)
   │  admin: AI settings, keys, "Run now"          ──►  /api/admin/ai   (Vercel function, checks you are an admin)
Vercel Cron, daily 23:45 UTC = 05:45 BDST          ──►  /api/cron/discover
                                                         └─ asks your chosen AI to web-search for new events
                                                         └─ checks dates, removes duplicates, auto-tags categories
                                                         └─ saves new events as "awaiting approval" + logs the run
```

## What you need
- A free [GitHub](https://github.com) account, a [Vercel](https://vercel.com) account and a [Supabase](https://supabase.com) account.
- An API key for at least one AI provider (steps below). You can add more later and switch at any time.

## Step 1: Create the database (Supabase, about 5 minutes)
1. In Supabase, click **New project**. Pick a region close to you (Singapore or Mumbai for Bangladesh) and save the database password somewhere safe.
2. Open **SQL Editor › New query**, paste all of `supabase/schema.sql`, click **Run**.
3. New query again, paste `supabase/seed.sql`, click **Run**. This loads the 54 researched events.
4. Open **Project Settings › API** and copy three values: **Project URL**, **anon public** key and **service_role** key. Keep the service_role key private.

## Step 2: Put the code on GitHub
1. Unzip this project. On GitHub click **New repository**, name it (for example `trader-events-desk`), keep it **Private**, create it.
2. Click **uploading an existing file**, drag in everything from the unzipped folder (including `api`, `lib`, `public`, `supabase`, `vercel.json`, `package.json`), and commit. Do not upload `node_modules` or a `.env` file.

## Step 3: Deploy on Vercel
1. In Vercel click **Add New › Project**, import the GitHub repository. Framework preset: **Other**. Leave build settings empty.
2. Before clicking Deploy, open **Environment Variables** and add (see `.env.example`):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (server only) |
| `CRON_SECRET` | any random text, 16+ characters |
| `KEYS_SECRET` | another random text, 16+ characters (lets you save AI keys from the portal) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | optional; you can paste keys in the portal instead |

3. Click **Deploy**. Your site appears at `https://<project>.vercel.app`.

## Step 4: Turn on sign-in and make yourself admin
1. Supabase › **Authentication › URL Configuration**: set **Site URL** to your Vercel address and add it under **Redirect URLs**.
2. Open your site, click **Sign in**, enter your email and click the link you receive.
3. Supabase › SQL Editor, run (with your email):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
4. Reload the site. The **Admin** button now appears.

## Step 5: Choose the AI and add a key (in the portal)
Admin › **AI & discovery**:
1. Pick **Claude**, **ChatGPT (OpenAI)** or **Gemini**. You can change the model name; the defaults are `claude-sonnet-5-5`, `gpt-5.5` and `gemini-3.8-flash`.
2. Paste the API key for that provider, click **Save key**, then **Test key**. The key is encrypted on the server with `KEYS_SECRET`; the page only ever shows its first and last characters.
3. Click **Save settings**, then **Run now** to try a search straight away. New finds appear in the **Review queue** for you to approve.

A key saved in the portal takes priority over the same provider's Vercel environment variable. Use **Remove** to fall back to the Vercel variable.

### Getting each API key
**Claude (Anthropic)**
1. Sign in at [platform.claude.com](https://platform.claude.com).
2. Add credit under [Settings › Billing](https://platform.claude.com/settings/billing). API usage is billed separately from a Claude.ai subscription.
3. [Settings › API keys](https://platform.claude.com/settings/keys) › **Create key**. Copy it (starts with `sk-ant-`, shown once).
- Web search costs $10 per 1,000 searches plus normal token costs.

**ChatGPT (OpenAI)**
1. Sign in at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Add credit under [Billing](https://platform.openai.com/account/billing/overview). A ChatGPT Plus subscription does not include API usage.
3. **Create new secret key**, copy it (starts with `sk-`, shown once).
- Web search is billed per tool call plus tokens; see OpenAI's pricing page.

**Gemini (Google)**
1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with Google.
2. **Create API key**, choose or import a Google Cloud project, copy the key.
3. There is a free tier; enable billing in that project for higher limits.
- Gemini 3 and newer include 5,000 free search requests a month, then $14 per 1,000.

## How the daily discovery job works on Vercel
- `vercel.json` schedules `/api/cron/discover` at **23:45 UTC (05:45 BDST)**. Vercel sends `Authorization: Bearer <CRON_SECRET>`, so nobody else can trigger it.
- Each run covers one area, rotating daily: financial markets & trading → trade, SaaS & fintech → business, economy & leadership. "Run now" in the portal can do any area or all three.
- The job sends the chosen AI a list of events you already have, asks it to web-search for new ones (up to the "Web searches per run" setting), and to reply in a fixed JSON format.
- The server then checks every item: real dates, not already over, at most 2 years ahead, a valid time zone (else UTC), allowed status and format values, a link. Items without a confirming link are marked "Dates TBC". Duplicates are skipped by id and by similar title in the same month. Categories outside the 19-category list are dropped, and missing ones are filled by the keyword auto-tagger.
- New events are saved **unapproved**. Nothing appears publicly until you approve it in the Review queue.
- Optional: add rows to the `event_sources` table (kind `rss`, `ical` or `json`) and the job reads those feeds too, without using the AI.
- Every run is logged with provider, area, counts and any errors, shown under **AI & discovery**.

**Hobby (free) plan limits:** cron runs once a day and Vercel may start it any time within that hour (so between 05:45 and 06:44 BDST); each run can last up to 300 seconds, which is why one area is searched per day. The Pro plan runs on the exact minute and allows longer runs. Vercel's Hobby plan is meant for personal, non-commercial use, so use Pro if this is a Doin Tech business tool.

Test the job by hand at any time:
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" "https://<project>.vercel.app/api/cron/discover?area=trading"
```
Vercel › Project › **Settings › Cron Jobs** shows the schedule and logs.

## The claude.ai version
The claude.ai portal and its daily scheduled task keep running separately and do not share data with this site. Once the Vercel site is live, pause the claude.ai scheduled task "Trader events daily discovery" so you are not paying for two searches a day.

## Files
| Path | What it is |
|---|---|
| `public/index.html` | The portal page (generated from the claude.ai version). |
| `public/backend.js` | Browser data layer for Supabase, email sign-in, and the AI & discovery admin panel. |
| `api/cron/discover.js` | Daily cron endpoint. |
| `api/admin/ai.js` | Admin-only API: key status, save/remove/test key, run now. |
| `api/config.js` | Gives the browser the public Supabase URL and anon key. |
| `lib/providers.mjs` | Claude, OpenAI and Gemini web-search calls. Add another provider here. |
| `lib/discovery.mjs` | Prompt, validation, de-duplication, feeds, saving, run log. |
| `lib/server.mjs` | Supabase service client, admin check, key encryption. |
| `lib/taxonomy.mjs` | The 19 categories and keyword auto-tagger. |
| `supabase/schema.sql`, `supabase/seed.sql` | Database tables, access rules, and the 54 starting events. |
| `tests/discovery.test.mjs` | `npm test`: 11 offline tests with all three providers mocked. |
