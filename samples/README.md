# Sample logger files

Two laps of real car telemetry, used to test the CSV importer against a
logger that is not iRacing. They are here so a regression in header
matching or time parsing shows up immediately rather than on someone's rig.

| File | Lap | Peak brake |
|---|---|---|
| `D2PM_SEE.csv` | 1:32.920 | 165 bar |
| `D2AM_GIU.csv` | 1:31.440 | 201 bar |

Both: 100 Hz, time logged as `seconds:hundredths`, one lap of roughly
4.4 km with eight braking zones. Channels are `rPedal` (throttle, reads
past 100), `Stg_Angle` (steering in degrees), `Brake_Press` (bar),
`CarSpeed`, `lapDistance`.
