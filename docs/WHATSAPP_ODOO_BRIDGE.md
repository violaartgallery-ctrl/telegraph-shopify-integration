# WhatsApp-only Odoo orders bridge — release note and release plan

Status: code only, NOT deployed. Ships OFF (`WHATSAPP_ODOO_BRIDGE_ENABLED` unset).

## What it does

Since 22 Nov 2026 the owner handles WhatsApp orders like this:

1. Create and confirm an Odoo sales order (e.g. `S26318`).
2. Create the Telegraph waybill by hand: hand-made code series `VI` + 8 digits
   (e.g. `VI00000756`), carrier reference = the SO name (`S26318`).
3. Put the waybill code in the SO `origin` and/or `client_order_ref`.

The bot could not follow these orders: every existing lane needs a Shopify order
and the reference `Viola-<order number>`. The bridge adds a separate path:

| Lane (existing scheduler) | Bridge stage | Writes |
|---|---|---|
| discovery (hourly in the day) | reads carrier pages 1–2 (100 newest each), picks refs `^S\d+$`, matches the SO, records a link in Neon | Neon only |
| status (every 30 min in the day) | one carrier read for up to 100 open links, refreshes the snapshot, plans the next step, starts the return grace timer | Neon only |
| financial (every 30 min in the day) | runs planned steps with a fresh carrier read + fresh SO check | Odoo (apply mode only) |

### Matching rules (all must hold, else `unmatched` or `needs-review`)

- Waybill code is `VI` + 8 digits; ref is exactly `S<digits>`, SO number ≥ 26318.
- Exactly one SO with that name; state `sale` (draft/sent = wait and re-check hourly, up to 72 h).
- `origin`/`client_order_ref` equal the waybill code. If both are empty, the code
  may appear in the SO note as the only `VI########` token. Any other code there = review.
- No other SO references the code; no Shopify ShipmentRecord owns the code; the SO is not linked to another waybill.
- EGP; every product line has a positive quantity and a non-negative price.
- Waybill COD price ≥ SO total and ≤ SO total + 150 EGP (customer shipping).
- The SO is fingerprinted (lines, prices, total, partner). Any later edit = review.

### Waybills with NO carrier reference (added 23 Nov, not in the first release)

Older WhatsApp waybills (`VI` + 8 digits) have an empty reference. They are
picked up only when the waybill is **active** (not cancelled, not returned, not
already delivered + merchant-settled) and **exactly one** SO has `origin` or
`client_order_ref` equal to the code (the other field empty or the same code).
All codes found on a discovery run are checked with ONE Odoo read. A waybill that
no SO references creates no row and no notice (it is a Shopify hand-made waybill
or not yet prepared). Two SOs carrying the code, a Shopify record owning it, or
any later change to the SO reference or the waybill reference = review. Same
amount, currency, line, fingerprint and claim rules as the `S#####` path.

### Service-only SOs (generic "WhatsApp Sale" product)

When an SO has no pickings and every product line is a `service` product, there
is no stock: the link starts at `stock-done` (no MO/picking writes). On delivered
+ settled it is invoiced at the carrier net (`customerDue`) and paid on Cash journal
7 like any other link. On a stable 24 h carrier return the SO is cancelled once
(claim `cancel:v1`), with no invoice and no stock moves. Goods lines without
pickings, or a service-only SO that has pickings, go to review.

### Lifecycle

`linked` → `stock-done` → `invoiced` → `paid`, or `stock-done` → `returned`.

- **Stock**: once the parcel is with the carrier (anything after the pickup
  statuses PKR/PKM/PKH/PKD/PRP), the SO's MOs and pickings are completed with the
  same native code the Shopify production lane uses. If the owner already did it, no write.
- **Invoice**: only on DTR + collected + `paidToCustomer` (merchant settled), with
  collected = waybill price, customerDue > 0 and ≤ collected, no returned value.
  One customer invoice for the merchant net (`customerDue`, the same rule as Shopify COD),
  created by the SO invoice wizard and aligned to the net. An exact posted owner
  invoice is adopted; an owner invoice with any other total/state is never edited (review).
- **Payment**: one payment on the configured `ODOO_PAYMENT_JOURNAL_ID` (journal 7),
  which must be a `cash` journal. Verified after posting: posted, inbound, journal,
  amount, partner, reconciled to exactly this invoice, invoice paid with zero residual.
- **Return** (RTRN/RTS/RJCT in status or return status): only after the stock step,
  with zero collected money, no invoice, and the same return seen for 24 h
  (a return that flips back clears the timer — the false-return incidents). Uses the
  native sale-return service: stock comes back on the same SO and the SO is
  cancelled (same as Shopify returns). No return-fee bill is booked by the bridge.

### Always review (Telegram notice once, no Odoo change)

Exchanges/returns with money, DTR + return status, cancelled waybill, zero or
negative COD, negative customerDue, partial collection, price edited after linking,
return before stock delivery, return after invoice, SO edited/cancelled/re-referenced,
owner invoice mismatch, partially paid invoice, non-cash journal, unmatched > 72 h,
any uncertain Odoo write outcome.

## Safety

- Separate tables `WhatsappOdooLink` and `WhatsappOdooOperation`; `ShipmentRecord` untouched.
- Every Odoo write runs inside a durable per-step claim (`stock:v1`, `invoice:v1`,
  `payment:v1`, `return:v1`, unique per link). The claim is set to `started` in Neon
  **before** the first Odoo request is sent, through the existing transport hook
  `beforeAutomaticOdooWrite`. The Odoo client's single-attempt rule and sticky halt
  on unknown outcomes apply unchanged. After any sent write, a failure =
  `needs-review` forever; only a proven no-external-attempt claim may be retried.
- Writes need the existing safe-queue release epoch (`OPS_SAFE_QUEUES_*`); an epoch
  change between claim and write refuses the write.
- Holds: global holds stop the whole lane as today. Per-order hold: a `FailedPayload`
  row with `source = 'whatsapp_odoo_hold'` and `externalId` = SO name or waybill code.
- The bridge cannot write to Shopify, and Shopify-record operations cannot nest inside it.
- Bridge stages are diagnostic-only in the lane, so a bridge error can never fail a
  lane or cause the control message to be redelivered (no replay of other stages).
  The financial stage starts only with ≥10 s left of a 230 s lane budget, max 3 links per run.

## Cost (Vercel / Neon / carrier)

Disabled: zero extra queries. Enabled: about 2 carrier list calls per discovery run,
1 per status run, plus Odoo reads only for new candidates and planned steps; a
handful of small Neon queries per run. No new schedules, crons or webhooks.

## Configuration (all optional; code defaults shown)

| Env | Default | Meaning |
|---|---|---|
| `WHATSAPP_ODOO_BRIDGE_ENABLED` | off | master switch |
| `WHATSAPP_ODOO_BRIDGE_MODE` | `observe` | `observe` = links/plans only, no Odoo writes, no Telegram; `apply` = execute |
| `WHATSAPP_ODOO_BRIDGE_MAX_CUSTOMER_SHIPPING` | 150 | max EGP between waybill price and SO total |
| `WHATSAPP_ODOO_BRIDGE_RETURN_GRACE_HOURS` | 24 | stable-return wait |
| `WHATSAPP_ODOO_BRIDGE_MIN_SO_NUMBER` | 26318 | older SOs are never processed |
| `WHATSAPP_ODOO_BRIDGE_DISCOVERY_PAGES` | 2 | carrier pages read per discovery run |
| `WHATSAPP_ODOO_BRIDGE_UNMATCHED_TIMEOUT_HOURS` | 72 | unmatched → review |
| `WHATSAPP_ODOO_BRIDGE_ALERT_CHAT_IDS` | `PRODUCTION_ALERT_CHAT_IDS` → owner + Ayman | review notices |

## Tests

`npm run test:whatsapp-odoo-bridge` — 207 synthetic checks, no network/DB:
policy matrix, observe mode, happy path S26318/VI00000756 (3150 COD, net 3079 → one
invoice 3079 + one journal-7 payment), settled-before-first-run, owner-adopted
invoices, unknown payment outcome never replayed, failure after a sent write,
pre-write rejection reclaim, 24 h return grace with a false-return flip, holds,
missing epoch, non-cash journal, duplicate waybill per SO, Shopify-owned code,
draft→confirmed rematch, unmatched timeout, discovery cap, and the real
`OdooClient` transport hook (claim is `started` before the request; halt after an
unparseable response). Plus the existing 34 offline suites and typecheck.

## Release plan (owner approval needed for each step)

1. **Review** this PR (stacked on `claude/live-base-cahd-0ffd0fbd`, the byte-exact
   live source 0ffd0fbd). Build the release from the live source + this diff only.
2. **Migration** (`20261122230000_add_whatsapp_odoo_bridge`): two new tables and
   indexes, no change to existing tables. Apply with `prisma migrate deploy` in a
   window between human Previews. Reversible by dropping the two tables.
3. **Deploy OFF**: same release protocol as earlier bot releases (between
   Previews, drain, fences, parity, new epoch, future-only recurrences). With the
   switch unset the bridge reads nothing.
4. **Observe** (1–3 days): `WHATSAPP_ODOO_BRIDGE_ENABLED=true`, mode `observe`.
   Read `WhatsappOdooLink`: S26318/VI00000756 and S26319/VI00000755 should be
   `linked`, with sensible `plannedAction` values. No Odoo writes, no Telegram.
   Carrier-status problems show only as `plannedAction = review:<reason>` (state
   unchanged); SO-matching conflicts are stored as `needs-review` but not announced.
5. **Apply**: `WHATSAPP_ODOO_BRIDGE_MODE=apply`. Watch the first stock step and
   the first settled invoice/payment; compare in Odoo.
6. **Rollback**: unset `WHATSAPP_ODOO_BRIDGE_ENABLED` (immediate, no redeploy of
   code needed beyond the env change). Claims and links stay as audit evidence;
   never delete `WhatsappOdooOperation` rows with status `started`/`needs-review`.

## Not included (follow-ups)

- Historical hand-made waybills (627, May–Nov) stay out: SO number < 26318 and
  most have empty references. The parallel recovery session handles those.
- Return-fee bills and refunds-to-customer for WhatsApp orders.
- Dashboard view of bridge links (data is in Neon now).
- Telegraph push webhook (callback is closed today).
