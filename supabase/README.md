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
