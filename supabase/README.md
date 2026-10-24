# Brake Trainer — the account side

The trainer shares the **vcaso-performance** Supabase project with the Rodin
Hub, and shares its logins: a driver signs in with the same username and
password on both. Hub tables are prefixed `rh_`, the trainer's are `bt_`.

Project ref: `bqvygaqvwmakbrxnllws` (eu-central-1)
Driver email domain: `<handle>@drivers.rikichristo.com`, with `riki` aliased to
`riki@rikichristo.com`, exactly as the hub does it.

## Migrations

Applied in this order. They live in the project's migration history; this list
is the record of what they were for.

| Version | Name | What it does |
|---|---|---|
| 20261024171202 | `brake_trainer_tables_and_rls` | `bt_profiles`, `bt_access_requests`, `bt_settings`, `bt_runs`, `bt_laps`, plus row-level security mirroring the hub's pattern |
| 20261024171236 | `brake_trainer_guard_privileges_and_leaderboard` | the trigger that stops a driver approving themselves, and the two leaderboard functions |
| 20261024171252 | `brake_trainer_carry_over_hub_drivers` | the 7 hub drivers and Riki, carried over as approved |
| 20261024171325 | `brake_trainer_table_grants` | table grants to `authenticated`, and insert-only to `anon` for access requests |
| 20261024171453 | `brake_trainer_tighten_function_grants` | revoke EXECUTE on the trigger functions and the role helpers from `anon` |

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

**The leaderboard is two `security definer` functions, not a view or a policy
on `bt_runs`.** A board has to show other drivers' names and scores, which no
sane policy on the runs table would allow. The functions return only a name, a
best score and a count, and only for drivers who left themselves on the board.

**Approving a driver happens in an edge function** (`bt-access`), because
creating a login needs the service role, which must never reach a web page.
The function checks the caller's own token, asks the database `bt_is_coach()`,
and only then uses the admin key. The generated password is returned once and
never stored in readable form.

`bt-access` allows CORS from `https://rikichristo.github.io` and localhost
only. Approving from the claude.ai artifact preview will therefore fail —
that is deliberate, and approvals should be done from the real site.

## Known, deliberate advisor warnings

- `bt_is_coach`, `bt_is_approved`, `bt_leaderboard`, `bt_leaderboard_overall`
  are callable by signed-in users. That is the point; each one only ever
  reports on the caller or on drivers who opted in.
- `handle_new_user` and `set_updated_at` predate the trainer and belong to the
  older `profiles` tables. Left alone rather than changed blind.
- **Leaked password protection is off.** Worth switching on in the Supabase
  dashboard under Authentication → Policies, so a driver cannot set a password
  that is in a known breach list. Cannot be changed from here.
