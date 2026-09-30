require('dotenv').config()
const express = require('express')
const cors = require('cors')
const connectMongo = require('./config/mongo')
const redis = require('./config/redis')
const Url = require('./models/Url')

const app = express()
app.use(cors({ origin: 'https://your-actual-dashboard.vercel.app' }))
app.use(express.json())

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const COUNTER_KEY = 'shortener:counter'
const COUNTER_START = 100000000 // starts codes at 5 characters instead of 1
const CACHE_TTL_SECONDS = 3600
const MAX_EXPIRY_SECONDS = 365 * 24 * 3600
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_SECONDS = 60

function encodeBase62(num) {
  let out = ''
  while (num > 0) {
    out = BASE62[num % 62] + out
    num = Math.floor(num / 62)
  }
  return out
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function checkRateLimit(ip) {
  const key = `shortener:ratelimit:${ip}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS)
  }
  return count <= RATE_LIMIT_MAX
}

async function cacheGet(key) {
  try {
    return await redis.get(key)
  } catch (err) {
    console.error('Cache read failed:', err.message)
    return null
  }
}

async function cacheSet(key, value, ttlSeconds) {
  try {
    await redis.set(key, value, 'EX', ttlSeconds)
  } catch (err) {
    console.error('Cache write failed:', err.message)
  }
}

// Not awaited by callers: the redirect goes out first, the click is
// queued afterwards, and a periodic flush batches writes to MongoDB.
function recordClick(code) {
  redis.rpush('shortener:clickqueue', JSON.stringify({ code, at: Date.now() })).catch((err) =>
    console.error('Click queue push failed:', err.message)
  )
}

async function flushClicks() {
  const BATCH_SIZE = 50
  const items = []

  for (let i = 0; i < BATCH_SIZE; i++) {
    const raw = await redis.lpop('shortener:clickqueue')
    if (!raw) break
    items.push(JSON.parse(raw))
  }

  if (items.length === 0) return

  const counts = {}
  for (const { code } of items) {
    counts[code] = (counts[code] || 0) + 1
  }

  await Promise.all(
    Object.entries(counts).map(([code, n]) =>
      Url.updateOne({ shortCode: code }, { $inc: { clicks: n } })
    )
  )
}

setInterval(flushClicks, 3000)

// Redis is not the source of truth for the counter. If it ever restarts empty,
// re-seed it from the highest seq already stored in MongoDB.
async function initCounter() {
  const last = await Url.findOne({ seq: { $exists: true } }).sort({ seq: -1 })
  const floor = Math.max(COUNTER_START, last ? last.seq : 0)
  const current = Number(await redis.get(COUNTER_KEY)) || 0
  if (current < floor) await redis.set(COUNTER_KEY, floor)
}

app.post('/api/shorten', async (req, res) => {
  const { longUrl, expiresInSeconds } = req.body

  if (!longUrl || !isValidHttpUrl(longUrl)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required' })
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const allowed = await checkRateLimit(ip)
  if (!allowed) {
    return res.status(429).json({ error: 'Too many links created. Try again in a minute.' })
  }

  let expiresAt
  if (expiresInSeconds !== undefined) {
    const secs = Number(expiresInSeconds)
    if (!Number.isFinite(secs) || secs <= 0 || secs > MAX_EXPIRY_SECONDS) {
      return res
        .status(400)
        .json({ error: `expiresInSeconds must be between 1 and ${MAX_EXPIRY_SECONDS}` })
    }
    expiresAt = new Date(Date.now() + secs * 1000)
  }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = await redis.incr(COUNTER_KEY) // atomic: no two callers get the same number
      try {
        const doc = await Url.create({
          seq,
          shortCode: encodeBase62(seq),
          longUrl,
          ...(expiresAt && { expiresAt }),
        })
        return res.status(201).json({
          shortCode: doc.shortCode,
          shortUrl: `${BASE_URL}/${doc.shortCode}`,
          longUrl: doc.longUrl,
          expiresAt: doc.expiresAt || null,
        })
      } catch (err) {
        if (err.code !== 11000) throw err
        // Duplicate code: the counter was behind reality. The loop takes the next number.
      }
    }
    res.status(500).json({ error: 'Could not generate a unique code' })
  } catch (err) {
    console.error('Shorten failed:', err)
    res.status(503).json({ error: 'Service unavailable' })
  }
})

app.get('/api/links', async (req, res) => {
  const links = await Url.find().sort({ createdAt: -1 }).limit(20)
  res.json(links)
})

// Must come AFTER the /api routes, or "/:code" would swallow them.
app.get('/:code', async (req, res) => {
  const { code } = req.params
  const cacheKey = `shortener:url:${code}`

  const cached = await cacheGet(cacheKey)
  if (cached) {
    res.set('X-Cache', 'HIT')
    res.redirect(302, cached)
    recordClick(code)
    return
  }

  const doc = await Url.findOne({ shortCode: code })
  if (!doc) {
    return res.status(404).send('Link not found')
  }

  let ttl = CACHE_TTL_SECONDS
  if (doc.expiresAt) {
    const remaining = Math.floor((doc.expiresAt.getTime() - Date.now()) / 1000)
    if (remaining <= 0) {
      return res.status(410).send('This link has expired')
    }
    // A cached link must never outlive the link itself.
    ttl = Math.min(ttl, remaining)
  }

  await cacheSet(cacheKey, doc.longUrl, ttl)
  res.set('X-Cache', 'MISS')
  res.redirect(302, doc.longUrl)
  recordClick(code)
})

const PORT = process.env.PORT || 3001
connectMongo()
  .then(() => initCounter())
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err)
    process.exit(1)
  })