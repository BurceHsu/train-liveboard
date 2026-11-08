# train-liveboard

A tiny Cloudflare Workers app that shows upcoming southbound TRA (Taiwan Railway)
trains at Baifu Station (百福), built to add to an iPhone/Android home screen as
a lightweight "app".

Live site: https://train-liveboard.bruce-hsu.workers.dev

## How it works

- **Backend**: a single Cloudflare Worker ([src/index.js](src/index.js)) that
  calls the [TDX (運輸資料流通服務平台)](https://tdx.transportdata.tw/) open
  data API for Taiwan Railway.
- **Frontend**: a static, mobile-first page ([public/index.html](public/index.html))
  served by the same Worker via Workers Assets.
- **Data**: two TDX endpoints are merged:
  - `LiveBoard/Station/{StationID}` — real-time board, only covers the next
    ~30-60 minutes but includes delay minutes.
  - `DailyTimetable/Station/{StationID}/{TrainDate}` — the full day's
    scheduled trains, no delay info.

  The daily timetable is the base list; matching trains from the live board
  are overlaid with delay info by train number. Trains too far out to be on
  the live board yet are shown without a delay badge (not claimed as on-time).

- **Station ID**: Baifu's `StationID` (`0940`) was looked up via TDX's
  Station API, not guessed.
- **Direction**: TDX's `Direction` field was verified empirically — trains
  bound for Shulin (south of Taipei/Banqiao) are `Direction = 1`, and trains
  bound for Keelung (north of Baifu) at Baifu station are `Direction = 0`.
  This project treats `Direction === 1` as southbound.

## Secrets

`TDX_CLIENT_ID` and `TDX_CLIENT_SECRET` are stored as Cloudflare Worker
secrets (`wrangler secret put`), never committed to this repo and never sent
to the browser. The Worker also caches the TDX access token (and briefly
caches TDX API responses) in a Cloudflare KV namespace to avoid hitting TDX's
rate limits.

## Local development

```bash
npm install
wrangler dev
```

Create a `.dev.vars` file (gitignored) for local testing:

```
TDX_CLIENT_ID=your-client-id
TDX_CLIENT_SECRET=your-client-secret
```

## Deploy

```bash
wrangler kv namespace create TOKEN_KV   # once, then put the id in wrangler.toml
wrangler secret put TDX_CLIENT_ID
wrangler secret put TDX_CLIENT_SECRET
wrangler deploy
```

## Staging

This is a public site, so changes go to staging first:
https://train-liveboard-staging.bruce-hsu.workers.dev

Staging is a separate Worker (`train-liveboard-staging`) defined under
`[env.staging]` in [wrangler.toml](wrangler.toml), with its own KV namespace
and its own copy of the secrets, so it never shares cached data with
production.

```bash
npm run deploy:staging   # ships to the staging URL
# check it, then:
npm run deploy           # ships to production
```

One-time setup for a fresh staging environment:

```bash
wrangler kv namespace create TOKEN_KV --env staging   # put the id in wrangler.toml
wrangler secret put TDX_CLIENT_ID --env staging
wrangler secret put TDX_CLIENT_SECRET --env staging
```
