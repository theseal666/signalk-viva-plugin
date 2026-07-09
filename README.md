# signalk-viva-plugin
![signalk-viva logo][logo]

[logo]: IMG/signalK-viva-plugin_logo.png "signalk-viva"


a plugin that scrapes data from the Svenska sjöfartsverket viva-system from a configurable number of stations around my location to monitor for wind, barometric pressure, configurable alarms for sudden changes in conditions and visualisation in KIP and freeboard-SK.

## What it does

- Reads your vessel position from Signal K and finds the nearest ViVa stations
  within a configurable radius (nearest first, up to a configurable count).
  Only stations that actually report **wind and/or air pressure** are selected —
  stations that only report water level or flow are skipped automatically.
- Re-discovers stations automatically when you have sailed more than ~10 km,
  so the set of stations follows you along the coast.
- Polls each station's JSON feed (no HTML scraping needed — same service the
  ViVa app uses) and publishes deltas in SI units.
- Watches for trouble and raises Signal K **notifications**:
  - **Wind rise** — average wind increased more than N m/s within a window
  - **Wind shift** — direction changed more than N degrees within a window
  - **Pressure drop** — pressure fell more than N hPa within a window

## Published paths

For each station, under `environment.observations.viva.<station>.`:

| Path suffix          | ViVa sample   | Units |
|----------------------|---------------|-------|
| `wind.averageSpeed`  | Medelvind     | m/s   |
| `wind.gust`          | Byvind        | m/s   |
| `wind.directionTrue` | Heading field | rad   |
| `pressure`           | Lufttryck     | Pa    |
| `temperature`        | Lufttemp      | K     |
| `water.temperature`  | Vattentemp    | K     |
| `water.level`        | Vattenstånd   | m     |
| `distance`           | — (great-circle distance from vessel to station, recalculated every poll) | m |

Example: `environment.observations.viva.bonan.wind.averageSpeed`

Live data in the Signal K Data Browser (here from Vinga and Svenska Högarna):

![ViVa observations in the Signal K Data Browser](IMG/screenshot-data-browser.png)

![Alarm notifications in action](IMG/Alarms.png)

Alarms are published as standard Signal K notifications, e.g.
`notifications.environment.observations.viva.bonan.pressureDrop` with
`state: "alert"` and `method: ["visual", "sound"]`, and cleared with
`state: "normal"` when conditions ease (with a small hysteresis to avoid
flapping). Any notification-aware app — KIP, WilhelmSK, the server's built-in
alarm handling — will show and sound them.

## Configuration

In the Signal K admin UI under **Server → Plugin Config → Sjöfartsverket ViVa
observations**:

| Setting            | Default | Notes                                             |
|--------------------|---------|---------------------------------------------------|
| Poll interval      | 60 s    | ViVa stations update roughly every 1–10 minutes   |
| Search radius      | 50 km   | Around current vessel position                    |
| Max stations       | 3       | Nearest qualifying stations                       |
| Extra station IDs  | —       | Always followed, regardless of distance           |
| Fallback position  | —       | Used when there is no GPS position — handy at the dock or for testing |
| Meteo targets      | on      | Publish stations as `meteo.*` contexts for chartplotters (see below) |
| Alarm chart notes  | on      | Place a note at the station when an alarm is active (see below) |
| Wind rise alarm    | 5 m/s / 30 min  |                                           |
| Wind shift alarm   | 45° / 30 min    |                                           |
| Pressure drop alarm| 2 hPa / 120 min | ≥ 1 hPa/h sustained usually means real weather coming — tune to taste |

Alarm windows need at least half the window of collected history before they
can fire, so you won't get spurious alarms right after startup.

![Plugin configuration in the Signal K admin UI](IMG/screenshot-plugin-config.png)

### Finding station IDs

Station list with IDs and positions:

```
https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/
```

Single station (this is what the plugin polls):

```
https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/33
```

## Freeboard-SK: stations and alarms on the chart

Two optional features (both on by default) put the stations on the chart:

- **Weather station targets** — each station is also published as a Signal K
  `meteo.*` context with its position, name and observations. Freeboard-SK
  shows these as windsock icons on the map; tap one to see its current
  wind, direction and temperature.
- **Alarm notes** — when an alarm fires (wind rise, wind shift, pressure
  drop), the plugin places a chart note ("⚠ Vinga") at the station position
  with the alarm text, and removes it when the alarm clears. Requires a
  resources provider on the server (the bundled `resources-provider` plugin —
  enabled by default on recent servers). Tap the marker in Freeboard-SK to
  read what happened.

### Freeboard-SK setup checklist

The windsocks are easy to lose to a display toggle — if they don't show,
walk through this list:

1. **Settings → Signal K tab**: tick **Weather (Meteo)** under "Filter
   Stream data".
2. Same place: keep **Max. distance from vessel** at **None** if the vessel
   has no GPS position — with a distance set, Freeboard cannot compute
   distances and hides all targets.
3. **Map display**: in the "⋯" menu on the map toolbar, make sure
   **Show Vessels** is on — weather stations are drawn on the same layer as
   AIS vessels and hide together with them (an eye-with-slash icon on the map
   means display layers are hidden).
4. Keep **Show Notes** on to see the ⚠ alarm notes.
5. Diagnostic: the ☰ menu → **Weather** lists all weather stations Freeboard
   receives — if your stations are in the list but not on the map, it is one
   of the display toggles above.

The windsock icon size is currently fixed in Freeboard-SK; there is an open
feature request for scalable wind-barb symbols:
[freeboard-sk#490](https://github.com/SignalK/freeboard-sk/issues/490).

### Testing the alarms

Real alarms need real weather, but you can verify the whole chain in
minutes by temporarily lowering the thresholds in the plugin config —
e.g. wind rise **0.1 m/s / 2 min** and pressure drop **0.1 hPa / 5 min**.
Normal measurement jitter will then raise alarms within a few polls:
check for `notifications.environment.observations.viva.*` paths in the Data
Browser, an alert in KIP/Freeboard-SK, and the ⚠ note at the station on the
chart. Alarms clear with hysteresis (at 80 % of the threshold), so expect
them to come and go. Restore the thresholds afterwards.

## Visualization

- **KIP**: add gauges/wind steering displays on the
  `environment.observations.viva.*` paths — units and station names come from
  the published meta.
- **History/graphs**: pair with `signalk-to-influxdb2` + Grafana (great for
  watching the pressure trend), or KIP's built-in charts.

## Install

Install **signalk-viva** from the Signal K App Store (admin UI → Appstore),
or from npm:

```
npm install signalk-viva
```

or from source:

```
cd ~/.signalk/node_modules
git clone https://github.com/theseal666/signalk-viva-plugin.git signalk-viva
```

then restart the Signal K server and enable the plugin. Requires Node 18+
(uses the built-in `fetch`).

## Data source

Data comes from Sjöfartsverket's ViVa system via its public JSON service. The
service is unofficial/undocumented, so be gentle with poll intervals and
expect occasional format changes.
