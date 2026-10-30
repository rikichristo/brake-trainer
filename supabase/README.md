# Brake Trainer — the account side

A VCASO Performance product. Drivers, runs, settings and the leaderboard live
in Riki's own Supabase project; every table the trainer owns is prefixed `bt_`
and nothing here reads or depends on any other application's tables.

Project ref: `bqvygaqvwmakbrxnllws` (eu-central-1)
Driver email domain: `<handle>@drivers.rikichristo.com`, with `riki` aliased to
`riki@rikichristo.com`.

> The project also hosts another of Riki's apps, under `rh_` tables. The two
> share the Supabase Auth user directory — so a driver has one username and
> password across Riki's tools, which is deliberate and a convenience for them
> — but the Brake Trainer's code and policies touch only `bt_` tables. If the
> other app were deleted tomorrow the trainer would not notice.

## Migrations

| Version | Name | What it does |
|---|---|---|
| 20261024171202 | `brake_trainer_tables_and_rls` | `bt_profiles`, `bt_access_requests`, `bt_settings`, `bt_runs`, `bt_laps` and their row-level security |
| 20261024171236 | `brake_trainer_guard_privileges_and_leaderboard` | the trigger that stops a driver approving themselves, and the two leaderboard functions |
| 20261024171252 | `brake_trainer_carry_over_hub_drivers` | the eight existing logins, carried in as approved |
| 20261024171325 | `brake_trainer_table_grants` | table grants to `authenticated`, insert-only to `anon` for access requests |
| 20261024171453 | `brake_trainer_tighten_function_grants` | revoke EXECUTE on trigger functions and role helpers from `anon` |
| 20261026…       | `brake_trainer_stand_alone_from_hub` | `bt_is_coach()` answers from `bt_profiles` alone — no cross-app lookup |

## Why it is shaped this way

**A driver can edit their own profile row**, because they need to turn the
leaderboard off. That same policy would let them set `approved = true` or
`role = 'coach'`. Row-level security cannot express "these columns are
immutable", so `bt_guard_profile()` forces `role`, `approved`, `handle` and
`id` back to their old values unless the caller really is the coach. This was
found by impersonating a driver's token and trying it, not by reading the
policy — worth repeating after any change here.

**Table grants are separate from policies.** The first version of these tables
had correct policies and no grants, so every query failed with "permission
denied" before any policy was consulted. If the app suddenly cannot read
anything, check `information_schema.role_table_grants` before the policies.

**The leaderboard is two `security definer` functions**, not a view or a policy
on `bt_runs`. A board has to show other drivers' names and scores, which no
sane policy on the runs table would allow. The functions return only a name, a
best score and a count, and only for drivers who left themselves on the board.

**Approving a driver happens in an edge function** (`bt-access`), because
creating a login needs the service role, which must never reach a web page.
The function checks the caller's own token, asks the database `bt_is_coach()`,
and only then uses the admin key. The generated password is returned once and
never stored in readable form.

**`verify_jwt: true` is not an authorisation check.** The edge-function gateway
accepts the publishable key as a valid JWT, so `bt-access` does its own
`getUser()` and `bt_is_coach()` check. Probed from the live site with the
publishable key and no session, it returns 401 from the function's own check.

`bt-access` allows CORS from `https://rikichristo.github.io` and localhost
only. Approving from a claude.ai artifact preview will fail — deliberately.

## Known, deliberate advisor warnings

- `bt_is_coach`, `bt_is_approved`, `bt_leaderboard`, `bt_leaderboard_overall`
  are callable by signed-in users. That is the point; each only ever reports on
  the caller or on drivers who opted in.
- `handle_new_user` and `set_updated_at` belong to older tables in this project
  and are not the trainer's. Left alone rather than changed blind.
- **Leaked password protection is off.** Worth switching on in the Supabase
  dashboard under Authentication, so a driver cannot set a password that is in
  a known breach list. Cannot be changed from the MCP tools.

---

# The shared team layer (`vp_*`)

Added 30 October 2026, when the trainer stopped being "Riki and his drivers"
and started being a platform that could be sold to teams.

## Why it exists

Rodin's structure — series, drivers, engineers, events — already existed and
was live under `rh_*`. But those names bake one customer into the schema, and
the whole point is to sell this to other teams. So the structure now lives in
neutral `vp_*` tables (VCASO Platform) where **Rodin is simply the first row in
`vp_teams`**.

**Nothing in `rh_*` was touched.** The Hub is live and another session is
actively building in it — six new tables appeared in two days. Moving the Hub
onto this layer is a separate job that needs coordinating with whoever is
working there, not something to do underneath a running app. Until then Rodin's
roster exists in both places, seeded from the Hub, and will drift if either
side is edited. That is a known cost of not stopping the Hub.

## Shape

```
vp_teams ─┬─ vp_members        (user → team, role: owner|coach|engineer|driver)
          ├─ vp_drivers        (a person in a team; user_id null until they have a login)
          ├─ vp_engineer_drivers
          ├─ vp_series ── vp_seasons ── vp_events ── vp_objectives
          └─ vp_drills         (the team's named drill library)
```

**Every table carries `team_id`**, including ones that could reach a team
through a join. Deliberate denormalisation: it makes every security check the
same single comparison instead of a chain of lookups.

**A driver is separate from an account** (`vp_drivers.user_id` is nullable).
That is what lets an engineer add data for a driver who has never signed in.

**`vp_drills` is the "Potato Brake Shape" library** — real telemetry an
engineer uploads once, named, usable by every driver in the team. Channels are
packed exactly as the built-in reference laps are, so the trainer can run one
without knowing where it came from.

## Who can do what

Riki's rule is that **everyone inside a team sees everything their team has**,
so reading is one comparison and all the restriction is on writing:

| | read | add data | manage the team |
|---|---|---|---|
| owner | ✓ | ✓ | ✓ |
| coach | ✓ | ✓ | ✓ |
| engineer | ✓ | ✓ | — |
| driver | ✓ | — | — |
| non-member | — | — | — |

`vp_can_write` is the first three; `vp_is_admin` the first two.

## Verify after any policy change

`supabase/checks/vp_permissions.sql` impersonates a real engineer, a real
driver and a complete outsider. Run it after touching any `vp_*` policy.

Reading a policy and believing it is not the same as testing it. The `bt_*`
tables shipped once with correct policies and no table grants, and once with a
policy that let a driver promote themselves to coach. Both were caught here,
not by review.

The boundary that matters commercially is the last two rows of that check: a
valid login with no membership must see zero drivers and zero drills.
