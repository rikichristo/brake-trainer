-- The shared team layer for the VCASO platform.
--
-- Rodin's structure already exists under rh_*, but those names bake one
-- customer into the schema, and the point is to sell this to other teams. So
-- the structure moves to neutral vp_* tables where Rodin is simply the first
-- row in vp_teams.
--
-- ADDITIVE ON PURPOSE. Nothing in rh_* is touched. The Hub is live and another
-- session is actively building in it (six new tables in two days), so moving
-- the Hub onto this layer is a separate job that needs coordinating, not
-- something to do underneath it while it runs.
--
-- Every table carries team_id, including the ones that could reach a team
-- through a join. That is a deliberate denormalisation: it makes every
-- row-level security check the same single comparison instead of a chain of
-- lookups, which is both faster and far easier to be sure of.

create table if not exists public.vp_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,38}$'),
  created_at timestamptz not null default now()
);

-- A driver is a person in a team, who may or may not have a login yet.
-- Keeping the entity separate from the account is what lets an engineer add
-- data for a driver before that driver has ever signed in.
create table if not exists public.vp_drivers (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  full_name text not null,
  car_no text not null default '',
  nat text not null default '',
  active boolean not null default true,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists vp_drivers_team on public.vp_drivers (team_id);
create unique index if not exists vp_drivers_user
  on public.vp_drivers (user_id) where user_id is not null;

-- Membership and what someone may do. A driver's membership also points at
-- their driver row.
create table if not exists public.vp_members (
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'driver' check (role in ('owner','coach','engineer','driver')),
  driver_id uuid references public.vp_drivers(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists vp_members_user on public.vp_members (user_id);

-- Which engineer looks after which driver. Everyone in a team can see
-- everything, so this is for showing an engineer their own drivers first,
-- not for hiding anything from anyone.
create table if not exists public.vp_engineer_drivers (
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  engineer_id uuid not null references auth.users(id) on delete cascade,
  driver_id uuid not null references public.vp_drivers(id) on delete cascade,
  primary key (engineer_id, driver_id)
);

create table if not exists public.vp_series (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table if not exists public.vp_seasons (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  series_id uuid not null references public.vp_series(id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  name text not null default '',
  current boolean not null default false,
  created_at timestamptz not null default now(),
  unique (series_id, year)
);

-- A round, a test day or a sim session. This is the calendar a driver sees
-- when they pick a series: every event, whether or not there is data against
-- it yet.
create table if not exists public.vp_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  season_id uuid not null references public.vp_seasons(id) on delete cascade,
  kind text not null default 'round' check (kind in ('round','test','sim')),
  round_no integer,
  name text not null,
  circuit text not null default '',
  location text not null default '',
  date_from date,
  date_to date,
  created_at timestamptz not null default now()
);
create index if not exists vp_events_season on public.vp_events (season_id, date_from);

-- What an engineer or coach wants out of an event. driver_id null means it is
-- set for the whole team.
create table if not exists public.vp_objectives (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  event_id uuid not null references public.vp_events(id) on delete cascade,
  driver_id uuid references public.vp_drivers(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 2000),
  author_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vp_objectives_event on public.vp_objectives (event_id);

-- The team's drill library: real telemetry an engineer uploads once, named,
-- and usable by every driver in the team. "Potato Brake Shape", "Peak and
-- Release". Channels are packed exactly as the built-in reference laps are,
-- so the trainer can run one without knowing where it came from.
create table if not exists public.vp_drills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.vp_teams(id) on delete cascade,
  series_id uuid references public.vp_series(id) on delete set null,
  event_id uuid references public.vp_events(id) on delete set null,
  driver_id uuid references public.vp_drivers(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 2000),
  source text not null default '' check (length(source) <= 200),
  payload jsonb not null,
  author_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vp_drills_team on public.vp_drills (team_id, created_at desc);

create or replace function public.vp_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists vp_objectives_touch on public.vp_objectives;
create trigger vp_objectives_touch before insert or update on public.vp_objectives
  for each row execute function public.vp_touch();

drop trigger if exists vp_drills_touch on public.vp_drills;
create trigger vp_drills_touch before insert or update on public.vp_drills
  for each row execute function public.vp_touch();
