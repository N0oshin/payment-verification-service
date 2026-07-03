# payment-verification-service —  Function Reference

## Configuration helpers

### `env(name, fallback = '')`
Reads `process.env[name]`. Returns `fallback` if the variable is unset, `null`, or blank after trimming; otherwise returns it as a string.

**Used by**: every config constant at module load (`PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `UPLOADS_DIR`, `PAYEE_NAME`, `PAYEE_SORT_CODE`, `PAYEE_ACCOUNT_NUMBER`, `DECISION_THRESHOLD`, `corsOrigin`). Not tied to a specific endpoint — read once at startup.

### `envInt(name, fallback)`
Same as `env`, but coerces the result to a `Number` via `env()` and returns `fallback` if the parsed value isn't finite.

**Used by**: `PORT`, `DB_PORT` at module load.

---

## Text/amount matching helpers

### `normalizeText(s)`
Lowercases, collapses runs of whitespace to a single space, and trims.

**Used by**: `containsText`, and inline inside `scoreVerdict` for the status-keyword check.

### `containsText(haystack, needle)`
Returns whether `normalizeText(needle)` appears inside `normalizeText(haystack)`. Returns `false` if `needle` is falsy.

**Used by**: `scoreVerdict` — checks whether `PAYEE_NAME` appears anywhere in the OCR'd screenshot text (`payeeOk`).

### `stripNonDigits(s)`
Removes every non-digit character, leaving just the digit string.

**Used by**: `scoreVerdict` — normalizes `PAYEE_SORT_CODE`/`PAYEE_ACCOUNT_NUMBER` and the full OCR'd text down to digits-only, so sort code / account number matching is robust to dashes, spaces, or OCR noise around the digits (e.g. `60-95-61` and `609561` both match).

### `extractAmounts(text)`
Regex-scans text for money amounts in three forms — `£12.34`, `GBP 12.34`, `12.34 GBP` (case-insensitive, commas stripped first) — and returns every match as a `Number` array.

**Used by**: `scoreVerdict` — the entire basis for `amount_candidates`.

### `bestAmountMatch(extracted, expected, tolerance = 0.03)`
Given a list of extracted amounts and an expected total, returns the numerically closest amount and whether it's within `tolerance` of `expected`. Returns `{ ok: false, best: null }` if `expected` isn't a positive finite number or `extracted` is empty.

**Used by**: `scoreVerdict` — only as a fallback to populate the diagnostic `extracted.best_amount` field in the response when no *exact*-cents amount match was found (the actual approve/reject decision requires an exact match, computed separately via `toCents` — see below).

### `toCents(v)`
Converts a number to integer cents (`Math.round(v * 100)`), or `null` if not finite.

**Used by**: `scoreVerdict` — converts both the expected order total and every extracted candidate amount to cents so they can be compared for an **exact** match, avoiding floating-point comparison bugs (e.g. `112.00 !== 111.99999999`).

### `sigmoid(x)`
Standard logistic function: `1 / (1 + e^-x)`.

**Used by**: `scoreVerdict` — converts the raw additive heuristic `score` into a `0–1` probability.

---

## Decision engine

### `scoreVerdict(extractedText, expectedTotal, ocrConfidence)`
The core OCR-verification decision function. Given the raw text Tesseract extracted from a screenshot, the order's expected total, and Tesseract's average confidence (`0–1`), it:

1. Extracts candidate amounts (`extractAmounts`) and checks for an **exact**-cents match against `expectedTotal` (`amountOk`). Scores `+2.2` if matched, `-1.0` if amounts were found but none match, `0` if no amount was found at all.
2. Checks whether `PAYEE_NAME` appears in the text (`containsText`) — `+1.2` if so.
3. Checks whether the digits of `PAYEE_SORT_CODE` / `PAYEE_ACCOUNT_NUMBER` appear anywhere in the text's digits (`stripNonDigits`) — `+0.6` each if so.
4. Checks the text against a fixed list of success-status keywords (`"payment sent"`, `"successful"`, `"completed"`, `"confirmed"`, `"paid"`, `"✓"`, etc.) — `+1.0` if any match (`statusOk`).
5. Adds `+0.5` if `ocrConfidence >= 0.55`.
6. Runs the total `score` through `sigmoid` to get `probability`, and compares against `PAYMENT_DECISION_THRESHOLD` (default `0.80`) for a preliminary `decisionByScore`.
7. Applies a second, stricter gate on top of the score threshold before actually approving: requires `statusOk`, requires *some* verification signal (payee match, sort code match, account number match, **or** amount match), requires OCR confidence above a threshold that's lower (`0.20`) if both amount and payee matched strongly or higher (`0.35`) otherwise, and **hard-rejects** if any amount was found in the text but didn't match the order total (`hardFailAmount`) — this stops a screenshot showing a different amount from ever being approved even if other signals score well.
8. Returns `{ decision: 'approved' | 'rejected', probability, reasons: string[], extracted: {...} }` — `reasons` accumulates every signal that fired (positive or negative) plus, on rejection, a few explicit denial reasons appended at the end so the caller doesn't have to re-derive why it failed.

**Used by**: `POST /api/payment-verification/verify` — called once per request, immediately after the Tesseract OCR call, with its return value embedded verbatim as the response's `verdict` field.

---

## File-safety helper

### `safeBasename(filename)`
Strips any directory component via `path.basename()`, then rejects (`null`) if the result is empty or still contains `..`, `/`, or `\`. In practice `path.basename()` already neutralizes traversal sequences on its own (e.g. `../../etc/passwd` → `passwd`), so the extra character check is a defense-in-depth no-op rather than the primary guard — the real protection is that the resolved path can never leave `UPLOADS_DIR` because only the final path segment survives.

**Used by**: `POST /api/payment-verification/verify` — sanitizes `screenshot_filename` from the request body before joining it onto `UPLOADS_DIR` to build the on-disk path.

---

## Route handlers (API endpoints)

| Method & path | Purpose | Functions it calls |
|---|---|---|
| `GET /health` | Liveness probe — runs `SELECT 1` directly against the pool. | — |
| `GET /api/payment-verification/health` | Identical to `/health`, alternate path. | — |
| `POST /api/payment-verification/verify` | Validates input, sanitizes the filename, loads the order by `order_number`, OCRs the screenshot, scores it, updates `orders.payment_status`, and returns the full verdict. | `safeBasename`, `Tesseract.recognize` (external), `scoreVerdict` |

### `POST /api/payment-verification/verify` — step by step

1. Reads `order_number` (or legacy alias `orderId`) and `screenshot_filename` from the body; `400` if either is missing.
2. `safeBasename(screenshot_filename)` — `400` `"Invalid screenshot filename"` if it comes back `null`.
3. Builds `path.join(UPLOADS_DIR, safeName)`; `404` `"Screenshot file not found"` if that file doesn't exist on disk.
4. `SELECT id, order_number, customer_email, customer_name, total, created_at FROM orders WHERE order_number = ?` — `404` `"Order not found"` if no row; `400` `"Order total is invalid"` if `total` isn't a positive finite number.
5. `Tesseract.recognize(imagePath, 'eng', ...)` — runs OCR, extracting `text` and `confidence` (0–100, divided by 100 here to normalize to 0–1).
6. `scoreVerdict(extractedText, expectedTotal, ocrConfidence)` — produces the verdict.
7. `UPDATE orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_number = ?` — sets `payment_status` to `'paid'` if `verdict.decision === 'approved'`, else `'rejected'`. This write is wrapped in its own try/catch — if it fails, the error is logged but the response is still returned successfully (the caller isn't told the DB write failed).
8. Responds `{ order, screenshot, verdict }`.

