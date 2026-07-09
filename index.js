'use strict'

/*
 * signalk-viva — Sjöfartsverket ViVa observations for Signal K
 *
 * How it works, in one pass through the code:
 *
 *  1. DISCOVERY (maybeDiscover): fetch the ViVa station list, pick the
 *     nearest stations around the vessel position that report wind and/or
 *     air pressure (probeStation), plus any manually configured IDs.
 *     Re-runs when the vessel has moved >10 km or every 6 h.
 *  2. POLLING (pollStations): every pollInterval, fetch each station's
 *     samples and convert them to SI units (parseSampleValue/toSI).
 *  3. PUBLISHING (handleStationData): emit the values as Signal K deltas
 *     under environment.observations.viva.<station>.*, and optionally a
 *     second time as a meteo.* context (sendMeteo) so chartplotters like
 *     Freeboard-SK draw the station on the map.
 *  4. ALARMS (evaluateAlarms/setAlarm): keep a short history of wind and
 *     pressure per station and compare the change across a configurable
 *     time window against thresholds. Alarms are published as Signal K
 *     notifications, and optionally as chart notes at the station position
 *     (updateAlarmNote).
 *
 * The ViVa JSON service is unofficial (it is what the ViVa app uses), so
 * everything here is defensive: unknown sample types are ignored, fetch
 * errors are logged and retried on the next poll.
 */

// Station list at this URL; append a station ID for that station's samples
const BASE_URL = 'https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/'
// Give up on a ViVa request after this long
const FETCH_TIMEOUT_MS = 10000
// Re-run station discovery at least this often…
const DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000
// …or as soon as the vessel has moved this far from the last discovery position
const REDISCOVER_MOVE_M = 10000
// How many stations to probe in parallel during discovery
const PROBE_BATCH_SIZE = 4

// How ViVa sample names (Swedish) map onto Signal K path suffixes.
//   match     — regex tested against the sample's Name field
//   path      — suffix under environment.observations.viva.<station>.
//   units     — SI units after conversion in toSI(), sent as Signal K meta
//   direction — sample carries wind direction in its Heading field (degrees)
//   qualifies — sample types that make a station worth following from a
//               sailboat; stations with none of these are skipped
//   history   — which per-station history buffer feeds the alarm logic
const SAMPLE_KINDS = [
  { match: /^medelvind/i, path: 'wind.averageSpeed', units: 'm/s', direction: true, qualifies: true, history: 'windSpeed' },
  { match: /^byvind/i, path: 'wind.gust', units: 'm/s', qualifies: true },
  { match: /^vindriktning/i, path: null, direction: true, qualifies: true },
  { match: /^lufttryck/i, path: 'pressure', units: 'Pa', qualifies: true, history: 'pressure' },
  { match: /^lufttemp/i, path: 'temperature', units: 'K' },
  { match: /^vattentemp/i, path: 'water.temperature', units: 'K' },
  { match: /^vattenst/i, path: 'water.level', units: 'm' }
]

const DIRECTION_SUFFIX = 'wind.directionTrue'

// Vessel-context path suffixes -> paths used under the meteo.* context,
// which chartplotters like Freeboard-SK display as weather stations on the map
const METEO_PATHS = {
  'wind.averageSpeed': 'environment.wind.averageSpeed',
  'wind.gust': 'environment.wind.gust',
  'wind.directionTrue': 'environment.wind.directionTrue',
  pressure: 'environment.outside.pressure',
  temperature: 'environment.outside.temperature',
  'water.temperature': 'environment.water.temperature',
  'water.level': 'environment.water.level'
}

const ALARM_KEYS = ['windRise', 'windShift', 'pressureDrop']

module.exports = function (app) {
  const plugin = {}
  let timer = null
  let busy = false
  let cfg = null
  let state = null

  plugin.id = 'signalk-viva'
  plugin.name = 'Sjöfartsverket ViVa observations'
  plugin.description =
    'Polls nearby ViVa stations for wind, air pressure and temperature, and raises alarms on sudden wind changes or pressure drops'

  plugin.schema = {
    type: 'object',
    properties: {
      pollInterval: {
        type: 'integer',
        title: 'Poll interval (seconds)',
        default: 60,
        minimum: 30
      },
      maxDistance: {
        type: 'number',
        title: 'Search radius around vessel (km)',
        default: 50,
        minimum: 1
      },
      maxStations: {
        type: 'integer',
        title: 'Max stations to follow (nearest first)',
        default: 3,
        minimum: 1,
        maximum: 10
      },
      manualStations: {
        type: 'array',
        title: 'Extra station IDs to always follow (optional)',
        description: 'ViVa station IDs, e.g. 33 for Bönan. Followed regardless of distance.',
        items: { type: 'integer' }
      },
      fallbackPosition: {
        type: 'object',
        title: 'Fallback position (used when the vessel has no GPS position)',
        description: 'Decimal degrees, e.g. 57.63 / 11.60 for Vinga. Leave empty to rely on navigation.position only.',
        properties: {
          latitude: { type: 'number', title: 'Latitude' },
          longitude: { type: 'number', title: 'Longitude' }
        }
      },
      publishMeteo: {
        type: 'boolean',
        title: 'Publish stations as weather station (meteo) targets',
        description: 'Shows the stations on the chart in Freeboard-SK (enable "Meteo (Weather)" under Settings → Display in Freeboard-SK).',
        default: true
      },
      alarmNotes: {
        type: 'boolean',
        title: 'Place a chart note at stations with an active alarm',
        description: 'Shows a marker with the alarm text at the station position in Freeboard-SK. Requires a resources provider (the bundled resources-provider plugin).',
        default: true
      },
      alarms: {
        type: 'object',
        title: 'Alarms',
        properties: {
          enabled: { type: 'boolean', title: 'Enable alarms', default: true },
          windRiseThreshold: {
            type: 'number',
            title: 'Wind rise alarm: increase in average wind (m/s)',
            default: 5
          },
          windRiseWindow: {
            type: 'integer',
            title: 'Wind rise alarm: window (minutes)',
            default: 30
          },
          windShiftThreshold: {
            type: 'number',
            title: 'Wind shift alarm: direction change (degrees)',
            default: 45
          },
          windShiftWindow: {
            type: 'integer',
            title: 'Wind shift alarm: window (minutes)',
            default: 30
          },
          pressureDropThreshold: {
            type: 'number',
            title: 'Pressure drop alarm: drop (hPa)',
            default: 2
          },
          pressureDropWindow: {
            type: 'integer',
            title: 'Pressure drop alarm: window (minutes)',
            default: 120
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    cfg = {
      pollInterval: Math.max(30, options.pollInterval || 60),
      maxDistance: (options.maxDistance || 50) * 1000,
      maxStations: options.maxStations || 3,
      manualStations: options.manualStations || [],
      fallbackPosition:
        options.fallbackPosition &&
        typeof options.fallbackPosition.latitude === 'number' &&
        typeof options.fallbackPosition.longitude === 'number'
          ? options.fallbackPosition
          : null,
      publishMeteo: options.publishMeteo !== false,
      alarmNotes: options.alarmNotes !== false,
      alarms: Object.assign(
        {
          enabled: true,
          windRiseThreshold: 5,
          windRiseWindow: 30,
          windShiftThreshold: 45,
          windShiftWindow: 30,
          pressureDropThreshold: 2,
          pressureDropWindow: 120
        },
        options.alarms
      )
    }
    // Longest alarm window in ms — how much history recordHistory keeps
    cfg.maxWindowMs =
      Math.max(
        cfg.alarms.windRiseWindow,
        cfg.alarms.windShiftWindow,
        cfg.alarms.pressureDropWindow
      ) *
      60 *
      1000
    state = {
      stations: new Map(),
      lastDiscovery: 0,
      lastDiscoveryPos: null
    }
    app.setPluginStatus('Starting')
    tick()
    timer = setInterval(tick, cfg.pollInterval * 1000)
  }

  plugin.stop = function () {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    busy = false
    state = null
    app.setPluginStatus('Stopped')
  }

  // One poll cycle. The busy flag prevents overlapping cycles when a slow
  // network makes a cycle take longer than the poll interval.
  async function tick () {
    if (busy || !state) return
    busy = true
    try {
      await maybeDiscover()
      await pollStations()
    } catch (err) {
      app.setPluginError(err.message)
    } finally {
      busy = false
    }
  }

  // ---------- discovery ----------

  // Decide which stations to follow. Manual station IDs are always included;
  // the rest are the nearest qualifying stations within the search radius,
  // probed nearest-first so we stop fetching as soon as we have enough.
  async function maybeDiscover () {
    const pos = getVesselPosition()
    const due = Date.now() - state.lastDiscovery > DISCOVERY_INTERVAL_MS
    const moved =
      pos && state.lastDiscoveryPos && haversine(pos, state.lastDiscoveryPos) > REDISCOVER_MOVE_M
    // If the last discovery ran before any position was known (GPS not up yet
    // at startup), re-run as soon as a position appears instead of waiting out
    // the full discovery interval with only the manual stations
    const positionAppeared = pos && state.lastDiscovery > 0 && !state.lastDiscoveryPos
    if (state.stations.size > 0 && !due && !moved && !positionAppeared) return

    const list = (await fetchJson(BASE_URL)).GetStationsResult.Stations
    const byId = new Map(list.map(s => [s.ID, s]))
    const selected = new Map()

    for (const id of cfg.manualStations) {
      const s = byId.get(id)
      if (s) selected.set(id, makeStation(s))
      else app.error(`ViVa station ${id} not found in station list`)
    }

    if (pos) {
      const candidates = list
        .map(s => ({ station: s, distance: haversine(pos, { latitude: s.Lat, longitude: s.Lon }) }))
        .filter(c => c.distance <= cfg.maxDistance && !selected.has(c.station.ID))
        .sort((a, b) => a.distance - b.distance)

      let autoCount = 0
      for (let i = 0; i < candidates.length && autoCount < cfg.maxStations; i += PROBE_BATCH_SIZE) {
        const batch = candidates.slice(i, i + PROBE_BATCH_SIZE)
        const probed = await Promise.all(batch.map(c => probeStation(c).catch(() => null)))
        for (const c of probed) {
          if (c && autoCount < cfg.maxStations) {
            selected.set(c.station.ID, makeStation(c.station))
            autoCount++
          }
        }
      }
    } else if (selected.size === 0) {
      app.setPluginStatus('Waiting for vessel position to find nearby stations')
      return
    }

    // Keep alarm history for stations that stay selected across re-discovery
    for (const [id, st] of selected) {
      const existing = state.stations.get(id)
      if (existing) selected.set(id, existing)
      else {
        app.debug(`Following ViVa station ${st.name} (${id})`)
        clearAlarmNotes(st)
      }
    }
    state.stations = selected
    state.lastDiscovery = Date.now()
    state.lastDiscoveryPos = pos
  }

  // A station qualifies if it reports wind and/or air pressure
  async function probeStation (candidate) {
    const result = (await fetchJson(BASE_URL + candidate.station.ID)).GetSingleStationResult
    const relevant = (result.Samples || []).some(sample =>
      SAMPLE_KINDS.some(kind => kind.qualifies && kind.match.test(sample.Name))
    )
    return relevant ? candidate : null
  }

  // Per-station runtime state. The history buffers feed the alarm logic and
  // survive re-discovery for stations that stay selected (see maybeDiscover).
  function makeStation (raw) {
    return {
      id: raw.ID,
      name: raw.Name,
      slug: slugify(raw.Name),
      uuid: stationUuid(raw.ID),
      position: { latitude: raw.Lat, longitude: raw.Lon },
      history: { windSpeed: [], windDir: [], pressure: [] },
      alarms: {}, // active/inactive per alarm key
      metaSent: false,
      errors: 0
    }
  }

  // ---------- polling ----------

  async function pollStations () {
    if (state.stations.size === 0) return
    let ok = 0
    for (const st of state.stations.values()) {
      try {
        const result = (await fetchJson(BASE_URL + st.id)).GetSingleStationResult
        handleStationData(st, result)
        st.errors = 0
        ok++
      } catch (err) {
        st.errors++
        app.error(`ViVa station ${st.name} (${st.id}): ${err.message}`)
      }
    }
    const names = [...state.stations.values()].map(s => s.name).join(', ')
    app.setPluginStatus(`Updated ${ok}/${state.stations.size} stations: ${names}`)
  }

  // Turn one station's ViVa samples into Signal K deltas, record alarm
  // history, and kick off the alarm evaluation.
  function handleStationData (st, result) {
    const prefix = `environment.observations.viva.${st.slug}.`
    const now = Date.now()
    const values = [] // delta values for the vessel context
    const pairs = [] // same data as {suffix, value}, reused for the meteo context
    const seen = new Set()

    // A station can report overlapping samples (e.g. both Medelvind and
    // Vindriktning carry a wind direction) — first one wins.
    const push = (suffix, value) => {
      if (suffix && value != null && !seen.has(suffix)) {
        seen.add(suffix)
        values.push({ path: prefix + suffix, value })
        pairs.push({ suffix, value })
      }
    }

    for (const sample of result.Samples || []) {
      const kind = SAMPLE_KINDS.find(k => k.match.test(sample.Name))
      if (!kind) continue

      const si = parseSampleValue(sample, kind.units)
      if (kind.path) push(kind.path, si)
      if (kind.direction && typeof sample.Heading === 'number') {
        push(DIRECTION_SUFFIX, degToRad(sample.Heading))
        recordHistory(st.history.windDir, now, sample.Heading)
      }
      if (kind.history === 'windSpeed' && si != null) recordHistory(st.history.windSpeed, now, si)
      if (kind.history === 'pressure' && si != null) recordHistory(st.history.pressure, now, si)
    }

    const pos = getVesselPosition()
    if (pos) push('distance', Math.round(haversine(pos, st.position)))

    if (values.length === 0) return
    if (!st.metaSent) {
      sendMeta(st, prefix)
      st.metaSent = true
    }
    app.handleMessage(plugin.id, {
      updates: [{ timestamp: new Date().toISOString(), values }]
    })
    if (cfg.publishMeteo) sendMeteo(st, pairs)
    evaluateAlarms(st)
  }

  // Publish the station as its own meteo.* context so chartplotters
  // (e.g. Freeboard-SK with the Meteo layer enabled) show it on the map
  function sendMeteo (st, pairs) {
    const values = [
      { path: '', value: { name: st.name } },
      { path: 'navigation.position', value: st.position }
    ]
    for (const { suffix, value } of pairs) {
      const meteoPath = METEO_PATHS[suffix]
      if (meteoPath) values.push({ path: meteoPath, value })
    }
    app.handleMessage(plugin.id, {
      context: `meteo.urn:mrn:signalk:uuid:${st.uuid}`,
      updates: [{ timestamp: new Date().toISOString(), values }]
    })
  }

  // ViVa values are strings that may embed a compass direction ("NV 8.8")
  // or use a decimal comma — extract the first number and convert to SI.
  // A calm wind sample may have no number at all; treat that as 0.
  // fallbackUnit is the unit we know from the SAMPLE_KINDS definition —
  // used when the API omits or nulls the Unit field for that sample.
  function parseSampleValue (sample, fallbackUnit) {
    const match = String(sample.Value).replace(',', '.').match(/-?\d+(\.\d+)?/)
    if (!match) return sample.Calm ? 0 : null
    return toSI(parseFloat(match[0]), sample.Unit || fallbackUnit)
  }

  // Send Signal K meta (units + station name) once per station, so apps
  // like KIP can label gauges and convert units correctly
  function sendMeta (st, prefix) {
    const meta = []
    for (const kind of SAMPLE_KINDS) {
      if (kind.path && kind.units) {
        meta.push({
          path: prefix + kind.path,
          value: { units: kind.units, description: `${st.name} (ViVa station ${st.id})` }
        })
      }
    }
    meta.push({
      path: prefix + DIRECTION_SUFFIX,
      value: { units: 'rad', description: `${st.name} (ViVa station ${st.id})` }
    })
    meta.push({
      path: prefix + 'distance',
      value: { units: 'm', description: `Distance from vessel to ${st.name} (ViVa station ${st.id})` }
    })
    app.handleMessage(plugin.id, { updates: [{ meta }] })
  }

  // ---------- alarms ----------

  // Compare how much wind and pressure changed across each alarm's time
  // window against the configured thresholds
  function evaluateAlarms (st) {
    const a = cfg.alarms
    if (!a.enabled) return

    const rise = changeOverWindow(st.history.windSpeed, a.windRiseWindow)
    if (rise != null) {
      setAlarm(
        st,
        'windRise',
        rise,
        a.windRiseThreshold,
        `Wind at ${st.name} increased ${rise.toFixed(1)} m/s in the last ${a.windRiseWindow} min`
      )
    }

    const shift = angularChangeOverWindow(st.history.windDir, a.windShiftWindow)
    if (shift != null) {
      setAlarm(
        st,
        'windShift',
        shift,
        a.windShiftThreshold,
        `Wind at ${st.name} shifted ${Math.round(shift)}° in the last ${a.windShiftWindow} min`
      )
    }

    const change = changeOverWindow(st.history.pressure, a.pressureDropWindow)
    if (change != null) {
      const dropHPa = -change / 100
      setAlarm(
        st,
        'pressureDrop',
        dropHPa,
        a.pressureDropThreshold,
        `Pressure at ${st.name} dropped ${dropHPa.toFixed(1)} hPa in the last ${a.pressureDropWindow} min`
      )
    }
  }

  // Raises at threshold, clears below 80 % of it, and only emits on state changes
  function setAlarm (st, key, value, threshold, message) {
    const wasActive = !!st.alarms[key]
    const active = value >= threshold || (wasActive && value >= threshold * 0.8)
    if (active === wasActive) return
    st.alarms[key] = active
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: `notifications.environment.observations.viva.${st.slug}.${key}`,
              value: {
                state: active ? 'alert' : 'normal',
                method: active ? ['visual', 'sound'] : [],
                message,
                timestamp: new Date().toISOString()
              }
            }
          ]
        }
      ]
    })
    updateAlarmNote(st, key, active, message)
  }

  // A note at the station position makes the alarm visible on the chart
  // (Freeboard-SK renders notes as markers with the text in the popup)
  function updateAlarmNote (st, key, active, message) {
    if (!cfg.alarmNotes || !app.resourcesApi) return
    const id = alarmNoteId(st, key)
    const op = active
      ? app.resourcesApi.setResource('notes', id, {
          name: `⚠ ${st.name}`,
          description: message,
          position: { latitude: st.position.latitude, longitude: st.position.longitude },
          group: 'signalk-viva'
        })
      : app.resourcesApi.deleteResource('notes', id)
    Promise.resolve(op).catch(err =>
      app.debug(`Could not update alarm note for ${st.name}: ${err.message}`)
    )
  }

  // Remove notes that may be left over from before a restart
  function clearAlarmNotes (st) {
    if (!cfg.alarmNotes || !app.resourcesApi) return
    for (const key of ALARM_KEYS) {
      Promise.resolve(app.resourcesApi.deleteResource('notes', alarmNoteId(st, key))).catch(
        () => {}
      )
    }
  }

  // Append a sample to a station's history buffer and drop entries older
  // than the longest alarm window (plus some slack), keeping memory bounded
  function recordHistory (entries, time, value) {
    entries.push({ time, value })
    const cutoff = time - cfg.maxWindowMs * 1.25
    while (entries.length && entries[0].time < cutoff) entries.shift()
  }

  // Change from the oldest sample inside the window to the newest.
  // Returns null until at least half the window is covered, so alarms
  // do not fire off a nearly empty history right after startup.
  function windowEndpoints (entries, windowMin) {
    const windowMs = windowMin * 60 * 1000
    const now = Date.now()
    const inWindow = entries.filter(e => now - e.time <= windowMs)
    if (inWindow.length < 2) return null
    if (now - inWindow[0].time < windowMs * 0.5) return null
    return [inWindow[0].value, inWindow[inWindow.length - 1].value]
  }

  function changeOverWindow (entries, windowMin) {
    const ends = windowEndpoints(entries, windowMin)
    return ends ? ends[1] - ends[0] : null
  }

  // Like changeOverWindow but for compass directions: the shortest way
  // around the circle, so 350° -> 10° is a 20° shift, not 340°
  function angularChangeOverWindow (entries, windowMin) {
    const ends = windowEndpoints(entries, windowMin)
    if (!ends) return null
    const diff = Math.abs(ends[1] - ends[0]) % 360
    return diff > 180 ? 360 - diff : diff
  }

  // ---------- helpers ----------

  async function fetchJson (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return res.json()
  }

  // Vessel position from the Signal K full model; getSelfPath may return the
  // bare value or a {value, meta, …} object depending on the server. Falls
  // back to the configured position so the plugin works without a GPS.
  function getVesselPosition () {
    const p = app.getSelfPath('navigation.position')
    const v = p && p.value ? p.value : p
    if (v && typeof v.latitude === 'number') return v
    return cfg.fallbackPosition
  }

  // Convert a ViVa value to the SI unit Signal K expects
  // (m/s stays, cm -> m, hPa -> Pa, °C -> K, km -> m)
  function toSI (value, unit) {
    switch (String(unit || '').trim().toLowerCase()) {
      case 'm/s':
      case 'm':
        return value
      case 'cm':
        return value / 100
      case 'hpa':
      case 'mbar':
        return value * 100
      case 'pa':
        return value
      case '°c':
      case 'c':
        return value + 273.15
      case 'km':
        return value * 1000
      default:
        return null
    }
  }

  function degToRad (deg) {
    return (deg * Math.PI) / 180
  }

  // Great-circle distance in metres between two {latitude, longitude} points
  function haversine (a, b) {
    const R = 6371000
    const dLat = degToRad(b.latitude - a.latitude)
    const dLon = degToRad(b.longitude - a.longitude)
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(degToRad(a.latitude)) * Math.cos(degToRad(b.latitude)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
  }

  // Stable, valid-format UUIDs derived from the station ID, so the same
  // station keeps the same meteo context and note IDs across restarts
  function stationUuid (id) {
    return '00000000-0000-4000-8000-' + String(id).padStart(12, '0')
  }

  function alarmNoteId (st, key) {
    const idx = ALARM_KEYS.indexOf(key) + 1
    return '00000000-0000-4000-9000-' + String(st.id).padStart(11, '0') + String(idx)
  }

  // "Bönan (SMHI)" -> "bonan"
  function slugify (name) {
    return name
      .replace(/\(.*?\)/g, '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-zA-Z0-9]+/g, '')
      .toLowerCase() || 'station'
  }

  return plugin
}
