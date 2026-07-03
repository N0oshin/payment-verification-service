# payment-verification-service

PostgreSQL/Supabase-compatible micro service — OCR-verifies a customer's bank-transfer payment screenshot against the order it's meant to pay for, and updates the order's `payment_status` accordingly.


## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18 (ESM) |
| Framework | Express 4 |
| Database | PostgreSQL via `pg`, through `db-adapter.js` (mysql2-compatible shim)
| OCR | `tesseract.js` (pure JS, downloads/caches `eng.traineddata` on first run) |

## How it works

1. Client `POST`s `{ order_number, screenshot_filename }`. The filename must already exist in `UPLOADS_DIR` (this service only reads — screenshots get there via `admin-service`'s upload endpoint, so both services must point at the **same** `UPLOADS_DIR`).
2. Looks up the order by `order_number`, gets its `total`.
3. Runs Tesseract OCR on the screenshot.
4. Scores the extracted text against the order total and the configured payee details (`PAYMENT_PAYEE_NAME`/`PAYMENT_SORT_CODE`/`PAYMENT_ACCOUNT_NUMBER`) plus a set of success-status keywords, producing a probability and `approved`/`rejected` decision.
5. Writes `orders.payment_status` to `paid` or `rejected` accordingly.

`PAYMENT_PAYEE_NAME`/`PAYMENT_SORT_CODE`/`PAYMENT_ACCOUNT_NUMBER` **must match the real bank details customers are told to pay into** .

## Getting started

```bash
npm install
npm run dev    # nodemon, auto-restart
npm start      # plain node
```

Copy `.env.example` to `.env` and fill in real values (a working local `.env` is already present, pointing `UPLOADS_DIR` at `./uploads` for local testing instead of the production `/var/www/backend/uploads`).

The server starts on port `5004` by default (`PAYMENT_VERIFICATION_PORT`).

## Routes

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | No | DB liveness probe. |
| `GET /api/payment-verification/health` | No | Same, alternate path. |
| `POST /api/payment-verification/verify` | No | Body `{ order_number, screenshot_filename }` → runs OCR, returns `{ order, screenshot, verdict }`, and updates `orders.payment_status`. |



