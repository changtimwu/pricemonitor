# 🖥️ Apple Refurb Tracker — Cloudflare Worker

Monitors Apple Taiwan's Refurbished Store for **Mac Studio** and **Mac Mini**,
runs every 30 minutes on Cloudflare Workers (no server needed), and sends
email alerts via [Resend](https://resend.com).

---

## How it works

The Worker fetches `https://www.apple.com/tw/shop/refurbished/mac` and parses
the embedded `<script type="application/ld+json">` blocks (one schema.org
`Product` per item). New items matching `WATCH_KEYWORDS` are emailed once,
then their SKUs are recorded in KV so they aren't re-notified.

---

## Project Structure

```
apple-refurb-tracker/
├── wrangler.toml      ← Cloudflare config + cron schedule + KV binding
├── tsconfig.json
├── package.json
├── src/
│   └── index.ts       ← Worker logic
└── dist/              ← Compiled JS (gitignored, produced by `npm run build`)
```

---

## Deploy from scratch

### 1. Install dependencies
```bash
npm install
```

### 2. Authenticate with Cloudflare
Either `npx wrangler login` (browser flow) or set `CLOUDFLARE_API_TOKEN` in a
`.env` file. The token needs these scopes:
- Account → Workers Scripts: Edit
- Account → Workers KV Storage: Edit
- Account → Account Settings: Read

### 3. Create the KV namespace
```bash
npx wrangler kv namespace create SEEN_PRODUCTS
```
Copy the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Deploy (creates the Worker so you can attach secrets)
```bash
npm run deploy
```

### 5. Set secrets
```bash
printf '%s' 'YOUR_RESEND_API_KEY'   | npx wrangler secret put RESEND_API_KEY
printf '%s' 'you@example.com'       | npx wrangler secret put NOTIFY_EMAIL_TO
```
Get a Resend API key at https://resend.com/api-keys. The sender is hardcoded
to Resend's testing address `onboarding@resend.dev` — no DNS setup required.
To send from your own domain, verify it in Resend and update `EMAIL_FROM` in
`src/index.ts`.

### 6. Trigger a manual check
```bash
curl https://<your-worker>.workers.dev/
```

---

## Local development

```bash
npm run dev    # wrangler dev with Miniflare (KV is simulated locally)
```

Then hit `http://localhost:8787/` to fire the fetch handler. Miniflare 3 does
not auto-trigger scheduled events; pass `--test-scheduled` to `wrangler dev`
and visit `http://localhost:8787/__scheduled` to simulate a cron run.

---

## Check logs

Live tail of the deployed Worker:
```bash
source .env                          # loads CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=15bfe332876061d9a548a4f3d6835657
npx wrangler tail --format pretty
```
Leave it running and you'll see every cron tick and fetch in real time:
```
GET https://apple-refurb-tracker.changtimwu.workers.dev/ - Ok
  (log) [2026-05-19T08:09:05.040Z] Checking Apple TW Refurbished Store...
  (log) Fetched 14 products
  (log) No new target products found.
```
A tail session expires after a few hours; re-run the command to reconnect.
Stop with `Ctrl-C`.

Scheduled-trigger logs use the same `wrangler tail` stream — look for events
without a `GET` line; they're the cron runs (`*/30 * * * *`).

Historical logs and tail sessions can also be viewed in the Cloudflare
dashboard at **Workers & Pages → apple-refurb-tracker → Logs**.

---

## Cron schedule

`*/30 * * * *` in `wrangler.toml` (every 30 min). Change and redeploy to
adjust — e.g. `*/15 * * * *` for every 15 minutes.

---

## Configuration knobs (`src/index.ts`)

- `WATCH_KEYWORDS` — product-name substrings to watch (case-insensitive).
- `MAX_PRICE_TWD` — set to a positive number to drop anything above that
  price; `0` disables the filter.
- `EMAIL_FROM` — sender shown in the email. Defaults to Resend's testing
  sender; swap for `Name <you@your-domain>` once the domain is verified.
