-- Riki's rule: everyone inside a team sees everything their team has. So
-- reading is one comparison -- is this row's team one of mine -- and the
-- restriction lives entirely on writing.
--
-- Four roles: owner and coach run the team, engineers add data, drivers read.
-- vp_can_write covers the first three, which is the point of the change: an
-- engineer adds data for their drivers without going through Riki.

create or replace function public.vp_is_member(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vp_members m
                 where m.user_id = auth.uid() and m.team_id = t);
$$;

create or replace function public.vp_my_role(t uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.vp_members m
  where m.user_id = auth.uid() and m.team_id = t;
$$;

create or replace function public.vp_can_write(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.vp_my_role(t) in ('owner','coach','engineer'), false);
$$;

create or replace function public.vp_is_admin(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.vp_my_role(t) in ('owner','coach'), false);
$$;

alter table public.vp_teams             enable row level security;
alter table public.vp_drivers           enable row level security;
alter table public.vp_members           enable row level security;
alter table public.vp_engineer_drivers  enable row level security;
alter table public.vp_series            enable row level security;
alter table public.vp_seasons           enable row level security;
alter table public.vp_events            enable row level security;
alter table public.vp_objectives        enable row level security;
alter table public.vp_drills            enable row level security;

create policy vp_teams_read on public.vp_teams for select to authenticated
  using ((select public.vp_is_member(id)));
create policy vp_teams_upd on public.vp_teams for update to authenticated
  using ((select public.vp_is_admin(id))) with check ((select public.vp_is_admin(id)));

create policy vp_members_read on public.vp_members for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_members_write on public.vp_members for all to authenticated
  using ((select public.vp_is_admin(team_id))) with check ((select public.vp_is_admin(team_id)));

create policy vp_drivers_read on public.vp_drivers for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_drivers_write on public.vp_drivers for all to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));

create policy vp_engdrv_read on public.vp_engineer_drivers for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_engdrv_write on public.vp_engineer_drivers for all to authenticated
  using ((select public.vp_is_admin(team_id))) with check ((select public.vp_is_admin(team_id)));

create policy vp_series_read on public.vp_series for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_series_write on public.vp_series for all to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));

create policy vp_seasons_read on public.vp_seasons for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_seasons_write on public.vp_seasons for all to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));

create policy vp_events_read on public.vp_events for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_events_write on public.vp_events for all to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));

create policy vp_objectives_read on public.vp_objectives for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_objectives_write on public.vp_objectives for all to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));

create policy vp_drills_read on public.vp_drills for select to authenticated
  using ((select public.vp_is_member(team_id)));
create policy vp_drills_ins on public.vp_drills for insert to authenticated
  with check ((select public.vp_can_write(team_id)) and author_id = (select auth.uid()));
create policy vp_drills_upd on public.vp_drills for update to authenticated
  using ((select public.vp_can_write(team_id))) with check ((select public.vp_can_write(team_id)));
create policy vp_drills_del on public.vp_drills for delete to authenticated
  using ((select public.vp_can_write(team_id)));

-- Policies decide which rows; grants decide whether the role may touch the
-- table at all. Missing these is what made every bt_* query fail with
-- "permission denied" before a single policy was ever consulted.
grant select, update on public.vp_teams to authenticated;
grant select, insert, update, delete on
  public.vp_drivers, public.vp_members, public.vp_engineer_drivers,
  public.vp_series, public.vp_seasons, public.vp_events,
  public.vp_objectives, public.vp_drills
  to authenticated;

revoke all on function public.vp_touch() from anon, authenticated, public;
revoke all on function public.vp_is_member(uuid) from anon, public;
revoke all on function public.vp_my_role(uuid)   from anon, public;
revoke all on function public.vp_can_write(uuid) from anon, public;
revoke all on function public.vp_is_admin(uuid)  from anon, public;
grant execute on function public.vp_is_member(uuid) to authenticated;
grant execute on function public.vp_my_role(uuid)   to authenticated;
grant execute on function public.vp_can_write(uuid) to authenticated;
grant execute on function public.vp_is_admin(uuid)  to authenticated;
