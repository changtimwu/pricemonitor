# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install               # install deps incl. @cloudflare/puppeteer, wrangler
npm run build             # tsc → dist/index.js
npm run typecheck         # tsc --noEmit
npm run dev               # wrangler dev with Miniflare (local KV, no BROWSER binding)
npm run deploy            # build + wrangler deploy
npm run tail              # wrangler tail (deployed-worker logs)
```

For anything touching the `BROWSER` binding (the puppeteer fallback in
`getProductDetail`), local Miniflare won't have it. Use:

```bash
source .env               # loads CLOUDFLARE_API_TOKEN
npx wrangler dev --remote --port 8787
```

`--remote` hits **real production resources** — KV writes during dev
actually persist in the production namespace, secrets and Browser Rendering
quota are real. Test subs created during `--remote` show up in production.

There are no automated tests. Verify by hitting `/run` and inspecting the
tail.

## Architecture

Single-file Worker (`src/index.ts`) compiled to `dist/index.js`. Sections
are box-commented and roughly correspond to layers:

1. **CONFIG** — constants only. Fetch headers, Apple URL, Resend sender.
2. **FETCH PRODUCTS** — `fetchRefurbProducts()` raw-GETs the listing page,
   extracts `<script type="application/ld+json">` blocks, keeps schema.org
   `Product` entries → `Product[]`. No JS rendering needed; the LD-JSON is
   in the initial HTML.
3. **MATCH** — `normalize()` collapses `/\s+/` to a single ASCII space on
   both name and keyword. Required because Apple writes "MacBook Pro" with
   `U+00A0` (NBSP) between the words; a plain-space keyword never matched
   until this fix. Don't remove it.
4. **EMAIL** — Resend `sendEmail()`. Errors are logged, not thrown; the
   surrounding flow continues so other subs still get processed.
5. **KV HELPERS** — one namespace (`SEEN_PRODUCTS`) hosts two key prefixes:
   - `sub:<uuid>` → `{ id, email, keywords[], maxPrice, createdAt, seenIds[] }`
   - `spec:<sku>` → `{ ram, storage, fetchedAt, source: "raw"|"browser" }`
   `listSubs()` walks only `sub:` keys via `kv.list({ prefix })`.
6. **DETAIL ENRICHMENT** — `getProductDetail()` is the only place the
   browser binding is touched. Order: KV cache lookup → raw `fetch()` →
   parse RAM/storage with two regexes → if marker (`rf-pdp-techspecssection`)
   missing or fetch failed, fall back to `puppeteer.launch(env.BROWSER)`.
   Refurb SKUs are immutable, so the cache never expires.
7. **CHECK ALL SUBSCRIBERS** — `checkAllSubs(env, origin)` fans products
   out per sub. The `origin` param exists because `scheduled` handlers have
   no Request to derive a URL from; cron passes `env.PUBLIC_ORIGIN`, fetch
   passes `url.origin`. This origin only feeds unsubscribe links in emails.
8. **HTTP — HTML helpers** — inline-styled HTML strings. `escapeHtml()` is
   required wherever user input is echoed (`thanksPage`, `errorPage`).
9. **HTTP HANDLERS** — `handleSubscribe`, `handleUnsubscribe`, with simple
   validation. Anyone can subscribe any email — POC choice, no double-opt-in.
10. **ENTRY POINTS** — `fetch` dispatches on `url.pathname` + method;
    `scheduled` just calls `checkAllSubs` with `env.PUBLIC_ORIGIN`.

`Env` fields are the contract for `wrangler.toml`:
- `SEEN_PRODUCTS` — `[[kv_namespaces]]`
- `RESEND_API_KEY` — secret
- `PUBLIC_ORIGIN` — `[vars]`
- `BROWSER` — `[browser] binding`

## Cloudflare requirements

- Workers **Paid** plan — the `[browser]` binding is paid-only. Without it
  the fallback path throws when triggered.
- `compatibility_flags = ["nodejs_compat"]` — `@cloudflare/puppeteer`
  imports `node:buffer`.
- `compatibility_date = "2024-09-23"` or newer.

## Operational gotchas

- **`wrangler kv key list` has returned stale output in this account.**
  When inspecting KV, hit the REST API directly:
  ```bash
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/keys?limit=1000"
  ```
- **Resend testing sender** (`onboarding@resend.dev`) only delivers to the
  Resend account owner. Other recipients silently 403. The UI banner warns
  users; do not "fix" the banner without first verifying a domain in Resend
  and updating `EMAIL_FROM` in `src/index.ts`.
- **Adding routes/custom domains to the same zone** needs token scopes
  `Zone.Workers Routes: Edit` and `Zone.DNS: Edit`. A 403 on `GET
  /zones/.../workers/routes` at the end of a deploy means
  `Zone.Workers Routes: Read` is missing — the deploy itself usually still
  succeeded.
- **Apple TW page particulars**: product names use NBSP between words and
  around numerals (`MacBook Pro`, `12 核心 CPU`). The
  detail-page tech-specs accordion is collapsed by CSS but the content is
  already in the initial HTML — `curl` sees it, no browser needed.
