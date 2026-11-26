// TRA train board API, for any TRA station the viewer picks.
//
// Direction semantics
// --------------------
// TDX's `Direction` field is documented only as a generic "順行/逆行"
// (forward/reverse) flag, the same field across the whole TRA network — it
// does not say which value means south and which means north.
//
// We verified empirically (2026-11-08) that on the 西部幹線 (Western Main
// Line, LineID "WL"/"WL-C" — Keelung-Pingtung, the corridor Baifu is on):
// trains bound for Shulin (south of Taipei/Banqiao) are Direction = 1, and
// trains bound for Keelung (north of Baifu) at Baifu station are
// Direction = 0. So for stations on that corridor we label Direction 1 as
// "南下" (southbound) and 0 as "北上" (northbound).
//
// For every other TRA line (the eastern main line, the south-link line, and
// all branch lines such as Neiwan/Jiji/Pingxi/etc.) we have NOT verified
// that the same mapping holds, so instead of guessing we label each
// direction with the actual destination station name seen in that station's
// own timetable (e.g. "往內灣" / "往新竹"), derived from real data every
// time rather than assumed.
//
// Line membership (which stations are on WL/WL-C vs elsewhere) comes from
// TDX's own `/Rail/TRA/Line` + `/Rail/TRA/StationOfLine` APIs, not a
// hand-written list.
//
// Data sources (merged)
// ----------------------
//   1. LiveBoard (real-time board): only returns near-term trains (roughly
//      the next 30-60 minutes), but includes delay minutes.
//   2. DailyTimetable (/v2/Rail/TRA/DailyTimetable/Station/{StationID}/{TrainDate}):
//      covers the whole day's scheduled trains (and whether a stop is
//      suspended today), but has no delay data.
// The daily timetable is the base list; LiveBoard entries are matched in by
// train number to overlay delay info. Trains with no match (too far out for
// the board to know yet) are marked as "no live data yet", not as on-time.
//
// TDX free-tier quota is tight (5 calls/min, ~4,500 calls/month per key), so
// every upstream call result is cached in KV and reused across all viewers.

const TDX_TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/TRA";
const TOKEN_CACHE_KEY = "tdx_access_token";
const MAIN_CORRIDOR_LINES = new Set(["WL", "WL-C"]); // verified south/north corridor

// Only the stations the frontend offers. Every unseen station costs fresh
// TDX calls, so arbitrary IDs from strangers/bots would burn the quota.
const STATION_NAMES = {
  "0930": "七堵",
  "0940": "百福",
  "0960": "汐止",
  "0970": "汐科",
  "0990": "松山",
  "1000": "臺北",
};
const ALLOWED_STATIONS = new Set(Object.keys(STATION_NAMES));

// The riders' other stop (`to`) is chosen on the phone: 上班模式 heads for the
// 下班車站 and 下班模式 for the 上班車站. These stations are all on the verified
// 西部幹線 corridor, where StationID rises going south, so a train travelling
// toward `to` has Direction 1 (南下) if `to` is greater and 0 (北上) otherwise.
// Trains that don't appear in the target's own timetable are flagged, not
// guessed from train type; trains going the other way get no arrival time.

const LIVEBOARD_TTL = 180; // 3 min: matches the frontend's refresh interval
const DAILY_TIMETABLE_TTL = 1800; // 30 min: a day's schedule barely changes
const STATIC_DATA_TTL = 86400; // 1 day: station/line lists are effectively static

// TDX sometimes answers the token request with 429 when called from
// Cloudflare (not from a laptop), for minutes at a time, so retry briefly.
//
// When TDX's login server is down it can also be very slow to answer (up to
// 30 s was seen), which left the family staring at "查詢中…". So every attempt
// has a time limit and all attempts together share one budget.
const TOKEN_ATTEMPT_TIMEOUT_MS = 5000;
const TOKEN_TOTAL_BUDGET_MS = 9000;
const DATA_REQUEST_TIMEOUT_MS = 8000;

async function requestToken(env, attempts) {
  const startedAt = Date.now();
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 700;
      if (Date.now() - startedAt + wait >= TOKEN_TOTAL_BUDGET_MS) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const timeout = Math.min(TOKEN_ATTEMPT_TIMEOUT_MS, TOKEN_TOTAL_BUDGET_MS - (Date.now() - startedAt));
    let resp;
    try {
      resp = await fetch(TDX_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: env.TDX_CLIENT_ID,
          client_secret: env.TDX_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      failure = new Error(`TDX token request did not answer: ${err?.name ?? err}`);
      continue; // too slow or the connection dropped: worth another try
    }
    if (resp.ok) return resp.json();

    const detail = (await resp.text().catch(() => "")).slice(0, 160);
    const limits = ["retry-after", "ratelimit-reset", "x-ratelimit-remaining-minute"]
      .map((h) => `${h}=${resp.headers.get(h)}`)
      .join(" ");
    failure = new Error(`TDX token request failed: ${resp.status} ${limits} ${detail}`);
    if (resp.status !== 429 && resp.status < 500) break; // bad credentials etc.: retrying won't help
  }
  throw failure;
}

async function getAccessToken(env) {
  const cached = await env.TOKEN_KV.get(TOKEN_CACHE_KEY, { type: "json" });
  const now = Date.now();

  // Renew a token that has under 8 hours left. TDX throttles token requests
  // per source IP, so start early (a single quick try while the old token still
  // works) instead of waiting for the last minute, which also means a family
  // that only uses this morning and evening always has a live token.
  if (cached && cached.expires_at - now > 8 * 60 * 60 * 1000) {
    return cached.access_token;
  }

  // Refreshing early is optional: the old token still works until it expires,
  // so one quick try is enough then; with no usable token, keep trying.
  const stillValid = cached && cached.expires_at > now;
  let data;
  try {
    data = await requestToken(env, stillValid ? 1 : 3);
  } catch (err) {
    if (stillValid) return cached.access_token;
    throw err;
  }

  await env.TOKEN_KV.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ access_token: data.access_token, expires_at: now + data.expires_in * 1000 }),
    { expirationTtl: data.expires_in }
  );

  return data.access_token;
}

function addMinutes(hhmm, delta) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + delta) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function taipeiNow() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    nowMinutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateStr: d.toISOString().slice(0, 10),
  };
}

// Cache TDX responses in KV so many viewers (and many stations) share the
// same upstream calls instead of each triggering a fresh one. A second,
// non-expiring "stale" copy is kept as a fallback: if TDX is down or we hit
// the rate limit, we serve slightly-old data instead of breaking the page.
// Never share an in-flight promise between requests: if the request that
// started it is cancelled (tab closed, page reloaded), it never settles and
// every later request in that isolate waits on it forever.
async function fetchJsonCached(env, cacheKey, ttlSeconds, url, token) {
  const cached = await env.TOKEN_KV.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const staleKey = `${cacheKey}:stale`;
  try {
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DATA_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`TDX request failed (${cacheKey}): ${resp.status}`);
    const data = await resp.json();
    await env.TOKEN_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttlSeconds });
    await env.TOKEN_KV.put(staleKey, JSON.stringify(data));
    return data;
  } catch (err) {
    const stale = await env.TOKEN_KV.get(staleKey, { type: "json" });
    if (stale) return stale;
    throw err;
  }
}

async function getStations(env, token) {
  return fetchJsonCached(
    env,
    "stations",
    STATIC_DATA_TTL,
    `${TDX_BASE}/Station?$format=JSON`,
    token
  );
}

// Map of StationID -> Set of LineIDs it belongs to, built from TDX's own
// line/station-of-line data (not a hand-written list).
async function getStationLineMap(env, token) {
  const cached = await env.TOKEN_KV.get("station_line_map", { type: "json" });
  if (cached) return new Map(cached.map(([id, lines]) => [id, new Set(lines)]));

  const stationsOfLine = await fetchJsonCached(
    env,
    "station_of_line",
    STATIC_DATA_TTL,
    `${TDX_BASE}/StationOfLine?$format=JSON`,
    token
  );

  const map = new Map();
  for (const line of stationsOfLine) {
    for (const s of line.Stations) {
      if (!map.has(s.StationID)) map.set(s.StationID, new Set());
      map.get(s.StationID).add(line.LineID);
    }
  }

  await env.TOKEN_KV.put(
    "station_line_map",
    JSON.stringify([...map].map(([id, lines]) => [id, [...lines]])),
    { expirationTtl: STATIC_DATA_TTL }
  );

  return map;
}

function isMainCorridor(stationLineMap, stationId) {
  const lines = stationLineMap.get(stationId);
  if (!lines) return false;
  for (const lineId of lines) {
    if (MAIN_CORRIDOR_LINES.has(lineId)) return true;
  }
  return false;
}

async function getTrainBoard(env, stationId, { direction, windowMinutes, limit, target } = {}) {
  const token = await getAccessToken(env);
  const { nowMinutes, dateStr } = taipeiNow();

  const getDaily = (id) =>
    fetchJsonCached(
      env,
      `daily_${dateStr}_${id}`,
      DAILY_TIMETABLE_TTL,
      `${TDX_BASE}/DailyTimetable/Station/${id}/${dateStr}?$format=JSON`,
      token
    );

  const arrivalDirection = target && target !== stationId ? (target > stationId ? 1 : 0) : null;
  // Nice-to-have: if the target's timetable can't be fetched, the board still
  // shows, just without arrival times.
  const loadArrivalTimes = async () => {
    if (arrivalDirection === null) return null;
    const rows = await getDaily(target).catch(() => null);
    // Unfiltered on purpose: a train that ends at the target still gets you there.
    return rows && new Map(rows.map((t) => [t.TrainNo, t.ArrivalTime || t.DepartureTime]));
  };

  const [dailyAll, live, stationLineMap, arrivalTimes] = await Promise.all([
    getDaily(stationId),
    fetchJsonCached(
      env,
      `live_${stationId}`,
      LIVEBOARD_TTL,
      `${TDX_BASE}/LiveBoard/Station/${stationId}?$format=JSON`,
      token
    ),
    getStationLineMap(env, token),
    loadArrivalTimes(),
  ]);

  // Trains whose last stop is this station can't be boarded here. TDX has also
  // returned a whole day's timetable with every train listed three times, byte
  // for byte (2026-11-26), so keep only the first of each train.
  const seen = new Set();
  const daily = dailyAll.filter((t) => {
    if (t.EndingStationID === stationId) return false;
    const key = `${t.TrainNo}|${t.Direction}|${t.DepartureTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const liveByTrainNo = new Map();
  for (const t of live) {
    liveByTrainNo.set(t.TrainNo, t.DelayTime > 0 ? t.DelayTime : 0);
  }

  const onCorridor = isMainCorridor(stationLineMap, stationId);

  // Figure out what each Direction value (0/1) means for this station today:
  // "南下"/"北上" on the verified corridor, otherwise the real destination
  // name most trains in that direction are headed to.
  const destinationCounts = { 0: new Map(), 1: new Map() };
  for (const t of daily) {
    if (t.Direction !== 0 && t.Direction !== 1) continue;
    const dest = t.EndingStationName?.Zh_tw;
    if (!dest) continue;
    const counts = destinationCounts[t.Direction];
    counts.set(dest, (counts.get(dest) ?? 0) + 1);
  }
  const mostCommonDestination = (counts) => {
    let best = null;
    let bestCount = 0;
    for (const [dest, count] of counts) {
      if (count > bestCount) {
        best = dest;
        bestCount = count;
      }
    }
    return best;
  };

  const directionOptions = [0, 1]
    .filter((d) => destinationCounts[d].size > 0)
    .map((d) => ({
      value: d,
      label: onCorridor
        ? d === 1
          ? "南下"
          : "北上"
        : `往${mostCommonDestination(destinationCounts[d])}`,
    }));

  let trains = daily
    .filter((t) => t.Direction === 0 || t.Direction === 1)
    .map((t) => {
      const [h, m] = t.DepartureTime.split(":").map(Number);
      const schedMinutes = h * 60 + m;
      const suspended = t.SuspendedFlag === 1;
      const delayMinutes = suspended
        ? null
        : liveByTrainNo.has(t.TrainNo)
        ? liveByTrainNo.get(t.TrainNo)
        : null; // null = not on the live board yet, not a confirmed on-time
      const estimatedMinutes = schedMinutes + (delayMinutes ?? 0);
      // A Map of the target's train numbers -> times; null if that lookup
      // failed or the train runs away from the target.
      const times = t.Direction === arrivalDirection ? arrivalTimes : null;
      const arrivalTime = suspended ? undefined : times?.get(t.TrainNo);
      return {
        direction: t.Direction,
        time: t.DepartureTime,
        trainNo: t.TrainNo,
        // "自強(推拉式自強號且無自行車車廂)" → "自強": the detail wraps on phones.
        trainType: (t.TrainTypeName?.Zh_tw ?? "").replace(/[(（].*$/, ""),
        destination: t.EndingStationName?.Zh_tw ?? "",
        suspended,
        arrivalStation: times ? STATION_NAMES[target] : null,
        skipsArrival: !!times && !times.has(t.TrainNo),
        // Expected arrival at the target: its timetable time plus this train's current delay.
        arrival: arrivalTime ? addMinutes(arrivalTime, delayMinutes ?? 0) : null,
        delayMinutes,
        diffMinutes: estimatedMinutes - nowMinutes,
      };
    })
    .filter((t) => t.diffMinutes >= -3) // keep due-any-second (and still-relevant suspended) trains, drop ones long gone
    .sort((a, b) => a.diffMinutes - b.diffMinutes);

  // Optional server-side filtering, mainly for simple clients (e.g. an iOS
  // Shortcuts widget) that can't easily filter/sort JSON themselves.
  if (direction === 0 || direction === 1) {
    trains = trains.filter((t) => t.direction === direction);
  }
  if (typeof windowMinutes === "number") {
    trains = trains.filter((t) => t.suspended || t.diffMinutes <= windowMinutes);
  }
  if (typeof limit === "number") {
    trains = trains.slice(0, limit);
  }

  return {
    stationId,
    stationName: dailyAll[0]?.StationName?.Zh_tw ?? "",
    onCorridor,
    directionOptions,
    updateTime: live[0]?.UpdateTime ?? null,
    trains,
  };
}

async function handleStations(env) {
  const token = await getAccessToken(env);
  const [stations, stationLineMap] = await Promise.all([
    getStations(env, token),
    getStationLineMap(env, token),
  ]);

  const list = stations.map((s) => ({
    id: s.StationID,
    name: s.StationName?.Zh_tw ?? "",
    city: s.LocationCity ?? "",
    onCorridor: isMainCorridor(stationLineMap, s.StationID),
  }));

  return Response.json({ stations: list });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/stations") {
      try {
        return await handleStations(env);
      } catch (err) {
        return Response.json({ error: "查詢車站清單失敗，請稍後再試。" }, { status: 502 });
      }
    }

    if (url.pathname === "/api/liveboard") {
      const stationId = url.searchParams.get("station") || "0940";
      if (!ALLOWED_STATIONS.has(stationId)) {
        return Response.json({ error: "不支援這個車站。" }, { status: 400 });
      }

      const directionParam = url.searchParams.get("direction");
      const direction =
        directionParam === "0" || directionParam === "1" ? Number(directionParam) : undefined;
      const windowParam = url.searchParams.get("window");
      const windowMinutes = windowParam && /^\d+$/.test(windowParam) ? Number(windowParam) : undefined;
      const target = url.searchParams.get("to") || undefined;
      if (target !== undefined && !ALLOWED_STATIONS.has(target)) {
        return Response.json({ error: "不支援這個目的地車站。" }, { status: 400 });
      }
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined;

      try {
        const data = await getTrainBoard(env, stationId, { direction, windowMinutes, limit, target });
        return Response.json(data);
      } catch (err) {
        console.error(`liveboard ${stationId} failed:`, err?.message ?? err);
        return Response.json(
          { error: "查詢台鐵即時資料失敗，請稍後再試。" },
          { status: 502 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Cron trigger (see wrangler.toml): keeps the TDX token fresh even when nobody
  // opens the page for a day. getAccessToken only calls TDX once the token has
  // under 8 hours left, so most runs are just a KV read; inside that window each
  // run is another chance to renew before the old token expires. Failures are
  // only logged: the next run (or the next visitor) tries again.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      getAccessToken(env).catch((err) => console.error("token keep-alive failed:", err?.message ?? err))
    );
  },
};
