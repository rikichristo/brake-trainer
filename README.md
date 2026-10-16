# Brake Trainer

Follow a real reference lap with your own pedals. The white trace is the
reference; yours draws underneath, green where it matches and red where it
doesn't. Scored out of 100, with per-corner analysis of what went wrong.

**Open it: https://rikichristo.github.io/brake-trainer/**

Runs in Chrome. No install, no login. Reads a wheel and pedals through the
browser's Gamepad API, so pedals on their own USB board work alongside the
wheelbase.

## Reference laps

All real telemetry, logged on the rig and exported from iRacing.

| Class | Track | Lap |
|---|---|---|
| FIA F4 | Silverstone (Arena GP) | 2:02.333 |
| FIA F4 | Brands Hatch Indy | 0:44.183 |
| FIA F4 | Donington Park GP | 1:26.883 |
| FIA F4 | Snetterton 300 | 1:50.633 |
| FIA F4 | Thruxton | 1:10.033 |
| Super Formula Lights | Silverstone (Arena GP) | 1:51.383 |
| Super Formula Lights | Imola | 1:35.300 |
| Super Formula Lights | Hockenheim | 1:30.750 |
| Super Formula Lights | Adelaide | 1:13.733 |
| Super Formula Lights | Zandvoort | 1:25.183 |

## First run

1. Add a driver profile
2. **Link pedals** — step 1 asks you to press each pedal once. Do it: browsers
   hide a controller until it sends input, so a pedal board stays invisible
   until then.
3. Press each control to its stop when asked. You can let go before clicking;
   the furthest travel is what gets recorded.
4. Start with **Corners only** — it cuts the straights out.

If the steering feels slow, open **Feel** and raise the steering ratio. A
wheelbase sweeps a much larger angle than the car the reference came from.

## Files

- `index.html` — the whole app, self-contained
- `pedal-check.html` — diagnostic: lists every device and axis the browser sees
- `src/BrakeTrainer.jsx` — source
- `src/laps.json` — packed reference laps
