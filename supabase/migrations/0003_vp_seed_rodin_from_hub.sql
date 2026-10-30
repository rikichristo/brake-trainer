-- Seed the first tenant from the Hub's live data. Reads rh_* and writes vp_*;
-- nothing in rh_* is modified. Ids are carried across unchanged so the two
-- sides stay obviously the same people, and so this can be re-run safely.
insert into public.vp_teams (name, slug)
values ('Rodin Motorsport', 'rodin')
on conflict (slug) do nothing;

insert into public.vp_drivers (id, team_id, full_name, car_no, nat, active, user_id)
select d.id, (select id from public.vp_teams where slug='rodin'),
       d.full_name, d.car_no, d.nat, d.active,
       (select p.id from public.rh_profiles p where p.driver_id = d.id limit 1)
from public.rh_drivers d
on conflict (id) do nothing;

-- Riki runs the platform, so he is the owner rather than one coach among many.
insert into public.vp_members (team_id, user_id, role, driver_id)
select (select id from public.vp_teams where slug='rodin'), p.id,
       case when u.email = 'riki@rikichristo.com' then 'owner'
            when p.role in ('coach','engineer','driver') then p.role
            else 'driver' end,
       p.driver_id
from public.rh_profiles p join auth.users u on u.id = p.id
on conflict (team_id, user_id) do nothing;

insert into public.vp_engineer_drivers (team_id, engineer_id, driver_id)
select (select id from public.vp_teams where slug='rodin'), ed.engineer_id, ed.driver_id
from public.rh_engineer_drivers ed
where exists (select 1 from public.vp_drivers vd where vd.id = ed.driver_id)
on conflict (engineer_id, driver_id) do nothing;

insert into public.vp_series (id, team_id, name)
select s.id, (select id from public.vp_teams where slug='rodin'), s.name
from public.rh_series s
on conflict (id) do nothing;

insert into public.vp_seasons (team_id, series_id, year, name, current)
select (select id from public.vp_teams where slug='rodin'), s.id, 2026, s.name || ' 2026', true
from public.vp_series s
on conflict (series_id, year) do nothing;

insert into public.vp_events (id, team_id, season_id, kind, name, circuit, location, date_from, date_to)
select e.id, (select id from public.vp_teams where slug='rodin'),
       (select sn.id from public.vp_seasons sn where sn.series_id = e.series_id and sn.year = 2026),
       case e.kind when 'race' then 'round' else e.kind end,
       e.name, e.track, e.location, e.date_from, e.date_to
from public.rh_events e
where e.series_id is not null
  and exists (select 1 from public.vp_seasons sn where sn.series_id = e.series_id and sn.year = 2026)
on conflict (id) do nothing;
