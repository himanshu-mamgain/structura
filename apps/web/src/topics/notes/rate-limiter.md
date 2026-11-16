# Rate Limiter

> 💡 **TL;DR**: A rate limiter answers one question for every request: allow or deny? It runs in the **API gateway**, before any real work. Each caller (an API key, a user or an IP address) has a **rule**, such as "10 requests a minute", read from a small **Rules Store** table and kept in every gateway's memory. The **counters** live in Redis, so all gateways share one count, and one Lua script updates them atomically. When Redis can't answer, the rule's **fail mode** decides: **fail open** (let everything through), **fail closed** (refuse everything), or a **fallback limiter** (a rough count in each gateway's own memory).

## At a glance

| | Token bucket | Fixed window | Sliding window counter | Sliding window log |
|---|---|---|---|---|
| Idea | A bucket of N tokens refills at a steady rate; each request takes one | One counter per minute | Last minute's count, weighted, plus this minute's | Every request's time, kept for one window |
| Bursts | Up to N at once, then the refill rate | Up to 2 × N around a minute's edge | Smoothed | Exact |
| State per key | 2 numbers (tokens, time) | 1 counter | 2 counters | One entry per request |
| Memory for 10 million keys | About 1.2 GB | About 0.7 GB | About 1.4 GB | About 16 GB at 100 requests each |
| Used by | Stripe, most cloud APIs | Simple APIs | Cloudflare | Small, exact limits |

## The four algorithms

The example limit is **10 requests per 60 seconds** for a free plan.

- **Token bucket.** The bucket holds at most 10 tokens and gains one every 6 seconds (10 ÷ 60 = 0.167 a second). A request takes a token, or is refused if none is left. So a client can send 10 at once, then one every 6 seconds. You store just `tokens` and the time of the last request, and work out the refill when the next request comes.
- **Fixed window counter.** One counter per key per minute: `rl:fw:key_live_8f3a:29913450`, where 29913450 is the minute number (Unix seconds ÷ 60). `INCR` it; refuse above 10. It's the cheapest, but 10 requests at 0:55 and 10 more at 1:05 all pass: 20 in 10 seconds.
- **Sliding window counter.** Estimate the last 60 seconds from two counters: `previous × (share of it still inside the last 60 s) + current`. 5 seconds into a minute, after 10 requests last minute: 10 × 0.917 + 0 = 9.17, so one more makes 10.17 and is refused. It's close to exact with two numbers.
- **Sliding window log.** Keep each request's time in a sorted set, drop the ones older than 60 s, and count the rest. It's exact, but the memory grows with the limit.

Try them on the topic page: the simulator runs the real algorithms on the same requests, so you see which ones pass.

## Counting across many gateways

There are 4 gateways behind a load balancer. If each one counted in its own memory, a client could get 10 requests from each: 40, not 10. So the count lives in one shared Redis.

Then two gateways can race. Both read `tokens = 1`, both allow, both write `0`. The fix is to make read, refill and take **one atomic step**: a Lua script runs inside Redis, and Redis runs one script at a time.

```javascript
// The token bucket as one Redis script. Redis's own clock, so gateway clocks don't matter.
const script = `
local cap, rate = tonumber(ARGV[1]), tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1])
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = math.min(cap, (tonumber(s[1]) or cap) + (now - (tonumber(s[2]) or now)) * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], 120)
return allowed and 1 or 0`

const allowed = (await redis.eval(script, 1, 'rl:tb:key_live_8f3a', 10, 10 / 60)) === 1
```

At 200,000 requests a second, that's 200,000 scripts a second. One Redis node runs roughly 60,000 to 100,000 of these a second, so you need at least 4 shards (200,000 ÷ 60,000 = 3.3, rounded up). Each key lives on one shard, so its count stays in one place.

## How rules are stored

The limiter keeps three kinds of state. They live in different places because they change at very different speeds:

| What | Where it lives | Data structure |
|---|---|---|
| **Rules**: the limit for each plan and route. They change a few times a day. | A Postgres table, `rate_limit_rules`, and a copy in each gateway's memory | A hash map: plan id → that plan's rules, longest route first |
| **Counters**: how much each key has used. They change on every request. | Redis | One Redis hash per key, `rl:tb:key_live_8f3a` → tokens 3.5, ts 1794807005, deleted after 120 s unused |
| **Fallback buckets**: a rough count, only while Redis is down | Each gateway's own memory | A hash map: key → { tokens, last }, capped at 100,000 keys |

### The Rules Store table

The **Rules Store** is a small table in Postgres (see the Data model tab). One row is one limit:

| plan_id | route_pattern | algorithm | limit_count | window_seconds | fail_mode |
|---|---|---|---|---|---|
| free | `%` | token_bucket | 10 | 60 | fallback |
| free | `POST /v1/login` | fixed_window | 5 | 60 | closed |
| free | `POST /v1/sms%` | token_bucket | 3 | 60 | closed |
| pro | `%` | token_bucket | 1000 | 60 | fallback |
| pro | `GET /v1/search%` | sliding_window | 300 | 60 | open |

`%` means "anything from here on", as in SQL's `LIKE`. So `%` alone is the plan's default, and a longer pattern is more specific. Limits are data, not code: to give one customer a higher limit, you add a row, with no deploy.

### The copy in memory

Every request needs its rule. At 200,000 requests a second, asking Postgres each time would mean 200,000 queries a second and about a millisecond more per request. But the whole table is tiny: 5 plans × 40 routes = 200 rows, about 40 KB. So each gateway keeps all of it in memory.

The data structure is a **hash map from plan id to a short list of rules**, sorted longest route first. Finding a rule is one map lookup, then a scan of that plan's few dozen rules; the first one that matches is the most specific. With thousands of routes, you would use a trie of path segments instead, but a list is plenty here.

```javascript
// Each gateway's copy of the Rules Store: plan id → that plan's rules, most specific first.
let rulesByPlan = new Map()

function compile(rows) {
  const byPlan = new Map()
  for (const row of rows) {
    const prefix = row.route_pattern.endsWith('%')
    const rule = {
      route: prefix ? row.route_pattern.slice(0, -1) : row.route_pattern,
      prefix,
      algorithm: row.algorithm,
      limit: row.limit_count,
      windowSeconds: row.window_seconds,
      failMode: row.fail_mode, // 'open' | 'closed' | 'fallback'
    }
    if (!byPlan.has(row.plan_id)) byPlan.set(row.plan_id, [])
    byPlan.get(row.plan_id).push(rule)
  }
  // Longest route first, so 'POST /v1/login' is found before the plan's catch-all.
  for (const rules of byPlan.values()) rules.sort((a, b) => b.route.length - a.route.length)
  return byPlan
}

export async function refresh(db) {
  try {
    const { rows } = await db.query(
      'SELECT plan_id, route_pattern, algorithm, limit_count, window_seconds, fail_mode FROM rate_limit_rules',
    )
    // One assignment: a request sees all the old rules or all the new ones, never a mix.
    rulesByPlan = compile(rows)
  } catch (err) {
    // Old rules are far better than none: keep them, and let the alert fire.
    console.warn('rules refresh failed, keeping the old rules:', err.message)
  }
}

export function ruleFor(plan, route) {
  return rulesByPlan.get(plan)?.find((r) => (r.prefix ? route.startsWith(r.route) : route === r.route))
}

// ruleFor('free', 'POST /v1/login')  → { limit: 5, failMode: 'closed', … }
// ruleFor('free', 'GET /v1/orders')  → the catch-all: { limit: 10, failMode: 'fallback', … }
```

The same in Java. An `AtomicReference` holds the map, so a reload swaps the whole thing at once while other threads read it:

```java
import java.sql.Connection;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;

public class RulesCache {
  public enum FailMode { OPEN, CLOSED, FALLBACK }

  public record Rule(String route, boolean prefix, String algorithm, int limit, int windowSeconds, FailMode failMode) {
    boolean matches(String r) { return prefix ? r.startsWith(route) : r.equals(route); }
  }

  // plan id → that plan's rules, longest route first. Replaced whole, never changed in place.
  private final AtomicReference<Map<String, List<Rule>>> byPlan = new AtomicReference<>(Map.of());

  // Run at start, then every 30 s from a ScheduledExecutorService.
  public void refresh(Connection db) {
    String sql = "SELECT plan_id, route_pattern, algorithm, limit_count, window_seconds, fail_mode FROM rate_limit_rules";
    try (var st = db.createStatement(); var rs = st.executeQuery(sql)) {
      Map<String, List<Rule>> next = new HashMap<>();
      while (rs.next()) {
        String pattern = rs.getString("route_pattern");
        boolean prefix = pattern.endsWith("%");
        next.computeIfAbsent(rs.getString("plan_id"), k -> new ArrayList<>()).add(new Rule(
            prefix ? pattern.substring(0, pattern.length() - 1) : pattern, prefix,
            rs.getString("algorithm"), rs.getInt("limit_count"), rs.getInt("window_seconds"),
            FailMode.valueOf(rs.getString("fail_mode").toUpperCase())));
      }
      next.replaceAll((plan, rules) -> {
        rules.sort(Comparator.comparingInt((Rule r) -> r.route().length()).reversed());
        return List.copyOf(rules);
      });
      byPlan.set(Map.copyOf(next));
    } catch (SQLException e) {
      System.err.println("rules refresh failed, keeping the old rules: " + e.getMessage());
    }
  }

  public Optional<Rule> ruleFor(String plan, String route) {
    return byPlan.get().getOrDefault(plan, List.of()).stream().filter(r -> r.matches(route)).findFirst();
  }
}
```

### Keeping the copy fresh

1. **At start**, the gateway loads every rule. Until it has them, its health check fails, so the load balancer sends it no traffic.
2. **Every 30 seconds**, it reloads the whole table. 40 KB is cheap to read, so there's no need to track what changed.
3. **If a reload fails**, it keeps the rules it has and raises an alert. Postgres being down shouldn't change any limits.
4. **For faster changes**, publish a "rules changed" message (Postgres `NOTIFY`, or a Redis channel) and reload at once. The 30-second timer is the safety net.

So a new limit takes effect on every gateway within 30 seconds. Which plan a caller is on comes from authenticating the API key (`api_keys.plan_id`). That is cached too, but only for recently seen keys, since there are 10 million of them.

## Fail open or fail closed

Redis is down, or answers too slowly. The limiter can't count, so it can't know if this request is over the limit. Something must decide anyway:

- **Fail open**: allow the request. Like a fire door that unlocks when the power fails, so people can get out. The API stays up, but for now nothing is limited.
- **Fail closed**: refuse the request, with `503 Service Unavailable` and `Retry-After`. Like a bank vault that stays locked when the power fails. Nothing gets past the limit, but the API is down for everyone.

Put numbers on it. Redis is down for 2 minutes at 200,000 requests a second: 24 million requests.

- Fail closed: all 24 million are refused. A helper failing has taken down the whole API.
- Fail open: all 24 million go through. Nearly all are normal users, so that's fine. But a scraper that was held to 10 a minute now gets everything it asks for.

Neither is right everywhere, so the choice is made **per rule**, in the `fail_mode` column:

| Route | Fail mode | Why |
|---|---|---|
| `GET /v1/orders`, search, most reads | open | The app servers can take a little extra load for a minute |
| `POST /v1/login`, password reset | closed | Unlimited tries let an attacker guess passwords |
| `POST /v1/sms`, sending one-time codes | closed | Each SMS costs money, and fraudsters send thousands |
| Everything else | fallback | A rough limit is better than none, and better than an outage |

Stripe's rate limiters fail open: a bug or a Redis outage must never block API requests. Envoy's rate limit filter also lets requests through when its rate limit service fails, unless you set `failure_mode_deny: true`; then it returns 500.

### Knowing that Redis is down

Don't wait long to find out. Give each Redis call a **20 ms** timeout. Put a circuit breaker around it: after 5 failures in a row, it "opens" and, for the next 5 seconds, the limiter doesn't call Redis at all. It goes straight to the fail mode. Then it lets one call through to test. If that works, it goes back to Redis. Without the breaker, every request would first wait 20 ms for a Redis that isn't there.

## The fallback limiter

The **fallback limiter** is the middle path. While Redis is down, each gateway runs its own token bucket per key, in its own memory, with **its share of the limit**:

- The limit is 10 a minute and there are 4 gateways, so each gateway allows 10 ÷ 4 = 2.5 tokens, refilling at 2.5 a minute.
- The load balancer spreads requests over the gateways, so together they allow about 10 a minute. No gateway talks to another.
- Only whole tokens pass, so a burst gets 2 per gateway: **8**, not 10. The fallback is a little stricter than the real limit, which is the safe side.

What 20 requests at once get, with the free plan's 10 a minute (the simulator shows each case):

| Counter store | Let through | Refused |
|---|---|---|
| Redis healthy | 10 | 10, with 429 |
| Redis down: fail open | 20 | 0 |
| Redis down: fail closed | 0 | 20, with 503 |
| Redis down: fallback limiter, 4 gateways | 8 | 12, with 429 |

Its data structure is a hash map of key → `{ tokens, last }` in each gateway's memory, kept in least-recently-used order and capped at 100,000 keys (about 10 MB). It's used only while the circuit breaker is open. When Redis is back, the map is cleared and Redis's counts take over again.

```javascript
// Runs on each gateway. GATEWAYS comes from service discovery, refreshed with the rules.
let GATEWAYS = 4
const local = new Map() // key → { tokens, last }; a Map keeps insertion order

function takeLocal(key, rule, now = Date.now() / 1000) {
  const capacity = rule.limit / GATEWAYS // this gateway's share
  const perSecond = capacity / rule.windowSeconds
  const b = local.get(key) ?? { tokens: capacity, last: now }
  b.tokens = Math.min(capacity, b.tokens + (now - b.last) * perSecond)
  b.last = now
  const allowed = b.tokens >= 1
  if (allowed) b.tokens -= 1
  local.delete(key) // put it back at the end: the first key is the least recently used
  local.set(key, b)
  if (local.size > 100_000) local.delete(local.keys().next().value)
  return allowed
}

// countInRedis is the Lua script above, with a 20 ms timeout and the circuit breaker.
export async function check(key, rule, countInRedis) {
  try {
    return { allowed: await countInRedis(key, rule), by: 'redis' }
  } catch {
    if (rule.failMode === 'open') return { allowed: true, by: 'fail open' }
    if (rule.failMode === 'closed') return { allowed: false, by: 'fail closed', status: 503 }
    return { allowed: takeLocal(key, rule), by: 'fallback limiter' }
  }
}

// 20 requests at once on one gateway, Redis down: the first 2 pass, the other 18 are refused.
```

The same in Java. A `LinkedHashMap` in access order with `removeEldestEntry` is a ready-made LRU cache:

```java
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;

public class FallbackLimiter {
  public record Decision(boolean allowed, String by) {}

  private volatile int gateways = 4; // from service discovery

  // key → {tokens, last}. Access order and removeEldestEntry make it an LRU capped at 100,000 keys.
  private final Map<String, double[]> buckets = new LinkedHashMap<>(1024, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<String, double[]> eldest) { return size() > 100_000; }
  };

  synchronized boolean takeLocal(String key, RulesCache.Rule rule, double now) {
    double capacity = (double) rule.limit() / gateways; // this gateway's share
    double perSecond = capacity / rule.windowSeconds();
    double[] b = buckets.computeIfAbsent(key, k -> new double[] {capacity, now});
    b[0] = Math.min(capacity, b[0] + (now - b[1]) * perSecond);
    b[1] = now;
    if (b[0] < 1) return false;
    b[0] -= 1;
    return true;
  }

  // countInRedis runs the Lua script with a 20 ms timeout behind a circuit breaker.
  public Decision check(String key, RulesCache.Rule rule, Callable<Boolean> countInRedis) {
    try {
      return new Decision(countInRedis.call(), "redis");
    } catch (Exception redisDown) {
      return switch (rule.failMode()) {
        case OPEN -> new Decision(true, "fail open");
        case CLOSED -> new Decision(false, "fail closed"); // reply 503 with Retry-After
        case FALLBACK -> new Decision(takeLocal(key, rule, System.currentTimeMillis() / 1000.0), "fallback limiter");
      };
    }
  }

  synchronized void redisIsBack() { buckets.clear(); }
}
```

Three things to watch:

- **Uneven traffic.** One client on one keep-alive connection sends every request to the same gateway. Then it gets only a quarter of its limit. During an outage that's usually fine; if not, give each gateway a bit more than its share, such as 1.5 × limit ÷ gateways.
- **The gateway count.** If the fleet grows from 4 to 8 but each gateway still divides by 4, the real limit doubles. Refresh the count with the rules.
- **It's rough on purpose.** It only has to keep abuse bounded for the minutes Redis is away. It doesn't have to be exact.

## Telling the client

A refused request gets `429 Too Many Requests` and `Retry-After`: the seconds until the same request would pass. Allowed responses carry the budget, so a good client slows down before it's refused:

```text
HTTP/1.1 200 OK
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 55

HTTP/1.1 429 Too Many Requests
Retry-After: 6
{"error":"rate_limited","limit":10,"window_seconds":60}
```

A fail-closed refusal is different: the client didn't break the limit, so it gets `503` with `Retry-After`, not `429`.

## How to choose

- **Algorithm**: a **token bucket** when short bursts are fine (most APIs). A **sliding window counter** when the edge of a minute mustn't double the limit. A **fixed window** when cost matters most. A **log** only for small, exact limits.
- **Where to count**: in shared Redis when the limit must hold across all gateways. In each gateway's memory when an approximate limit is enough, as in the fallback.
- **Fail mode**: per route. **Open** for reads, **closed** for login, codes and anything that costs money per request, **fallback** for the rest.
- **Key**: the API key for paid APIs, the user id for apps, the IP address for anonymous traffic. Often two at once: per user and per IP.

## ⚠️ Critical Mistakes

- **Reading the count, then writing it, in two calls.** Two gateways both take the last token. Use `INCR` or one Lua script.
- **Counting in each gateway's memory and calling it the limit.** With 4 gateways, the real limit is 4 times bigger.
- **Asking the Rules Store on every request.** The table is 40 KB; keep it in memory and reload it every 30 seconds.
- **Clearing the rules when a reload fails.** A Postgres blip then removes every limit. Keep the old copy.
- **No timeout on the Redis call.** A slow Redis makes every request slow. Use about 20 ms and a circuit breaker.
- **One fail mode for every route.** Fail open on SMS sending, and an outage becomes a fraud bill. Fail closed on reads, and it becomes an API outage.
- **Using the gateways' clocks in the script.** They drift apart. Use Redis's `TIME`.
- **No Retry-After.** Refused clients retry at once, in a loop, and make the load worse.

## Interview Q&As

**Q: Where do you keep the rate limit rules, and why not read them from the database each time?**

A: In a small table, one row per plan and route, with the algorithm, limit, window and fail mode. Each gateway keeps the whole table in memory, as a map from plan to that plan's rules, most specific first, and reloads it every 30 seconds. Reading the database per request would add a query and about a millisecond to each of 200,000 requests a second, for data that changes a few times a day.

**Q: How do you make the limit hold across ten gateways?**

A: Keep the count in a shared Redis, and update it with one atomic step: INCR for a fixed window, or a Lua script that reads, refills and takes a token. Redis runs one script at a time, so two gateways can't both take the last token. Shard Redis by key so each key's count lives on one node.

**Q: Redis is down. Do you fail open or closed?**

A: It depends on the route, so the rule says. Reads fail open: the API stays up and a minute without limits is fine. Login and SMS sending fail closed, because unlimited tries mean password guessing or a fraud bill. Everything else uses a fallback limiter. A 20 ms timeout and a circuit breaker make the switch fast.

**Q: How does a fallback limiter work without Redis?**

A: Each gateway runs its own token bucket per key in memory, with the limit divided by the number of gateways. With a limit of 10 a minute and 4 gateways, each allows 2.5 a minute, so together about 10. It's rough: an uneven spread of traffic makes it stricter, and a wrong gateway count makes it looser. It only runs while the circuit breaker is open.

**Q: How do you give one enterprise customer a much higher limit without a deploy?**

A: Add a row to the rules table for their plan, or a per-key override. The gateways pick it up on the next reload, within 30 seconds, or at once with a "rules changed" message.

**Q: Why does a fixed window let through twice the limit?**

A: The counter resets at the start of each minute. 10 requests at 0:55 fill the old window, and 10 at 1:05 fill the new one, so 20 pass in 10 seconds. A sliding window counter or a token bucket fixes that.

## Related topics

- [API Gateway](/?topic=api-gateway&read): where the limiter runs, next to authentication and the circuit breaker.
- [Redis: Basics](/?topic=redis-basics&read): hashes, INCR, expiry and Lua scripts.
- [Redis Replication, Sentinel and Cluster](/?topic=redis-replication&read): what a failover does to the counters, and how keys are spread over shards.
- [Distributed Cache](/?topic=distributed-cache&read): the same "copy in memory, refresh it" idea for other data.
- [Consistent Hashing](/?topic=consistent-hashing&read): one way to spread keys over Redis shards.

## Sources

- Stripe: [Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)
- Cloudflare: [How we built rate limiting capable of scaling to millions of domains](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- Envoy docs: [Rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter) (`failure_mode_deny`)
- Redis docs: [INCR, and its rate limiter pattern](https://redis.io/docs/latest/commands/incr/)
- RFC 6585: [429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)

## Why This Matters

Rate limiting comes up in almost every API design interview, and the first answer, "use a token bucket in Redis", is the easy part. The follow-ups are where you stand out: where the rules live and how fast a change reaches every gateway, what happens to login when Redis dies, and how a gateway keeps limiting on its own. Being able to say "fail closed on SMS, fail open on reads, 2.5 tokens per gateway in the fallback" shows you've thought about the system on its worst day.
