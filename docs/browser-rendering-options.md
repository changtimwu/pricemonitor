# Browser Rendering — three ways in, and what we picked

There are three doors into Cloudflare's hosted headless-Chromium fleet. They
all reach the same browser instances; they differ in how much abstraction
sits between your code and the browser.

## The three layers (don't conflate)

| Layer | What it is |
|---|---|
| **Browser Rendering** (the product) | Cloudflare-managed headless Chromium fleet at the edge. Instances are provisioned and reaped per request — you don't get a pinned VM. |
| **`BROWSER` binding** | The connection from your Worker to that fleet. Declared as `[browser] binding = "BROWSER"` in `wrangler.toml`; appears in code as `env.BROWSER`, a `Fetcher`-shaped object. Not the browser — the pipe to the browser. |
| **`@cloudflare/puppeteer`** | A client library. You hand it the binding (`puppeteer.launch(env.BROWSER)`) and it translates Puppeteer API calls into RPC over that pipe. |

Upstream `puppeteer` (npm) does **not** work in a Worker — it expects
`node:net` and to spawn local Chrome. The Cloudflare fork rewires the
protocol calls to the binding.

## The three doors compared

| | **REST API** | **`@cloudflare/puppeteer`** | **Raw CDP** |
|---|---|---|---|
| Abstraction | Highest — one call per artifact (`POST /content`, `/screenshot`, `/pdf`, `/snapshot`, `/json`) | Mid — `Page` / `Browser` / `Frame` objects with async methods | Lowest — every protocol method explicit (`Page.navigate`, `Runtime.evaluate`, `Input.dispatchMouseEvent`, …) |
| Session model | Stateless. Each call is a fresh browser. | Stateful within one `puppeteer.launch()`. Cookies, JS state, open tabs persist across operations in the session. | Stateful WebSocket. You hold the connection; every command is on that session. |
| Plan tier | Free + Paid | Paid only (binding is paid-only) | Paid (uses the same binding under the hood) |
| Auth | Account API token in `Authorization` header | Worker `env.BROWSER` binding (implicit) | WS URL acquired via REST or via binding (`puppeteer.connect`) |
| Where it runs | Anywhere with HTTP (Worker, server, laptop) | Inside a Worker | Anywhere with WS access |
| Per-call latency | 5–15 s cold (full launch each call) | 3–10 s once a session is warm | Lowest per-command overhead — same session, no SDK frame |
| Best for | One-shot artifacts (HTML / screenshot / PDF of a URL) | Multi-step scraping (login → click → scroll → evaluate → extract) | Surgical inputs, framework-specific events, things Puppeteer DOM events don't survive (compositor-level coordinate clicks through iframes / shadow DOM, raw key codes that fire `e.keyCode`) |

### How they relate

Puppeteer is a friendly wrapper over CDP. Anywhere you can `page.click(x,y)`,
CDP can do the same with `Input.dispatchMouseEvent` directly. Anywhere you
can hit `page.content()`, CDP can do
`Runtime.evaluate({expression:"document.documentElement.outerHTML"})`.
Puppeteer gives you ergonomics + retry semantics; raw CDP gives you
precision.

The REST endpoints are a third path: Cloudflare wrote a small Worker in
front of the fleet that takes one Puppeteer-shaped request, does the
launch/goto/extract/close cycle for you, and returns the artifact. No
session, no SDK on your side.

## Picking one for a task

- **HTML / screenshot / PDF of a URL** → REST (`/content`, `/screenshot`, `/pdf`). Cheapest in code.
- **Login then scrape** → Puppeteer. You want the session and the helpers.
- **Drag-and-drop, dispatch a `keyCode 13` your framework cares about, click through three nested iframes** → raw CDP. Puppeteer will fight you.

## What we picked for this worker (today)

We're on `@cloudflare/puppeteer` via the `BROWSER` binding. The single thing
that path does for us is: when raw `fetch()` of an Apple detail page comes
back without `rf-pdp-techspecssection`, re-fetch through a real browser and
return the HTML.

That's the textbook REST `/content` use case. We picked Puppeteer at the
time because the binding was free for a Paid-plan worker we already had,
and the dependency wasn't visibly painful. After looking at the numbers
side by side, REST is the better fit. See
[#1](https://github.com/changtimwu/pricemonitor/issues/1) for the
migration plan.

### Why REST wins here

| | Today (Puppeteer binding) | After (REST `/content`) |
|---|---|---|
| Upload size | 771 KB (`@cloudflare/puppeteer` + node-compat shims) | ~12 KB (just a `fetch()`) |
| Compat flags | `nodejs_compat` required for `node:buffer` | none |
| Latency on fallback | 3–10 s warm session | 5–15 s cold launch — slightly slower per call, but the fallback essentially never fires for Apple's refurb pages |
| Plan dependency | Paid only | Works on Free too |
| Code surface for fallback | `launch → newPage → goto → content → close` | one `fetch()` |

### When we'd want to keep / move back to Puppeteer

If Apple ever changes the refurb store to need multi-step interaction
(dismiss banner → click "tech specs" → scroll → screenshot), Puppeteer is
the right tool. Today it isn't.

### When we'd want raw CDP

Almost never for this worker. Raw CDP earns its keep when DOM-level
abstractions (Puppeteer's selectors and synthetic events) get in the way —
compositor-level coordinate clicks that pass through iframes and shadow
DOM, dispatching key events with the exact `keyCode` a framework checks
for. Apple's static refurb pages don't need any of that.
