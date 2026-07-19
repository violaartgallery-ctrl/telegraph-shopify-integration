# Managed Shopify theme source

This directory is the only authoritative source for the Viola Telegraph checkout gate.

Managed files:

- `assets/telegraph-locations.json`
- `assets/theme-premium.js`
- `sections/cart-page.liquid`
- `sections/header.liquid`
- `sections/product-page.liquid`
- `snippets/telegraph-location-selector.liquid`

Safety rules:

1. Never run a full `shopify theme push` from this repository or from either `F:` agent repository.
2. Push `assets/telegraph-locations.json` first.
3. Push only the six managed files with `--only --nodelete`.
4. Use an unpublished theme first, test cart, cart drawer, Buy Now, and mobile, then repeat against the live theme with `--allow-live`.
5. Pull the same six files after deployment and compare SHA-256 hashes.
6. Run `npm run shopify:ensure-validation`; the server-side rule must remain enabled with `blockOnFailure=true`.

The local JSON is the primary location source. The public Vercel endpoint is a bounded fallback. Netlify must not appear in any managed file.
