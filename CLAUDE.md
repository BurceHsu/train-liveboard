# train-liveboard

TRA (Taiwan Railway) departure board for any station, as a Cloudflare Worker + static
frontend. Used by Bruce's whole family (added to their phone home screens).

## Deploy rules

- **Always deploy to staging first**, let it be checked, then deploy to production.
  Production is live and in daily use by family — don't deploy straight to it.
  - `npm run deploy:staging` → https://train-liveboard-staging.bruce-hsu.workers.dev
  - `npm run deploy` → https://train-liveboard.bruce-hsu.workers.dev
- Deploy with those npm scripts, not `wrangler deploy` directly: they run `npm test`
  first and stop if a test fails.
- Staging has its own KV namespace and its own copy of the TDX secrets (`[env.staging]`
  in `wrangler.toml`), fully separate from production.

## Don't trust TDX data

TDX has sent a day's timetable with every train three times (2026-11-26). The Worker
checks each answer before caching it (`isUsable` in `fetchJsonCached`), drops repeated
or incomplete rows, and logs `data anomaly` / `serving the stale copy` warnings (kept
in Cloudflare Workers Logs, 3 days on the free plan). When TDX misbehaves in a new way,
add a test for it in `test/worker.test.mjs`. After a TDX outage, look at real data on
the page before calling it fixed.

## TDX API quota

The TDX (運輸資料流通服務平台) API key in use is on the **free tier**: 5 requests/min,
~4,500 requests/month. This is tight. Any change that increases how often the Worker
calls TDX (shorter cache TTLs, more frequent frontend polling, more stations queried)
should be weighed against this budget — **both** limits: the per-minute one is what a
person switching between stations runs into (that broke the page on 2026-11-26).

How the Worker stays inside it (`src/index.js`, everything cached in KV):

- Timetables: the 5-minute cron fetches one station per run, after midnight and every
  3 hours from 05:00 to 22:00 (about 42 calls/day, ~1,260/month for six stations). A
  visitor only fetches one that is missing or 6 hours old.
- Live board: 3 min cache; a copy up to 15 min old covers failures; otherwise the page
  shows scheduled times and says so. It must never fail the whole board.
- After a 429 no data is requested until TDX's pause is over; the page says 查詢太頻繁,
  not that TDX is broken.
- Station/line lists: 1 day.
- Staging shares the API key, so it does not prefetch (`PREFETCH = "off"`), and heavy
  testing there can rate-limit production for a minute.

Adding a station adds about 210 prefetch calls a month.

## Direction field correctness

TDX's `Direction` field (0/1) is only empirically verified as 南下/北上 on the 西部幹線
corridor (LineID `WL`/`WL-C`, Keelung-Pingtung — where Baifu is). The API's
`onCorridor` flag tells you whether a station is on that verified corridor. For any
other line, direction options are labeled with the real destination station name
(computed from that station's own daily timetable), not南下/北上 — don't hardcode
南下/北上 labels for a station without checking `onCorridor` first.

## Before proposing a feature involving a platform capability

If a feature depends on whether something is actually possible on a platform (e.g. "can
an iOS widget show live text?"), verify that specific capability first (test it, or find
a concrete confirmed source) before walking through a long manual setup based on it. A
past mistake here cost Bruce 30+ minutes building an iOS Shortcut that turned out to be
structurally incapable of what was promised.
