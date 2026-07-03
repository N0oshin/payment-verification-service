// =============================================================================
// payment-verification-service — OCR-based payment screenshot verification.
//
// =============================================================================
import express from 'express'
import cors from 'cors'
import mysql from './db-adapter.js'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Tesseract from 'tesseract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dotenvCandidates = [
  process.env.DOTENV_PATH,
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  '/var/www/backend/.env',
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
].filter(Boolean)

let loadedEnvPath = null
for (const p of dotenvCandidates) {
  try {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: true })
      loadedEnvPath = p
      break
    }
  } catch {
    // ignore
  }
}
if (loadedEnvPath) {
  console.log(`Loaded environment from: ${loadedEnvPath}`)
}

function env(name, fallback = '') {
  const v = process.env[name]
  if (v === undefined || v === null || String(v).trim() === '') return fallback
  return String(v)
}

function envInt(name, fallback) {
  const raw = env(name, '')
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const PORT = envInt('PAYMENT_VERIFICATION_PORT', envInt('PORT', 5004))

const DB_HOST = env('DB_HOST', 'localhost')
const DB_PORT = envInt('DB_PORT', 5432)
const DB_USER = env('DB_USER', '')
const DB_PASS = env('DB_PASS', '')
const DB_NAME = env('DB_NAME', '')

const UPLOADS_DIR = env('UPLOADS_DIR', '/var/www/backend/uploads')

const PAYEE_NAME = env('PAYMENT_PAYEE_NAME', '1066 Detailing Ltd')
const PAYEE_SORT_CODE = env('PAYMENT_SORT_CODE', '60-83-82')
const PAYEE_ACCOUNT_NUMBER = env('PAYMENT_ACCOUNT_NUMBER', '46672542')

const DECISION_THRESHOLD = Number(env('PAYMENT_DECISION_THRESHOLD', '0.80'))

const corsOrigin = env('CORS_ORIGIN', '*')

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '2mb' }))
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  })
)

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false
  }
})

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function containsText(haystack, needle) {
  if (!needle) return false
  return normalizeText(haystack).includes(normalizeText(needle))
}

function stripNonDigits(s) {
  return String(s || '').replace(/\D+/g, '')
}

function extractAmounts(text) {
  const t = String(text || '').replace(/,/g, '')
  const out = []
  const patterns = [
    /£\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /\bgbp\s*([0-9]+(?:\.[0-9]{1,2})?)\b/gi,
    /\b([0-9]+(?:\.[0-9]{1,2})?)\s*gbp\b/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1])
      if (Number.isFinite(n)) out.push(n)
    }
  }
  return out
}

function bestAmountMatch(extracted, expected, tolerance = 0.03) {
  if (!Number.isFinite(expected) || expected <= 0 || !Array.isArray(extracted) || extracted.length === 0) {
    return { ok: false, best: null }
  }
  let best = null
  let bestDiff = null
  for (const v of extracted) {
    const diff = Math.abs(v - expected)
    if (bestDiff === null || diff < bestDiff) {
      bestDiff = diff
      best = v
    }
  }
  if (best === null) return { ok: false, best: null }
  return { ok: Math.abs(best - expected) <= tolerance, best }
}

function toCents(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x))
}

function scoreVerdict(extractedText, expectedTotal, ocrConfidence) {
  const reasons = []
  let score = 0

  const amountCandidates = extractAmounts(extractedText)
  const hasAnyAmount = Array.isArray(amountCandidates) && amountCandidates.length > 0
  // If the screenshot contains any amount, require an exact match to the database total (2-decimal exact).
  const expectedCents = toCents(expectedTotal)
  const candidateCents = hasAnyAmount ? amountCandidates.map(toCents).filter((c) => c !== null) : []
  const amountOk = expectedCents !== null && candidateCents.some((c) => c === expectedCents)
  const bestAmount = amountOk ? expectedTotal : (bestAmountMatch(amountCandidates, expectedTotal, 0.05)?.best ?? null)
  if (hasAnyAmount) {
    if (amountOk) {
      score += 2.2
      reasons.push('amount_match')
    } else {
      score -= 1.0
      reasons.push('amount_mismatch')
    }
  } else {
    reasons.push('amount_missing')
  }

  const payeeOk = PAYEE_NAME ? containsText(extractedText, PAYEE_NAME) : false
  if (payeeOk) {
    score += 1.2
    reasons.push('payee_match')
  } else {
    reasons.push('payee_missing_or_mismatch')
  }

  const scExpected = stripNonDigits(PAYEE_SORT_CODE)
  const anExpected = stripNonDigits(PAYEE_ACCOUNT_NUMBER)
  const digits = stripNonDigits(extractedText)

  const scOk = scExpected && digits.includes(scExpected)
  const anOk = anExpected && digits.includes(anExpected)

  if (scOk) {
    score += 0.6
    reasons.push('sort_code_match')
  } else {
    reasons.push('sort_code_not_found')
  }

  if (anOk) {
    score += 0.6
    reasons.push('account_number_match')
  } else {
    reasons.push('account_number_not_found')
  }

  const statusKeywords = [
    'payment sent',
    'payment receipt',
    'payment successful',
    'payment successful!',
    'payment success',
    'receipt',
    'successful',
    'success',
    'completed',
    'complete',
    'confirmed',
    'confirmation',
    'approved',
    'paid',
    'transferred',
    'transfer complete',
    'transfer successful',
    'sent',
    '✓',
  ]
  const statusOk = statusKeywords.some((k) => normalizeText(extractedText).includes(k))
  if (statusOk) {
    score += 1.0
    reasons.push('status_success_keyword')
  } else {
    reasons.push('status_keyword_missing')
  }

  if (Number.isFinite(ocrConfidence) && ocrConfidence >= 0.55) {
    score += 0.5
    reasons.push('ocr_confidence_ok')
  } else {
    reasons.push('low_ocr_confidence')
  }

  const probability = sigmoid(score)
  const decisionByScore = probability >= DECISION_THRESHOLD ? 'approved' : 'rejected'

  // Softer gate: accept screenshots that clearly show success even if amount/reference is missing.
  // Require:
  // - success/status signal present
  // - at least one bank/payee signal OR amount match
  // - OCR not extremely low
  // - if amount is present and mismatched, do not approve
  const hasStrongSignals = amountOk && payeeOk
  const ocrThreshold = hasStrongSignals ? 0.20 : 0.35
  const ocrOk = Number.isFinite(ocrConfidence) && ocrConfidence >= ocrThreshold
  const anyBankSignal = !!payeeOk || !!scOk || !!anOk
  const hardFailAmount = hasAnyAmount && !amountOk

  const hasVerificationSignal = anyBankSignal || amountOk
  const approved = decisionByScore === 'approved' && statusOk && hasVerificationSignal && ocrOk && !hardFailAmount
  const decision = approved ? 'approved' : 'rejected'

  if (!approved) {
    // Add clearer denial reasons.
    if (hardFailAmount && !reasons.includes('amount_mismatch')) reasons.push('amount_mismatch')
    if (!statusOk && !reasons.includes('status_keyword_missing')) reasons.push('status_keyword_missing')
    if (!hasVerificationSignal) reasons.push('bank_signals_missing')
    if (!ocrOk && !reasons.includes('low_ocr_confidence')) reasons.push('low_ocr_confidence')
  }

  return {
    decision,
    probability: Number(probability.toFixed(4)),
    reasons,
    extracted: {
      amount_candidates: amountCandidates,
      best_amount: bestAmount,
      expected_total: expectedTotal,
      payee_expected: PAYEE_NAME,
      sort_code_expected: PAYEE_SORT_CODE,
      account_number_expected: PAYEE_ACCOUNT_NUMBER,
      ocr_avg_conf: Number((ocrConfidence || 0).toFixed(4)),
    },
  }
}

function safeBasename(filename) {
  // Ensure we only ever read from uploads dir
  const base = path.basename(String(filename || ''))
  if (!base) return null
  if (base.includes('..') || base.includes('/') || base.includes('\\')) return null
  return base
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    return res.json({ ok: true, service: 'payment-verification-service', db: 'connected' })
  } catch (e) {
    return res.status(500).json({ ok: false, service: 'payment-verification-service', db: 'disconnected', error: e?.message || String(e) })
  }
})

app.get('/api/payment-verification/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    return res.json({ ok: true, service: 'payment-verification-service', db: 'connected' })
  } catch (e) {
    return res.status(500).json({ ok: false, service: 'payment-verification-service', db: 'disconnected', error: e?.message || String(e) })
  }
})

app.post('/api/payment-verification/verify', async (req, res) => {
  try {
    const orderNumber = String(req.body?.order_number || req.body?.orderId || '').trim()
    const screenshotFilename = String(req.body?.screenshot_filename || '').trim()

    if (!orderNumber) return res.status(400).json({ error: 'order_number is required' })
    if (!screenshotFilename) return res.status(400).json({ error: 'screenshot_filename is required' })

    const safeName = safeBasename(screenshotFilename)
    if (!safeName) return res.status(400).json({ error: 'Invalid screenshot filename' })

    const imagePath = path.join(UPLOADS_DIR, safeName)
    if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Screenshot file not found' })

    const [rows] = await pool.execute(
      'SELECT id, order_number, customer_email, customer_name, total, created_at FROM orders WHERE order_number = ? LIMIT 1',
      [orderNumber]
    )

    const orders = Array.isArray(rows) ? rows : []
    if (!orders.length) return res.status(404).json({ error: 'Order not found' })

    const order = orders[0]
    const expectedTotal = Number(order.total || 0)
    if (!Number.isFinite(expectedTotal) || expectedTotal <= 0) return res.status(400).json({ error: 'Order total is invalid' })

    const ocrRes = await Tesseract.recognize(imagePath, 'eng', {
      logger: () => {},
    })

    const extractedText = ocrRes?.data?.text || ''
    const ocrConfidence = Number(ocrRes?.data?.confidence || 0) / 100

    const verdict = scoreVerdict(extractedText, expectedTotal, ocrConfidence)

    // Update order payment_status based on verification result
    try {
      const newStatus = verdict.decision === 'approved' ? 'paid' : 'rejected'
      await pool.execute(
        'UPDATE orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_number = ?',
        [newStatus, orderNumber]
      )
      console.log(`[payment-verification] Updated order ${orderNumber} payment_status to ${newStatus}`)
    } catch (dbErr) {
      console.error(`[payment-verification] Failed to update order ${orderNumber} payment_status:`, dbErr?.message || dbErr)
    }

    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number,
        customer_email: order.customer_email,
        total: expectedTotal,
      },
      screenshot: { filename: safeName, path: imagePath },
      verdict,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Verification failed' })
  }
})

app.listen(PORT, () => {
  console.log(`✅ Payment verification service (Node) running on port ${PORT}`)
})
