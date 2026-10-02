# URL Shortener

A link-shortening service built to explore a classic systems-design problem:
redirects need to be near-instant and happen constantly, while creating a
link must never produce a duplicate, even under concurrent requests.

**Live demo:** https://url-shortener-qsgat8iis-vsb10.vercel.app
**API:** https://url-shortener-0276.onrender.com

---

## The problem this solves

Shortening a URL sounds trivial, but the two operations involved have
opposite requirements:

- **Reads (redirects)** happen constantly and must be fast. A link is
  created once and clicked thousands of times.
- **Writes (creating a link)** must be collision-free, even if two people
  create a link at the exact same millisecond.

This project solves both properly rather than reaching for the easy but
wrong approach (random codes with a retry-on-collision loop, direct
database writes on every redirect):

1. **Collision-free IDs** — a Redis atomic counter, encoded to base62,
   guarantees every code is unique with no retry logic needed
2. **Cache-aside redirects** — Redis is checked first, MongoDB only on a
   cache miss, so most redirects never touch the database at all
3. **Rate limiting** — a Redis counter with a sliding window caps how many
   links one IP can create per minute
4. **Async click analytics** — a redirect pushes onto a Redis queue instead
   of writing to MongoDB directly, and a periodic batched flush groups
   many clicks into far fewer database writes

---

## Architecture

```
Client (React dashboard)
      |
      | REST
      v
+--------------------------------------------------+
|  Express server                                   |
|                                                     |
|   POST /api/shorten -----> Redis INCR (id counter) |
|                       \                             |
|                        `--> MongoDB (create doc)   |
|                                                     |
|   GET /:code  ----> Redis GET (cache) --- MISS ---> MongoDB (lookup)
|                          |                    |      |
|                        HIT                    |    cache it (Redis SET, capped TTL)
|                          |                    |      |
|                          `--------> 302 redirect <---'
|                                       |
|                                  Redis RPUSH (click queue)
|                                       |
|                          (every 3s) Redis LPOP batch --> MongoDB $inc
+--------------------------------------------------+
```

**Why Redis holds two very differently-treated kinds of data:**
- The **ID counter** is real state. If it were ever lost, new links could
  collide with old ones. It is re-seeded from MongoDB's highest stored
  sequence number on every server startup, so Redis is never the sole
  source of truth for it.
- **Cached redirect targets** are disposable. Every cache key has a TTL
  (capped at a link's own expiry, so a cached entry never outlives the
  link it represents), and losing them just means the next redirect falls
  back to MongoDB instead of failing.

**Why clicks are queued instead of written immediately:** a redirect that
also does a synchronous database write puts a write on the single hottest
path in the whole system. Pushing onto a Redis list is close to free by
comparison, and a periodic flush (every 3 seconds, up to 50 clicks per
batch) groups repeated clicks on the same link into one incrementing write
instead of many. The cost is a few seconds of delay before click counts
reflect reality, a real tradeoff, not a free win.

---

## Tech stack

- **Node.js + Express** — API and redirect handling
- **Redis (ioredis)** — atomic ID counter, redirect cache, rate limiting,
  click queue
- **MongoDB (Mongoose)** — permanent link storage and click totals, with a
  TTL index that auto-deletes expired links
- **React + Chart.js + Axios** — the dashboard

---

## Features

- Instant, collision-free short code generation via an atomic Redis counter
- Cache-aside redirects, with a fallback to MongoDB if Redis is unavailable
- Optional per-link expiry (`expiresInSeconds`), enforced both at redirect
  time (returns 410 Gone) and via a MongoDB TTL index for eventual cleanup
- Rate limiting per IP (10 links per 60 seconds), implemented with a single
  atomic `INCR` + `EXPIRE`, no separate library
- Async click analytics: clicks are queued in Redis and flushed to MongoDB
  in batches rather than written on every request
- A dashboard to create links, copy the short URL, and watch click counts
  update live as the batched flush catches up

---

## Honest limitations

- **The click flush has a fixed ceiling.** It drains at most 50 queued
  clicks every 3 seconds. Under sustained traffic well beyond that rate,
  the queue would grow faster than it drains. A production version would
  need a dynamic batch size or a dedicated message queue library rather
  than a hand-rolled Redis list.
- **Short codes are sequential and therefore guessable.** Anyone can walk
  through `aaaaa`, `aaaab`, `aaaac` and enumerate every link in the system.
  A production service would likely add a non-sequential component (a
  random suffix, or hashing the sequence rather than encoding it directly)
  to prevent this.
- **Rate limiting is per IP**, which is easy to work around with multiple
  IPs or a shared network (an office, a VPN). It stops casual abuse, not a
  determined attacker.
- **No authentication.** Anyone can create or view links; there is no
  concept of link ownership.
- **The `noeviction` Redis policy** (required for the counter and rate
  limiter to be reliable) means every cache-related key needs an explicit
  TTL, or the free tier's 30MB could eventually fill. Verified in the
  cache-set logic, but worth flagging as an operational constraint of the
  free tier, not something Redis handles automatically.

---

## Running locally

**Server:**
```bash
cd server
npm install
npm run dev
```
Runs on `http://localhost:3001`.

**Dashboard:**
```bash
cd client
npm install
npm run dev
```
Runs on `http://localhost:5175`.

### Environment variables

`server/.env`:
```
REDIS_URL=your-redis-connection-string
MONGODB_URI=your-mongodb-connection-string
PORT=3001
BASE_URL=http://localhost:3001
```

`client/.env`:
```
VITE_API_URL=http://localhost:3001
```

---

## Trying it out

Paste a URL into the dashboard's form, optionally set an expiry in seconds,
and submit. Copy the short link, open it in a new tab to confirm the
redirect, then watch the click count in the table update a few seconds
later once the batched flush runs.