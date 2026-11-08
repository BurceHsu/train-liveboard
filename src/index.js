// TRA southbound train board API for Baifu station.
//
// Verified against the live TDX "Station" API on 2026-11-08:
//   Baifu StationID = "0940" (looked up, not guessed or hardcoded from memory).
// The Direction field's north/south mapping was cross-checked using trains
// bound for Shulin (south of Taipei/Banqiao) at those stations, which are
// Direction = 1, and trains bound for Keelung (north of Baifu) at Baifu
// station, which are Direction = 0. This project treats Direction === 1 as
// southbound.
//
// Two TDX data sources are merged:
//   1. LiveBoard (real-time board): only returns near-term trains (roughly
//      the next 30-60 minutes), but includes delay minutes.
//   2. DailyTimetable (/v2/Rail/TRA/DailyTimetable/Station/{StationID}/{TrainDate}):
//      covers the whole day's scheduled trains, but has no delay data.
// The daily timetable is used as the base list; LiveBoard entries are
// matched in by train number to overlay delay info. Trains with no match
// (too far out for the board to know yet) are marked as "no live data".

const TDX_TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_LIVEBOARD_URL =
  "https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/LiveBoard/Station/0940?%24format=JSON";
const tdxDailyTimetableUrl = (dateStr) =>
  `https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/DailyTimetable/Station/0940/${dateStr}?%24format=JSON`;
const TOKEN_CACHE_KEY = "tdx_access_token";
const SOUTHBOUND_DIRECTION = 1;

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

// Briefly cache TDX responses in KV so multiple people loading the page at
// once don't each trigger a fresh upstream call and risk getting rate limited.
async function fetchJsonCached(env, cacheKey, ttlSeconds, url, token) {
  const cached = await env.TOKEN_KV.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`TDX request failed (${cacheKey}): ${resp.status}`);
  }
  const data = await resp.json();
  await env.TOKEN_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttlSeconds });
  return data;
}

async function getSouthboundTrains(env) {
  const token = await getAccessToken(env);
  const { nowMinutes, dateStr } = taipeiNow();

  const [daily, live] = await Promise.all([
    fetchJsonCached(env, `daily_${dateStr}`, 300, tdxDailyTimetableUrl(dateStr), token),
    fetchJsonCached(env, "live_0940", 60, TDX_LIVEBOARD_URL, token),
  ]);

  const delayByTrainNo = new Map();
  for (const t of live) {
    if (t.Direction === SOUTHBOUND_DIRECTION) {
      delayByTrainNo.set(t.TrainNo, t.DelayTime > 0 ? t.DelayTime : 0);
    }
  }

  const trains = daily
    .filter((t) => t.Direction === SOUTHBOUND_DIRECTION && t.SuspendedFlag !== 1)
    .map((t) => {
      const [h, m] = t.DepartureTime.split(":").map(Number);
      const schedMinutes = h * 60 + m;
      const delayMinutes = delayByTrainNo.has(t.TrainNo)
        ? delayByTrainNo.get(t.TrainNo)
        : null; // null = not on the live board yet, not a confirmed on-time
      const estimatedMinutes = schedMinutes + (delayMinutes ?? 0);
      return {
        time: t.DepartureTime,
        trainNo: t.TrainNo,
        trainType: t.TrainTypeName?.Zh_tw ?? "",
        destination: t.EndingStationName?.Zh_tw ?? "",
        delayMinutes,
        diffMinutes: estimatedMinutes - nowMinutes,
      };
    })
    .filter((t) => t.diffMinutes >= -3) // keep trains due any second now, drop ones long gone
    .sort((a, b) => a.diffMinutes - b.diffMinutes);

  return {
    stationName: "百福",
    updateTime: live[0]?.UpdateTime ?? null,
    trains,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/liveboard") {
      try {
        const data = await getSouthboundTrains(env);
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
