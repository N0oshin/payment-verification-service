# payment-verification-service

PostgreSQL/Supabase-compatible clone of `payment-verification-service-node` (`server/payment-verification-service-node`) — OCR-verifies a customer's bank-transfer payment screenshot against the order it's meant to pay for, and updates the order's `payment_status` accordingly.

The **only** structural change vs. the original: the database layer goes through `./db-adapter.js`, a drop-in `mysql2/promise`-compatible shim backed by `pg` (same one used by `order-service`/`tracking-service`), instead of `mysql2/promise` directly. All OCR/scoring logic and routes are unchanged.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18 (ESM) |
| Framework | Express 4 |
| Database | PostgreSQL via `pg`, through `db-adapter.js` (mysql2-compatible shim) — same Supabase project as the other services |
| OCR | `tesseract.js` (pure JS, downloads/caches `eng.traineddata` on first run) |

## How it works

1. Client `POST`s `{ order_number, screenshot_filename }`. The filename must already exist in `UPLOADS_DIR` (this service only reads — screenshots get there via `admin-service`'s upload endpoint, so both services must point at the **same** `UPLOADS_DIR`).
2. Looks up the order by `order_number`, gets its `total`.
3. Runs Tesseract OCR on the screenshot.
4. Scores the extracted text against the order total and the configured payee details (`PAYMENT_PAYEE_NAME`/`PAYMENT_SORT_CODE`/`PAYMENT_ACCOUNT_NUMBER`) plus a set of success-status keywords, producing a probability and `approved`/`rejected` decision.
5. Writes `orders.payment_status` to `paid` or `rejected` accordingly.

`PAYMENT_PAYEE_NAME`/`PAYMENT_SORT_CODE`/`PAYMENT_ACCOUNT_NUMBER` **must match the real bank details customers are told to pay into** (currently `HSA INTERPAY UK` / `60-95-61` / `21327124`, per `admin-service`'s payment-capture email template) — not the generic placeholder defaults baked into the code as a fallback.

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

There is no authentication on `/verify` — it's expected to sit behind internal network access / a reverse proxy, same as the original. It also has no admin session dependency, so it can be called directly by `admin-service` or a job queue.

## Notes on the MySQL -> Postgres port

- `db-adapter.js` auto-translates `?` placeholders and the rest of the MySQL dialect this service happens to use — see its header comment.
- Unlike `tracking-service`, this service has **no schema-bootstrap step** (no `CREATE TABLE`) — it only reads/updates the existing `orders` table owned by `admin-service`.
- The one write query (`UPDATE orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_number = ?`) never had a MySQL `LIMIT` clause, so — unlike `tracking-service`'s port — there was no `UPDATE ... LIMIT` incompatibility to fix here.
- Verified live against the real Supabase database: generated two synthetic payment-screenshot images (via .NET `System.Drawing`, matching/mismatching order totals and payee details) and ran them through the actual `/verify` endpoint — correct `approved`/`rejected` decisions, correct OCR confidence, and correct `orders.payment_status` writes, then reverted the test orders back to `pending`.
