// Run with `npm test`; it also runs automatically before every deploy.
// TDX is faked here: no network, no secrets, no API quota.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const NOW = Date.parse("2026-11-26T09:00:00+08:00");
const DATE = "2026-11-26";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STATIONS = ["0930", "0940", "0960", "0970", "0990", "1000"];
const LINES = [{ LineID: "WL", Stations: STATIONS.map((StationID) => ({ StationID })) }];

// One timetable row: a southbound train unless told otherwise.
const row = (TrainNo, DepartureTime, extra = {}) => ({
  TrainNo,
  DepartureTime,
  ArrivalTime: DepartureTime,
  Direction: 1,
  EndingStationID: "1180",
  EndingStationName: { Zh_tw: "新竹" },
  StationName: { Zh_tw: "百福" },
  TrainTypeName: { Zh_tw: "區間" },
  SuspendedFlag: 0,
  ...extra,
});
const BAIFU = [row("1001", "09:10"), row("1002", "09:30")];
const XIKE = [row("1001", "09:19"), row("1002", "09:39")];

// Cached copies as the Worker stores them.
const copyOf = (rows, age = 0, now = NOW) => ({ fetchedAt: now - age, rows });
const timetable = (id) => `timetable_${DATE}_${id}`;

// Sets up a fake TDX, a fake KV store and a fake clock for one test.
// A number as an answer means "TDX replies with that HTTP status".
// `perMinute` makes the fake TDX enforce a data rate limit, like the real one.
function setup(t, { tdx = {}, stored = {}, tokenHoursLeft = 20, now = NOW, perMinute, prefetch } = {}) {
  let clock = now;
  const kv = new Map();
  const put = (key, value, options = {}) => void kv.set(key, { value, metadata: options.metadata });
  const initial = {
    tdx_access_token: { access_token: "OLD", expires_at: now + tokenHoursLeft * HOUR },
    ...stored,
  };
  for (const [key, value] of Object.entries(initial)) {
    put(key, JSON.stringify(value), { metadata: value?.fetchedAt && { fetchedAt: value.fetchedAt } });
  }
  const env = {
    TDX_CLIENT_ID: "id",
    TDX_CLIENT_SECRET: "secret",
    PREFETCH: prefetch,
    TOKEN_KV: {
      get: async (key) => (kv.has(key) ? JSON.parse(kv.get(key).value) : null),
      put: async (key, value, options) => put(key, value, options),
      list: async ({ prefix }) => ({
        keys: [...kv]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, entry]) => ({ name, metadata: entry.metadata })),
      }),
    },
  };

  const calls = [];
  const warnings = [];
  const dataCallTimes = [];
  const everyStation = Object.fromEntries(STATIONS.map((id) => [id, BAIFU]));
  const answers = { live: [], token: 500, ...tdx, daily: { ...everyStation, "0970": XIKE, ...tdx.daily } };
  const reply = (answer) =>
    typeof answer === "number" ? new Response("error", { status: answer }) : Response.json(answer);

  t.mock.method(Date, "now", () => clock);
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", (message) => warnings.push(message));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/openid-connect/token")) return reply(answers.token);
    if (perMinute) {
      const recent = dataCallTimes.filter((time) => time > clock - MINUTE).length;
      if (recent >= perMinute) return reply(429);
      dataCallTimes.push(clock);
    }
    if (url.includes("/StationOfLine")) return reply(LINES);
    const daily = url.match(/\/DailyTimetable\/Station\/(\d{4})\//);
    if (daily) return reply(answers.daily[daily[1]]);
    if (url.includes("/LiveBoard/")) return reply(answers.live);
    throw new Error(`unexpected request: ${url}`);
  });

  const board = async (query = "station=0940&to=0970") => {
    const res = await worker.fetch(new Request(`https://test.local/api/liveboard?${query}`), env);
    return { status: res.status, body: await res.json() };
  };
  const cron = async () => {
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  const cached = (key) => (kv.has(key) ? JSON.parse(kv.get(key).value) : undefined);
  const advance = (ms) => void (clock += ms);
  const timetableCalls = () => calls.filter((url) => url.includes("/DailyTimetable/"));
  return { board, cron, cached, advance, calls, timetableCalls, warnings, answers };
}

const trainNos = (body) => body.trains.map((train) => train.trainNo);

// ---- what the board shows ----

test("shows each train once when TDX repeats every row, and logs it", async (t) => {
  const thrice = (rows) => [...rows, ...rows, ...rows];
  const { board, warnings } = setup(t, { tdx: { daily: { "0940": thrice(BAIFU), "0970": thrice(XIKE) } } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.deepEqual(trainNos(body), ["1001", "1002"]);
  assert.ok(warnings.some((w) => w.includes("data anomaly") && w.includes("4 repeated")));
});

test("adds the current delay to the arrival time", async (t) => {
  const { board, warnings } = setup(t, { tdx: { live: [{ TrainNo: "1001", DelayTime: 5 }] } });
  const { body } = await board();
  assert.equal(body.trains[0].delayMinutes, 5);
  assert.equal(body.trains[0].arrivalStation, "汐科");
  assert.equal(body.trains[0].arrival, "09:24");
  assert.equal(body.trains[1].delayMinutes, null);
  assert.equal(body.liveAvailable, true);
  assert.deepEqual(warnings, []); // normal data leaves no warnings
});

test("flags a train that does not stop at the other station", async (t) => {
  const { board } = setup(t, { tdx: { daily: { "0970": [XIKE[0]] } } });
  const { body } = await board();
  assert.equal(body.trains[1].skipsArrival, true);
  assert.equal(body.trains[1].arrival, null);
});

test("treats an empty live board as normal", async (t) => {
  const { board, warnings } = setup(t, { tdx: { live: [] } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.equal(body.liveAvailable, true);
  assert.equal(body.trains.length, 2);
  assert.deepEqual(warnings, []);
});

test("rejects unsupported stations without calling TDX", async (t) => {
  const { board, calls } = setup(t);
  assert.equal((await board("station=0950")).status, 400);
  assert.equal((await board("station=0940&to=0950")).status, 400);
  assert.deepEqual(calls, []);
});

// ---- bad data from TDX ----

test("skips rows with missing fields instead of failing the whole board", async (t) => {
  const broken = [null, {}, row("1003", undefined), row(undefined, "09:50"), row("1004", "09:55", { Direction: 2 })];
  const { board, warnings } = setup(t, { tdx: { daily: { "0940": [...broken, ...BAIFU], "0970": [null, ...XIKE] } } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.deepEqual(trainNos(body), ["1001", "1002"]);
  assert.equal(body.stationName, "百福");
  assert.equal(body.trains[0].arrival, "09:19");
  assert.ok(warnings.some((w) => w.includes("5 unusable")));
});

test("caches a slimmed timetable: one row per train, only the fields the board uses", async (t) => {
  const noisy = BAIFU.map((r) => ({ ...r, VersionID: 9, TripLine: 1, UpdateTime: "2026-11-26T00:00:00+08:00" }));
  const { board, cached } = setup(t, { tdx: { daily: { "0940": [...noisy, ...noisy, ...noisy] } } });
  const { body } = await board();
  const { rows } = cached(timetable("0940"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !("VersionID" in r) && !("UpdateTime" in r) && !("TripLine" in r)));
  assert.equal(body.stationName, "百福");
  assert.equal(body.trains[0].trainType, "區間");
  assert.equal(body.trains[0].destination, "新竹");
  assert.equal(body.trains[0].arrival, "09:19");
});

for (const [what, answer] of [
  ["an empty timetable", []],
  ["an error message sent as a success", { message: "something went wrong" }],
  ["a timetable with no usable row", [{ foo: 1 }]],
]) {
  test(`reports a fault for ${what}, and does not cache it`, async (t) => {
    const { board, cached } = setup(t, { tdx: { daily: { "0940": answer } } });
    const { status, body } = await board();
    assert.equal(status, 502); // not an empty board saying the last train has gone
    assert.equal(body.reason, "source");
    assert.equal(cached(timetable("0940")), undefined);
  });

  test(`keeps the last good copy when TDX sends ${what}`, async (t) => {
    const good = copyOf(BAIFU, 7 * HOUR);
    const { board, cached, warnings } = setup(t, {
      tdx: { daily: { "0940": answer } },
      stored: { [timetable("0940")]: good },
    });
    const { status, body } = await board();
    assert.equal(status, 200);
    assert.deepEqual(trainNos(body), ["1001", "1002"]);
    assert.deepEqual(cached(timetable("0940")), good);
    assert.ok(warnings.some((w) => w.includes("serving the stale copy")));
  });
}

test("fetches again when the cached copy is unusable", async (t) => {
  const { board } = setup(t, { stored: { [timetable("0940")]: copyOf([]) } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.deepEqual(trainNos(body), ["1001", "1002"]);
});

// ---- TDX unavailable or rate limited ----

const everythingCached = {
  [timetable("0940")]: copyOf(BAIFU, HOUR),
  [timetable("0970")]: copyOf(XIKE, HOUR),
  liveboard_0940: copyOf([{ TrainNo: "1001", DelayTime: 2 }], MINUTE),
  station_line_map: [["0940", ["WL"]]],
};

test("needs no TDX call when everything is cached, even with an expired token", async (t) => {
  const { board, calls } = setup(t, { stored: everythingCached, tokenHoursLeft: -1 });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.equal(body.trains[0].delayMinutes, 2);
  assert.deepEqual(calls, []);
});

test("shows scheduled times when delay data cannot be fetched", async (t) => {
  const { board } = setup(t, { tdx: { live: 500 } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.equal(body.liveAvailable, false);
  assert.equal(body.updateTime, null);
  assert.equal(body.trains[0].delayMinutes, null);
  assert.equal(body.trains[0].arrival, "09:19");
});

for (const [minutes, available] of [[10, true], [20, false]]) {
  test(`delay data ${minutes} minutes old is ${available ? "still shown" : "not shown"} when TDX fails`, async (t) => {
    const { board } = setup(t, {
      tdx: { live: 500 },
      stored: { liveboard_0940: copyOf([{ TrainNo: "1001", DelayTime: 4 }], minutes * MINUTE) },
    });
    const { body } = await board();
    assert.equal(body.liveAvailable, available);
    assert.equal(body.trains[0].delayMinutes, available ? 4 : null);
  });
}

test("says it asked too often, not that TDX is broken, on a 429", async (t) => {
  const { board } = setup(t, { tdx: { daily: { "0940": 429 } } });
  const { status, body } = await board();
  assert.equal(status, 503);
  assert.equal(body.reason, "busy");
});

test("after a 429, tapping again does not call TDX until the pause is over", async (t) => {
  const { board, advance, calls, answers } = setup(t, { tdx: { daily: { "0940": 429 } } });
  await board();
  const callsAfterFirst = calls.length;
  for (let tap = 0; tap < 10; tap++) assert.equal((await board()).body.reason, "busy");
  assert.equal(calls.length, callsAfterFirst);

  advance(61 * 1000);
  answers.daily["0940"] = BAIFU;
  assert.equal((await board()).status, 200);
});

test("a visitor leaves refreshing to the cron unless it is 6 hours behind", async (t) => {
  for (const [age, expected] of [[4 * HOUR, 0], [7 * HOUR, 1]]) {
    await t.test(`${age / HOUR} hours old`, async (t) => {
      const { board, timetableCalls } = setup(t, {
        stored: { ...everythingCached, [timetable("0940")]: copyOf(BAIFU, age) },
      });
      await board();
      assert.equal(timetableCalls().length, expected);
    });
  }
});

// ---- switching stations against a 5-per-minute limit ----

test("switching through all six stations within a minute works once timetables are prefetched", async (t) => {
  const { board, cron, advance } = setup(t, { perMinute: 5 });
  for (let run = 0; run < 6; run++) {
    await cron();
    advance(5 * MINUTE);
  }
  const results = [];
  for (const id of STATIONS) {
    results.push(await board(`station=${id}&to=0970`));
    advance(5 * 1000);
  }
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  // The limit is still hit; it costs the delay figures, not the board.
  assert.ok(results.some((r) => r.body.liveAvailable === false));
});

test("with nothing prefetched, hitting the limit is reported as too often, never as a TDX fault", async (t) => {
  const { board, advance } = setup(t, { perMinute: 5 });
  const results = [];
  for (const id of STATIONS) {
    results.push(await board(`station=${id}&to=0970`));
    advance(5 * 1000);
  }
  const failed = results.filter((r) => r.status !== 200);
  assert.ok(failed.length > 0);
  assert.ok(failed.every((r) => r.status === 503 && r.body.reason === "busy"));
});

// ---- the scheduled run ----

test("the scheduled run renews a token that expires soon", async (t) => {
  const { cron, cached } = setup(t, { tokenHoursLeft: 5, tdx: { token: { access_token: "NEW", expires_in: 86400 } } });
  await cron();
  assert.equal(cached("tdx_access_token").access_token, "NEW");
});

test("the scheduled run fetches one timetable at a time until all six are ready", async (t) => {
  const { cron, advance, calls, timetableCalls, cached } = setup(t);
  for (let run = 1; run <= 6; run++) {
    await cron();
    assert.equal(calls.length, run); // one call per run, no token request
    advance(5 * MINUTE);
  }
  assert.equal(new Set(timetableCalls()).size, 6);
  assert.ok(STATIONS.every((id) => cached(timetable(id))));
  await cron();
  assert.equal(calls.length, 6); // all fresh: nothing to do
});

for (const [clockTime, expected] of [["09:00", 1], ["23:00", 0], ["03:00", 0]]) {
  test(`a 3-hour-old timetable is ${expected ? "refreshed" : "left alone"} at ${clockTime}`, async (t) => {
    const now = Date.parse(`${DATE}T${clockTime}:00+08:00`);
    const stored = Object.fromEntries(STATIONS.map((id) => [timetable(id), copyOf(BAIFU, 3 * HOUR, now)]));
    const { cron, calls } = setup(t, { now, stored });
    await cron();
    assert.equal(calls.length, expected);
  });
}

test("one station that keeps failing does not block the others", async (t) => {
  const { cron, advance, cached } = setup(t, { tdx: { daily: { "0940": 500 } } });
  for (let run = 0; run < 12; run++) {
    await cron();
    advance(5 * MINUTE);
  }
  assert.deepEqual(
    STATIONS.filter((id) => !cached(timetable(id))),
    ["0940"]
  );
});

test("the scheduled run fetches no timetable when prefetching is off (staging)", async (t) => {
  const { cron, calls } = setup(t, { prefetch: "off", tokenHoursLeft: 12 });
  await cron();
  assert.deepEqual(calls, []);
});
