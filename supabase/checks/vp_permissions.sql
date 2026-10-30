-- Permission check for the shared team layer. Run after ANY change to vp_*
-- policies. It impersonates a real engineer, a real driver and a complete
-- outsider, and tries things each of them should and should not be able to do.
--
-- Reading a policy and believing it is not the same as testing it: the bt_*
-- tables shipped once with correct policies and no table grants, and once
-- with a policy that let a driver promote themselves to coach. Both were
-- found here, not by review.
create temp table _v (step text, got text, want text);
do $$
declare
  team uuid; eng uuid; drv uuid; n int; o text[] := '{}';
begin
  select id into team from public.vp_teams where slug='rodin';
  select user_id into eng from public.vp_members where team_id=team and role='engineer' limit 1;
  select user_id into drv from public.vp_members where team_id=team and role='driver' limit 1;

  perform set_config('role','authenticated', true);

  perform set_config('request.jwt.claims', json_build_object('sub',eng::text,'role','authenticated')::text, true);
  select count(*) into n from public.vp_drivers;
  o := o || format('engineer sees every team driver|%s|7', n)::text;
  begin
    insert into public.vp_drills (team_id, name, description, payload)
    values (team, 'probe drill', 'probe', '{"probe":true}'::jsonb);
    o := o || 'engineer can add a drill|yes|yes'::text;
  exception when others then o := o || 'engineer can add a drill|no|yes'::text; end;
  begin
    insert into public.vp_members (team_id, user_id, role) values (team, eng, 'owner');
    o := o || 'engineer promoting themselves|allowed|blocked'::text;
  exception when others then o := o || 'engineer promoting themselves|blocked|blocked'::text; end;

  perform set_config('request.jwt.claims', json_build_object('sub',drv::text,'role','authenticated')::text, true);
  select count(*) into n from public.vp_events where team_id=team;
  o := o || format('driver sees the calendar|%s|3', n)::text;
  begin
    insert into public.vp_drills (team_id, name, payload) values (team, 'driver drill', '{}'::jsonb);
    o := o || 'driver adding a drill|allowed|blocked'::text;
  exception when others then o := o || 'driver adding a drill|blocked|blocked'::text; end;

  -- the boundary that matters commercially: a login with no membership
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated')::text, true);
  select count(*) into n from public.vp_drivers;
  o := o || format('non-member sees no drivers|%s|0', n)::text;
  select count(*) into n from public.vp_drills;
  o := o || format('non-member sees no drills|%s|0', n)::text;

  perform set_config('role','postgres', true);
  delete from public.vp_drills where description = 'probe';
  insert into _v select split_part(x,'|',1), split_part(x,'|',2), split_part(x,'|',3) from unnest(o) x;
end $$;
select step, got, want, case when got=want then 'ok' else 'FAIL' end as verdict from _v;
