# payment-verification-service — API Reference

**Base URL:** `http://localhost:5004` (local) or your deployed domain (`PAYMENT_VERIFICATION_PORT`, default `5004`)

All responses are `application/json`. All requests with a body expect `Content-Type: application/json`.


---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/api/payment-verification/health` | Same, alternate path |
| POST | `/api/payment-verification/verify` | OCR-verify a payment screenshot against an order |

---

## Health

### GET `/health`
### GET `/api/payment-verification/health`

Both paths are identical. No request body.

**Response `200`:**
```json
{
  "ok": true,
  "service": "payment-verification-service",
  "db": "connected"
}
```

**Response `500`** (database unreachable):
```json
{
  "ok": false,
  "service": "payment-verification-service",
  "db": "disconnected",
  "error": "<db error message>"
}
```

---

## Verify Payment Screenshot

### POST `/api/payment-verification/verify`

Runs OCR on an already-uploaded payment screenshot, scores it against the named order's total and the service's configured payee details, and **writes the result to `orders.payment_status`** (`paid` or `rejected`) as a side effect — this is not a read-only endpoint.

**Request body:**
```json
{
  "order_number": "ORD-20260630-164254633-93504D",
  "screenshot_filename": "good-payment.png"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `order_number` | string | **yes** | Must match `orders.order_number` exactly. `orderId` is accepted as a legacy alias for this same field. |
| `screenshot_filename` | string | **yes** | Filename only (no path) — must already exist inside the server's `UPLOADS_DIR`. Any directory components are stripped before lookup, so this can never read outside `UPLOADS_DIR`. |

**Response `200` — approved example** (real captured output):
```json
{
  "order": {
    "id": 17,
    "order_number": "ORD-20260630-164254633-93504D",
    "customer_email": "soumyanexus575@gmail.com",
    "total": 112
  },
  "screenshot": {
    "filename": "good-payment.png",
    "path": "uploads/good-payment.png"
  },
  "verdict": {
    "decision": "approved",
    "probability": 0.9978,
    "reasons": [
      "amount_match",
      "payee_match",
      "sort_code_match",
      "account_number_match",
      "status_success_keyword",
      "ocr_confidence_ok"
    ],
    "extracted": {
      "amount_candidates": [112],
      "best_amount": 112,
      "expected_total": 112,
      "payee_expected": "HSA INTERPAY UK",
      "sort_code_expected": "60-95-61",
      "account_number_expected": "21327124",
      "ocr_avg_conf": 0.94
    }
  }
}
```

**Response `200` — rejected example** (real captured output, mismatched amount + missing payee/bank signals):
```json
{
  "order": {
    "id": 15,
    "order_number": "ORD-20260630-163929904-273E19",
    "customer_email": "jane@example.com",
    "total": 260
  },
  "screenshot": {
    "filename": "bad-payment.png",
    "path": "uploads/bad-payment.png"
  },
  "verdict": {
    "decision": "rejected",
    "probability": 0.6225,
    "reasons": [
      "amount_mismatch",
      "payee_missing_or_mismatch",
      "sort_code_not_found",
      "account_number_not_found",
      "status_success_keyword",
      "ocr_confidence_ok",
      "bank_signals_missing"
    ],
    "extracted": {
      "amount_candidates": [50],
      "best_amount": 50,
      "expected_total": 260,
      "payee_expected": "HSA INTERPAY UK",
      "sort_code_expected": "60-95-61",
      "account_number_expected": "21327124",
      "ocr_avg_conf": 0.95
    }
  }
}
```

**Response `400`:**
```json
{ "error": "order_number is required" }
```
```json
{ "error": "screenshot_filename is required" }
```
```json
{ "error": "Invalid screenshot filename" }
```
```json
{ "error": "Order total is invalid" }
```

**Response `404`:**
```json
{ "error": "Screenshot file not found" }
```
```json
{ "error": "Order not found" }
```

**Response `500`:**
```json
{ "error": "<exception message, or \"Verification failed\" if none>" }
```


