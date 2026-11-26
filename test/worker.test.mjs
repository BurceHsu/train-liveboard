// Run with `npm test`; it also runs automatically before every deploy.
// TDX is faked here: no network, no secrets, no API quota.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const NOW = Date.parse("2026-11-26T09:00:00+08:00");
const DATE = "2026-11-26";
const HOUR = 60 * 60 * 1000;
const LINES = [{ LineID: "WL", Stations: [{ StationID: "0940" }, { StationID: "0970" }] }];

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

// Sets up a fake TDX, a fake KV store and a fixed clock for one test.
// A number as an answer means "TDX replies with that HTTP status".
function setup(t, { tdx = {}, stored = {}, tokenHoursLeft = 20 } = {}) {
  const kv = new Map(
    Object.entries({
      tdx_access_token: { access_token: "OLD", expires_at: NOW + tokenHoursLeft * HOUR },
      ...stored,
    }).map(([key, value]) => [key, JSON.stringify(value)])
  );
  const env = {
    TDX_CLIENT_ID: "id",
    TDX_CLIENT_SECRET: "secret",
    TOKEN_KV: {
      get: async (key) => (kv.has(key) ? JSON.parse(kv.get(key)) : null),
      put: async (key, value) => void kv.set(key, value),
    },
  };
  const calls = [];
  const warnings = [];
  const answers = { daily: { "0940": BAIFU, "0970": XIKE }, live: [], token: 500, ...tdx };
  const reply = (answer) =>
    typeof answer === "number" ? new Response("error", { status: answer }) : Response.json(answer);

  t.mock.method(Date, "now", () => NOW);
  t.mock.method(console, "warn", (message) => warnings.push(message));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/openid-connect/token")) return reply(answers.token);
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
  const cached = (key) => (kv.has(key) ? JSON.parse(kv.get(key)) : undefined);
  return { env, board, cached, calls, warnings };
}

const trainNos = (body) => body.trains.map((train) => train.trainNo);

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
  assert.deepEqual(warnings, []); // normal data leaves no warnings
});

test("flags a train that does not stop at the other station", async (t) => {
  const { board } = setup(t, { tdx: { daily: { "0940": BAIFU, "0970": [XIKE[0]] } } });
  const { body } = await board();
  assert.equal(body.trains[1].skipsArrival, true);
  assert.equal(body.trains[1].arrival, null);
});

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

for (const [what, answer] of [
  ["an empty timetable", []],
  ["an error message sent as a success", { message: "something went wrong" }],
  ["a timetable with no usable row", [{ foo: 1 }]],
]) {
  test(`reports a fault for ${what}, and does not cache it`, async (t) => {
    const { board, cached } = setup(t, { tdx: { daily: { "0940": answer, "0970": XIKE } } });
    const { status } = await board();
    assert.equal(status, 502); // not an empty board saying the last train has gone
    assert.equal(cached(`daily_${DATE}_0940`), undefined);
    assert.equal(cached(`daily_${DATE}_0940:stale`), undefined);
  });

  test(`keeps the last good copy when TDX sends ${what}`, async (t) => {
    const { board, cached, warnings } = setup(t, {
      tdx: { daily: { "0940": answer, "0970": XIKE } },
      stored: { [`daily_${DATE}_0940:stale`]: BAIFU },
    });
    const { status, body } = await board();
    assert.equal(status, 200);
    assert.deepEqual(trainNos(body), ["1001", "1002"]);
    assert.deepEqual(cached(`daily_${DATE}_0940:stale`), BAIFU);
    assert.ok(warnings.some((w) => w.includes("serving the stale copy")));
  });
}

test("fetches again when the cached copy is unusable", async (t) => {
  const { board } = setup(t, { stored: { [`daily_${DATE}_0940`]: [] } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.deepEqual(trainNos(body), ["1001", "1002"]);
});

test("treats an empty live board as normal", async (t) => {
  const { board, warnings } = setup(t, { tdx: { live: [] } });
  const { status, body } = await board();
  assert.equal(status, 200);
  assert.equal(body.trains.length, 2);
  assert.deepEqual(warnings, []);
});

test("rejects unsupported stations without calling TDX", async (t) => {
  const { board, calls } = setup(t);
  assert.equal((await board("station=0950")).status, 400);
  assert.equal((await board("station=0940&to=0950")).status, 400);
  assert.deepEqual(calls, []);
});

test("keeps working on the old token when the login server fails", async (t) => {
  const { board } = setup(t, { tokenHoursLeft: 5, tdx: { token: 500 } });
  assert.equal((await board()).status, 200);
});

async function runScheduled(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

test("the scheduled run renews a token that expires soon", async (t) => {
  const { env, cached } = setup(t, { tokenHoursLeft: 5, tdx: { token: { access_token: "NEW", expires_in: 86400 } } });
  await runScheduled(env);
  assert.equal(cached("tdx_access_token").access_token, "NEW");
});

test("the scheduled run leaves a fresh token alone", async (t) => {
  const { env, calls } = setup(t, { tokenHoursLeft: 12 });
  await runScheduled(env);
  assert.deepEqual(calls, []);
});
