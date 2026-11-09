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

const LIVEBOARD_TTL = 180; // 3 min: matches the frontend's refresh interval
const DAILY_TIMETABLE_TTL = 1800; // 30 min: a day's schedule barely changes
const STATIC_DATA_TTL = 86400; // 1 day: station/line lists are effectively static

async function getAccessToken(env) {
  const cached = await env.TOKEN_KV.get(TOKEN_CACHE_KEY, { type: "json" });
  const now = Date.now();

  // Only fetch a new token when the cached one is within an hour of expiring,
  // to avoid calling TDX too often and risking a rate limit.
  if (cached && cached.expires_at - now > 60 * 60 * 1000) {
    return cached.access_token;
  }

  const resp = await fetch(TDX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    throw new Error(`TDX token request failed: ${resp.status}`);
  }

  const data = await resp.json();
  const expiresAt = now + data.expires_in * 1000;

  await env.TOKEN_KV.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
    { expirationTtl: data.expires_in }
  );

  return data.access_token;
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
async function fetchJsonCached(env, cacheKey, ttlSeconds, url, token) {
  const cached = await env.TOKEN_KV.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const staleKey = `${cacheKey}:stale`;
  try {
    const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
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

async function getTrainBoard(env, stationId, { direction, windowMinutes, limit } = {}) {
  const token = await getAccessToken(env);
  const { nowMinutes, dateStr } = taipeiNow();

  const [daily, live, stationLineMap] = await Promise.all([
    fetchJsonCached(
      env,
      `daily_${dateStr}_${stationId}`,
      DAILY_TIMETABLE_TTL,
      `${TDX_BASE}/DailyTimetable/Station/${stationId}/${dateStr}?$format=JSON`,
      token
    ),
    fetchJsonCached(
      env,
      `live_${stationId}`,
      LIVEBOARD_TTL,
      `${TDX_BASE}/LiveBoard/Station/${stationId}?$format=JSON`,
      token
    ),
    getStationLineMap(env, token),
  ]);

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
      return {
        direction: t.Direction,
        time: t.DepartureTime,
        trainNo: t.TrainNo,
        trainType: t.TrainTypeName?.Zh_tw ?? "",
        destination: t.EndingStationName?.Zh_tw ?? "",
        suspended,
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
    stationName: daily[0]?.StationName?.Zh_tw ?? "",
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
      if (!/^\d{3,5}$/.test(stationId)) {
        return Response.json({ error: "車站代號格式錯誤。" }, { status: 400 });
      }

      const directionParam = url.searchParams.get("direction");
      const direction =
        directionParam === "0" || directionParam === "1" ? Number(directionParam) : undefined;
      const windowParam = url.searchParams.get("window");
      const windowMinutes = windowParam && /^\d+$/.test(windowParam) ? Number(windowParam) : undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined;

      try {
        const data = await getTrainBoard(env, stationId, { direction, windowMinutes, limit });
        return Response.json(data);
      } catch (err) {
        return Response.json(
          { error: "查詢台鐵即時資料失敗，請稍後再試。" },
          { status: 502 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
