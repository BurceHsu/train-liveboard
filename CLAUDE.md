# train-liveboard

TRA (Taiwan Railway) departure board for any station, as a Cloudflare Worker + static
frontend. Used by Bruce's whole family (added to their phone home screens).

## Deploy rules

- **Always deploy to staging first**, let it be checked, then deploy to production.
  Production is live and in daily use by family — don't deploy straight to it.
  - `npm run deploy:staging` → https://train-liveboard-staging.bruce-hsu.workers.dev
  - `npm run deploy` → https://train-liveboard.bruce-hsu.workers.dev
- Staging has its own KV namespace and its own copy of the TDX secrets (`[env.staging]`
  in `wrangler.toml`), fully separate from production.

## TDX API quota

The TDX (運輸資料流通服務平台) API key in use is on the **free tier**: 5 requests/min,
~4,500 requests/month. This is tight. Any change that increases how often the Worker
calls TDX (shorter cache TTLs, more frequent frontend polling, more stations queried)
should be weighed against this budget. Current caching: live board 3 min, daily
timetable 30 min, station/line lists 1 day, all in KV (`src/index.js`).

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
