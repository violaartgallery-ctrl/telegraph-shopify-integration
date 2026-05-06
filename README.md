# Accurate Shopify Integration

Production-ready Node.js + TypeScript webhook service that sends new eligible Shopify orders to Accurate as shipments via GraphQL.

## What this app does

- Receives Shopify `orders/create` webhooks at `POST /webhooks/shopify/orders-create`
- Verifies Shopify HMAC signature
- Ignores duplicate retries using the Shopify order id
- Creates Accurate shipments only for eligible paid/confirmed orders
- Authenticates against Accurate with the `login` mutation and caches the token
- Re-authenticates automatically if the token expires or Accurate returns unauthorized
- Authenticates against Shopify Admin API with the Dev Dashboard client credentials grant
- Stores Shopify ↔ Accurate shipment mappings in SQLite via Prisma
- Provides an embedded app page with a `Make Telegraph shipment` button for manual order shipment creation
- Exposes Accurate governorate/area values in the same dropdown order returned by Accurate
- Receives Accurate shipment status callbacks at `POST /webhooks/accurate/shipment-status`
- Updates Shopify order metafields and tags with shipment/collection state
- Polls open shipments on an interval so status sync still works even if callbacks are delayed
- Saves failed payloads for debugging

## Project layout

```text
accurate-integration/
  prisma/
  samples/
  src/
```

## Environment variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Required core variables:

- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_API_VERSION`
- `ACCURATE_GRAPHQL_ENDPOINT`
- `ACCURATE_USERNAME`
- `ACCURATE_PASSWORD`
- `ACCURATE_DEFAULT_SERVICE_ID`
- `ACCURATE_DEFAULT_CUSTOMER_ID`
- `ACCURATE_DEFAULT_BRANCH_ID`
- `ACCURATE_DEFAULT_SHIPMENT_TYPE`
- `ACCURATE_DEFAULT_PAYMENT_TYPE`

Shopify Dev Dashboard apps do not show a permanent Admin API token in the UI. This app requests short-lived Admin API tokens automatically using `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

Required Shopify Admin API scopes:

- `read_orders`
- `write_orders`
- `read_customers`
- `read_products`

The app must be installed on the store, and the released app version must include those scopes.

For the Loomlac Accurate account, the discovered defaults are:

- `ACCURATE_DEFAULT_SERVICE_ID=1`
- `ACCURATE_DEFAULT_CUSTOMER_ID=1973`
- `ACCURATE_DEFAULT_BRANCH_ID=1`
- `ACCURATE_DEFAULT_SHIPMENT_TYPE=FDP`
- `ACCURATE_DEFAULT_PAYMENT_TYPE=COLC`
- `ACCURATE_DEFAULT_PRICE_TYPE=INCLD`
- `ACCURATE_DEFAULT_OPENABLE_CODE=Y`
- sender/default zone: `1/29`

For other COD stores, set `ACCURATE_DEFAULT_PAYMENT_TYPE` to the Accurate payment code that matches your workflow.

Optional sync control:

- `SYNC_OPEN_SHIPMENTS_INTERVAL_MS=600000`

Strongly recommended:

- `ACCURATE_DEFAULT_RECIPIENT_ZONE_ID`
- `ACCURATE_DEFAULT_RECIPIENT_SUBZONE_ID`

Optional SKU mapping:

- `ACCURATE_PRODUCT_ID_MAP_JSON={"SKU123":101,"SKU456":102}`

## Install and run

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Production build:

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

## Shopify webhook setup

Create a Shopify webhook:

- Topic: `orders/create`
- Format: JSON
- URL: `https://your-domain.com/webhooks/shopify/orders-create`

This app only creates a shipment when the order is:

- not a test order
- not already fulfilled
- confirmed
- `paid`, `partially_paid`, or `authorized`
- or `pending` when the payment gateway is Cash on Delivery

## Manual shipment creation page

Open the app URL in Shopify Admin, or locally open:

```text
http://localhost:3000/
```

The page lists recent unfulfilled Shopify orders and shows a `Make Telegraph shipment` button. Pressing it calls:

```text
POST /api/orders/create-shipment
```

with either `orderGid` or `orderId`. Duplicate shipment creation is still blocked by the SQLite `ShipmentRecord.shopifyOrderId` unique key.

Location values from Accurate are available at:

```text
GET /api/accurate/locations
GET /api/accurate/zones
GET /api/accurate/zones/:parentId/subzones
```

These endpoints preserve Accurate's dropdown order. Shopify's native checkout city/area fields can't be fully replaced by a backend app on non-Plus stores, so use these values for validation/mapping in the app or in a future checkout/admin extension.

## Shopify Admin API authentication

This app uses Shopify's client credentials grant for Dev Dashboard apps. It exchanges the Client ID and Client Secret for an Admin API access token:

```http
POST https://{SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&
client_id={SHOPIFY_CLIENT_ID}&
client_secret={SHOPIFY_CLIENT_SECRET}
```

Expected response:

```json
{
  "access_token": "shpat_or_generated_token",
  "scope": "read_orders,write_orders,read_customers,read_products",
  "expires_in": 86399
}
```

The token is cached in memory and refreshed 5 minutes before expiry. If a Shopify Admin API request returns `401` or `403`, the cached token is cleared, a fresh token is requested, and the request is retried once.

Webhook HMAC verification is separate from Admin API authentication. `SHOPIFY_WEBHOOK_SECRET` should match the secret used when the webhook was created. If the webhook was created by this Dev Dashboard app, this is usually the app client secret.

Test token generation:

```bash
npm run test:shopify-token
```

The script prints success/failure, returned scopes, expiry, and a masked token only.

Test Accurate login and default config:

```bash
npm run test:accurate-config
```

This checks the configured service, shipment type, payment type, default zone, and default subzone without creating a real shipment.

## Accurate authentication flow

This app logs into Accurate with:

```graphql
mutation AccurateLogin($input: LoginInput!) {
  login(input: $input) {
    token
    user {
      id
      username
    }
  }
}
```

Example variables:

```json
{
  "input": {
    "username": "your-accurate-username",
    "password": "your-accurate-password",
    "rememberMe": true
  }
}
```

The returned token is cached in memory and reused until expiry. If Accurate returns unauthorized, the app logs in again automatically.

## Accurate saveShipment example

The Accurate public schema documents `ShipmentInput` fields including:

- `recipientAddress` (required)
- `serviceId` (required)
- `recipientMobile` (required)
- `recipientPhone` (required)
- `recipientZoneId` (required)
- `recipientSubzoneId` (required)
- `refNumber`
- `notes`
- `price`
- `paymentTypeCode`
- `typeCode`
- `shipmentProducts`

Example mutation:

```graphql
mutation SaveShipment($input: ShipmentInput!) {
  saveShipment(input: $input) {
    id
    code
    refNumber
    status {
      code
      name
    }
  }
}
```

Example variables:

```json
{
  "input": {
    "recipientName": "Mona Ali",
    "recipientAddress": "12 Nile Street, Apartment 3, Cairo, Egypt",
    "recipientPhone": "+201001234567",
    "recipientMobile": "+201001234567",
    "serviceId": 1,
    "customerId": 1973,
    "branchId": 1,
    "originBranchId": 1,
    "recipientZoneId": 10,
    "recipientSubzoneId": 101,
    "refNumber": "#1025",
    "notes": "Shopify note: Call before delivery",
    "price": 1499,
    "paymentTypeCode": "COLC",
    "priceTypeCode": "INCLD",
    "typeCode": "FDP"
  }
}
```

## Shopify → Accurate mapping

Implemented in [src/services/accurateMapper.ts](./src/services/accurateMapper.ts).

Mapped fields:

- customer name
- customer phone/mobile
- shipping address
- zone/subzone resolution
- COD amount
- products summary in notes/description
- Shopify order number/name as external reference

### Important note on shipment products

Accurate's public docs for `ShipmentProductInput` only expose:

- `productId`
- `quantity`
- `price`
- `typeCode`

The public docs do **not** document a product lookup query by SKU/title. Because of that:

- this app supports `ACCURATE_PRODUCT_ID_MAP_JSON` for SKU → Accurate product id mapping
- if no mapping is available, line items are still preserved in `notes` and `description`
- see TODO comments in `accurateMapper.ts`

## Accurate callback endpoint

Endpoint:

```text
POST /webhooks/accurate/shipment-status
```

The docs mention callbacks but do not document the payload shape clearly, so the handler is defensive:

- tries `refNumber`
- tries `externalReference`
- tries `shipmentCode`
- tries `shipmentId`

If a shipment is matched, the app:

- updates local persistence
- sets a Shopify order metafield with the latest shipment status

Default metafield:

- namespace: `accurate`
- key: `shipment_status`

Additional metafields written by the sync service:

- `accurate.collection_status`
- `accurate.collected_amount`
- `accurate.returned_value`
- `accurate.tracking_url`
- `accurate.sync_summary`

The app also adds Shopify order tags such as:

- `accurate`
- `accurate-delivered`
- `accurate-returned`
- `accurate-out-for-delivery`

The sync summary metafield includes:

- shipment status
- collection status
- collected amount
- pending collection amount
- returned value
- tracking URL

## Persistence

SQLite + Prisma models:

- `ShipmentRecord`
- `FailedPayload`

`ShipmentRecord.shopifyOrderId` is unique, which prevents duplicate shipment creation across webhook retries.

## Logging and retries

- GraphQL errors are logged clearly
- unauthorized Accurate requests force re-login
- transient network and 5xx errors are retried
- validation errors are not retried
- failed payloads are saved in SQLite

## Deploying

### Render

1. Create a new Web Service
2. Root directory: `accurate-integration`
3. Build command:

```bash
npm install && npx prisma generate && npx prisma migrate deploy && npm run build
```

4. Start command:

```bash
npm start
```

5. Add all env vars from `.env.example`
6. Prefer a persistent disk if you keep SQLite in production

### Railway

1. Create a new service from the repo
2. Set root directory to `accurate-integration`
3. Add env vars
4. Build command:

```bash
npm install && npx prisma generate && npx prisma migrate deploy && npm run build
```

5. Start command:

```bash
npm start
```

### VPS

```bash
cd accurate-integration
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

Run behind Nginx/Caddy and a process manager such as PM2 or systemd.

## Test with a sample Shopify order

Sample payload is included:

- [samples/shopify-order-paid.json](./samples/shopify-order-paid.json)

Example local test:

```bash
curl -X POST http://localhost:3000/webhooks/accurate/shipment-status \
  -H "Content-Type: application/json" \
  -d '{"refNumber":"#1025","status":"IN_TRANSIT"}'
```

For Shopify webhook testing, use a webhook tool or Shopify CLI with the sample order body. The HMAC must match your `SHOPIFY_WEBHOOK_SECRET`.

Example PowerShell flow for local Shopify webhook testing:

```powershell
$body = Get-Content .\samples\shopify-order-paid.json -Raw
$secret = $env:SHOPIFY_WEBHOOK_SECRET
$hmac = [Convert]::ToBase64String(
  [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret)).ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
)

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/webhooks/shopify/orders-create `
  -Headers @{ "X-Shopify-Hmac-Sha256" = $hmac; "Content-Type" = "application/json" } `
  -Body $body
```

## Notes from Accurate public docs

This implementation uses Accurate's published docs:

- Accurate API index: [moataz27.github.io/accuratess/accurate-api](https://moataz27.github.io/accuratess/accurate-api)
- GraphQL endpoint: `https://system.telegraphex.com:8443/graphql`

Confirmed from the public schema:

- `login(input: LoginInput!) -> UserWithToken`
- `saveShipment(input: ShipmentInput!) -> Shipment`
- `ShipmentInput` requires `recipientAddress`, `recipientMobile`, `recipientPhone`, `recipientZoneId`, and `recipientSubzoneId`
- `ShipmentProductInput` requires `productId`, `quantity`, and `price`
- `Shipment` exposes `status`, `returnStatus`, `collected`, `paidToCustomer`, `cancelled`, `trackingUrl`, `collectedAmount`, `pendingCollectionAmount`, `returnedValue`, and `deliveredOrReturnedDate`
- `ListShipmentsFilterInput` supports status and collection filters such as `statusCode`, `delivered`, `collected`, `paid`, `pendingCollection`, and `refNumber`
