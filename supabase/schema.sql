-- Trader Events Desk on Vercel + Supabase
-- Run this once in Supabase: SQL Editor > New query > paste > Run. Then run seed.sql.

-- ---------- Events ----------
create table if not exists public.events (
  id              text primary key,
  title           text not null,
  organizer       text,
  start_date      date not null,
  end_date        date not null,
  start_time      text not null default '' check (start_time = '' or start_time ~ '^\d{2}:\d{2}$'),
  end_time        text not null default '' check (end_time = '' or end_time ~ '^\d{2}:\d{2}$'),
  tz              text not null default 'UTC',            -- IANA zone of the venue; the page converts to BDST and UTC
  venue           text,
  city            text,
  country         text,
  format          text not null default 'In-person' check (format in ('In-person', 'Virtual', 'Hybrid')),
  status          text not null default 'Upcoming' check (status in ('Registration Open', 'Early Bird', 'Upcoming', 'Application Only', 'Invite Only', 'Sold Out', 'Closed')),
  cost            text,
  cost_min        numeric,                                -- 0 = free, null = unknown
  language        text not null default 'English',
  url             text,
  source_url      text,
  date_confidence text not null default 'confirmed' check (date_confidence in ('confirmed', 'tentative')),
  description     text,
  categories      text[] not null default '{}',
  niche           text,
  groups          text[] not null default '{}',
  scope           text,
  approved        boolean not null default false,
  auto_tagged     boolean not null default true,
  source          text not null default 'manual',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint events_dates check (end_date >= start_date)
);
create index if not exists events_start_idx on public.events (start_date);

-- ---------- Personal plans (Plan to attend / Interested) ----------
create table if not exists public.plans (
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id  text not null references public.events (id) on delete cascade,
  state     text not null check (state in ('going', 'interested')),
  at        timestamptz not null default now(),
  primary key (user_id, event_id)
);

-- ---------- Discovery ----------
create table if not exists public.discovery_runs (
  id       bigint generated always as identity primary key,
  ran_at   timestamptz not null default now(),
  trigger  text,
  provider text,
  area     text,
  found    int not null default 0,
  added    int not null default 0,
  skipped  int not null default 0,
  notes    text,
  errors   jsonb not null default '[]'
);

-- Optional feeds the daily job also reads (RSS with event dates, iCal, or JSON event APIs).
create table if not exists public.event_sources (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  kind           text not null check (kind in ('rss', 'ical', 'json')),
  url            text not null,
  default_tz     text not null default 'UTC',
  is_active      boolean not null default true,
  last_status    text,
  last_synced_at timestamptz
);

-- Which AI provider and model the daily job uses (one row, edited from the portal).
create table if not exists public.ai_settings (
  id           int primary key default 1 check (id = 1),
  provider     text not null default 'claude' check (provider in ('claude', 'openai', 'gemini')),
  model_claude text,
  model_openai text,
  model_gemini text,
  max_searches int not null default 12 check (max_searches between 1 and 30),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now()
);
insert into public.ai_settings (id) values (1) on conflict (id) do nothing;

-- API keys saved from the portal, encrypted by the server with KEYS_SECRET.
-- No browser can read or write this table: RLS is on with no policies; only the server (service role) uses it.
create table if not exists public.ai_keys (
  provider   text primary key check (provider in ('claude', 'openai', 'gemini')),
  key_cipher text not null,
  key_hint   text not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ---------- Admins ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();
drop trigger if exists ai_settings_touch on public.ai_settings;
create trigger ai_settings_touch before update on public.ai_settings for each row execute function public.touch_updated_at();

-- ---------- Row-level security ----------
alter table public.events         enable row level security;
alter table public.plans          enable row level security;
alter table public.discovery_runs enable row level security;
alter table public.event_sources  enable row level security;
alter table public.ai_settings    enable row level security;
alter table public.ai_keys        enable row level security;
alter table public.admins         enable row level security;

drop policy if exists events_read on public.events;
create policy events_read on public.events for select using (approved or public.is_admin());
drop policy if exists events_admin_insert on public.events;
create policy events_admin_insert on public.events for insert with check (public.is_admin());
drop policy if exists events_admin_update on public.events;
create policy events_admin_update on public.events for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists events_admin_delete on public.events;
create policy events_admin_delete on public.events for delete using (public.is_admin());

drop policy if exists plans_own on public.plans;
create policy plans_own on public.plans for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists runs_admin on public.discovery_runs;
create policy runs_admin on public.discovery_runs for select using (public.is_admin());
drop policy if exists sources_admin on public.event_sources;
create policy sources_admin on public.event_sources for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists ai_settings_admin on public.ai_settings;
create policy ai_settings_admin on public.ai_settings for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select using (user_id = auth.uid());
-- ai_keys: intentionally no policies.

-- Live updates in the browser when events change.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;

-- After you sign in on the site once, make yourself admin (replace the email):
-- insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
