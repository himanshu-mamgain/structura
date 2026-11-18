# Retries: Backoff and Jitter

> 💡 **TL;DR**: When a call fails, try again, but not at once and not in step with everyone else. **Exponential backoff** doubles the longest wait after each failure: 1, 2, 4, 8 seconds, up to a cap. **Jitter** makes each client pick a random wait below that, so 10,000 clients that failed together don't come back together. Then put limits on top: a few **tries per request**, a **retry budget** (retries under 10% of requests), retries at **one layer** only, and an **idempotency key** so a retry never pays twice. When the tries run out, park the job in a **dead-letter queue** and tell the user it's pending.

## At a glance

The example uses a base of 1 second and a cap of 32 seconds.

| Strategy | Wait before the next try | Waits after tries 1 to 5 | Clients that failed together… |
|---|---|---|---|
| No backoff | Always the same, say 1 s | 1, 1, 1, 1, 1 s | come back together, every second |
| Exponential backoff | base × 2^(try − 1), capped | 1, 2, 4, 8, 16 s | still come back together, less often |
| Full jitter | random from 0 to that | 0–1, 0–2, 0–4, 0–8, 0–16 s | spread out. The usual default |
| Equal jitter | half of it, plus a random half | 0.5–1, 1–2, 2–4, 4–8, 8–16 s | spread out, but always wait a little |
| Decorrelated jitter | random from base to 3 × the last wait, capped | 1–3 s, then grows from the last wait | spread out, close to full jitter |

## What a retry storm is

A **retry** is a second try at a call that failed. Most failures are short: a lost packet, a server restarting during a deploy, a busy moment. Trying again a second later often works, so every client library retries.

The trouble starts when many clients fail at the **same moment**. Say a payment provider goes down for 10 seconds while 10,000 phones are paying. Each phone gets a 503 at the same time. If each one waits exactly 1 second, they all come back in the same instant. The provider can serve 2,000 requests a second, so 200 in each tenth of a second. 10,000 arrive in one tenth: 50 times too many. 200 get through, and the other 9,800 come back together again one second later.

This is a **retry storm**: the retries make more load than the users ever did, and they keep a server down that could have recovered. It's also called the **thundering herd** problem.

## How exponential backoff works

**Exponential backoff** means: wait longer after each failure. The usual rule doubles the longest wait each time, and stops growing at a **cap**.

```
ceiling = min(cap, base × 2^(try − 1))
```

| After try | Ceiling (base 1 s, cap 32 s) | Total waited so far |
|---|---|---|
| 1 | 1 s | 1 s |
| 2 | 2 s | 3 s |
| 3 | 4 s | 7 s |
| 4 | 8 s | 15 s |
| 5 | 16 s | 31 s |
| 6 | 32 s (the cap) | 63 s |
| 7 | 32 s | 95 s |

Backoff alone makes each client gentler. It doesn't stop clients that failed together from **staying together**. They all use the same numbers, so they all try at 1, 3, 7, 15 and 31 seconds. The waves come less often, but each wave is just as big.

## Jitter: the random part

**Jitter** means adding randomness to the wait. With **full jitter**, each client picks a random wait between 0 and the ceiling. After the 5th try, the ceiling is 16 seconds. 10,000 phones spread over 16 seconds is about 625 a second, or 63 in each tenth of a second. That's well under the 200 the provider can serve.

The average wait halves, but that's fine: what matters is that the clients no longer arrive at once. In AWS's simulations (Marc Brooker, 2015), no jitter did the most work. Of the three jitters, equal jitter did worst. Full jitter used the least work; decorrelated jitter finished slightly sooner.

```javascript
// The wait before the next try, in ms. try = 1 after the first failure.
const base = 1000
const cap = 32000
const ceiling = (attempt) => Math.min(cap, base * 2 ** (attempt - 1))
const between = (lo, hi) => lo + Math.random() * (hi - lo)

const full = (attempt) => between(0, ceiling(attempt)) // 0…ceiling
const equal = (attempt) => ceiling(attempt) / 2 + between(0, ceiling(attempt) / 2) // half…ceiling
const decorrelated = (lastWait) => Math.min(cap, between(base, lastWait * 3)) // grows from the last wait

// after try 4: full → 0…8 s, equal → 4…8 s; decorrelated after a 2 s wait → 1…6 s
```

The same in Java:

```java
import java.util.concurrent.ThreadLocalRandom;

public class Jitter {
  static final double BASE = 1000, CAP = 32000; // ms

  static double ceiling(int attempt) { return Math.min(CAP, BASE * Math.pow(2, attempt - 1)); }
  static double between(double lo, double hi) { return lo + ThreadLocalRandom.current().nextDouble() * (hi - lo); }

  static double full(int attempt) { return between(0, ceiling(attempt)); }
  static double equal(int attempt) { return ceiling(attempt) / 2 + between(0, ceiling(attempt) / 2); }
  static double decorrelated(double lastWait) { return Math.min(CAP, between(BASE, lastWait * 3)); }
}
```

Jitter helps anywhere many machines act on the same clock, not just retries. A cron job at exactly 00:00 on 500 servers, or cache entries that all expire at the same second, make the same kind of spike. Add a few random seconds to each.

## Which failures to retry

Retry only failures that **can pass on their own**. Retrying the rest just adds load and delays the real error.

| Response | Retry? | Why |
|---|---|---|
| Timeout, connection reset, connection refused | Yes | The network or server had a bad moment |
| 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout | Yes | Something in the path is down or busy |
| 429 Too Many Requests | Yes, after Retry-After | You were rate limited; wait as long as it says |
| 500 Internal Server Error | Maybe, once or twice | Could be a blip, could be a bug that fails every time |
| 400, 401, 403, 404, 422 | No | The request itself is wrong; it will fail again |
| 501 Not Implemented | No | The server will never support it |
| 409 Conflict | Only after reading again | Often an optimistic-lock clash: fetch the new version first |

A **timeout** needs extra care. The server may have done the work and only the answer was lost. So a retry after a timeout is only safe if the call is **idempotent**: doing it twice has the same effect as doing it once. See "Retries need idempotency" below.

### Retry-After

When a server knows how long it needs, it says so in the **Retry-After** header, on a 503 or 429:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 30
```

The value is seconds (`30`) or a date. When it's there, wait that long instead of your own backoff. Good servers add their own jitter to it, so their clients don't all come back at second 30.

## Limits: tries, budgets and layers

Backoff and jitter spread retries out. Limits stop them from multiplying.

- **Tries per request.** Give up after a few tries: 3 to 5 when a user is waiting on a screen, more, spread over minutes, for a background job. Google's SRE (site reliability engineering) book uses up to 3 attempts per request.
- **A retry budget per client.** Only retry while retries are under 10% of this client's requests, counted over the last minute. Then a storm adds at most 10% more load (1.1×), not 3× or 5×. When the budget is spent, fail fast: the dependency is clearly in trouble.
- **One layer only.** If the app, the API and the service each make 4 tries, one click becomes **4 × 4 × 4 = 64** calls to the database. Retry at the layer just above the one that failed. If that layer gives up, it returns an "overloaded, don't retry" error, so the layers above don't retry too.

Here is a retry budget, keeping the last minute in six 10-second buckets:

```javascript
export class RetryBudget {
  constructor(ratio = 0.1) {
    this.ratio = ratio
    this.buckets = Array.from({ length: 6 }, () => ({ requests: 0, retries: 0 }))
    this.current = 0
    setInterval(() => {
      this.current = (this.current + 1) % 6 // the oldest 10 s drops out
      this.buckets[this.current] = { requests: 0, retries: 0 }
    }, 10_000)
  }

  sum(field) {
    return this.buckets.reduce((n, b) => n + b[field], 0)
  }

  onRequest() {
    this.buckets[this.current].requests++
  }

  canRetry() {
    if (this.sum('retries') >= this.ratio * this.sum('requests')) return false // fail fast
    this.buckets[this.current].retries++
    return true
  }
}
```

## Retries need idempotency

A retry sends the same request again. For a read, that's harmless. For a payment, it can charge the card twice: the first try worked, but the answer timed out.

So every call that changes something carries an **idempotency key**: a unique id the client makes once, such as `pay_7f3a2c`, and sends on every try. The server stores the result under that key. A second request with the same key gets the stored result, and nothing runs twice.

```
POST /v1/payments
Idempotency-Key: pay_7f3a2c
{ "order": "ord_1042", "amount": 49900, "currency": "INR" }
```

Make the key **before** the first try, not per try. A new key on each retry defeats the point.

## Circuit breaker and dead letters

Two more pieces finish the design.

- A **circuit breaker** sits in front of the dependency. After many failures in a row, it **opens**: calls fail at once, without touching the dependency, for say 30 seconds. Then it lets one test call through. If that works, it **closes** again. Retries go through the breaker, so while it's open they fail fast instead of piling on.
- A **dead-letter queue** (DLQ) holds the jobs that ran out of tries. Nothing is lost: a worker tries them again minutes later, or a person looks at them. The app tells the user "Payment pending" rather than "Payment failed", because the money may still go through.

## What the simulator shows

The topic's simulator runs 10,000 phones against a provider that serves 2,000 requests a second and is down for the first 10 seconds. Each strategy has 8 tries, except the first, which never stops.

| Strategy | Paid | Gave up | Requests sent | Busiest second after recovery | Last payment |
|---|---|---|---|---|---|
| Retry every 1 s, forever | 10,000 | 0 | 355,000 | 10,000 | 59 s |
| Exponential backoff, no jitter | 800 | 9,200 | 78,800 | 10,000 | 95 s |
| Exponential backoff + full jitter | 9,993 | 7 | 59,684 | 1,502 | 41.4 s |

- **Every second, forever**: everyone pays in the end, but it takes 35.5 requests per payment. The provider gets 5 times its capacity every second for 40 seconds.
- **Backoff without jitter** is the worst of the three. All phones try at 15, 31, 63 and 95 seconds. Each wave is 10,000 requests and only 200 fit, so 9,200 phones run out of tries.
- **Full jitter** never goes over capacity after the recovery. Almost everyone pays, with the fewest requests. The 7 that gave up were unlucky: their 8 tries all fell inside the outage.

Try a 30-second outage with jitter: 1,169 phones give up. 8 tries with a 32-second cap cover only about 95 seconds at most, and about half that on average. A long outage needs more tries, a longer cap, or a dead-letter queue to finish the job later.

## How to choose

- **Default**: exponential backoff with full jitter, a base of 100 ms to 1 s, a cap of 20 to 60 s, and 3 to 5 tries.
- **A user is waiting**: few tries and a short cap. After about 10 seconds, show "pending" and finish in the background.
- **Background jobs and queue consumers**: more tries, longer caps (minutes), then a dead-letter queue.
- **The server sends Retry-After**: use it.
- **Many layers**: retry at one layer only, and pass "don't retry" up.
- **Anything that changes data**: an idempotency key on every try, made once.
- **Expect long outages**: add a circuit breaker, so you stop calling a dependency that is clearly down.

## ⚠️ Critical Mistakes

- **Retrying at once, in a tight loop.** A short failure becomes a self-made outage.
- **Backoff without jitter.** The clients stay in step, and the waves stay just as big.
- **Retrying every error.** A 400 or 401 will fail again; retrying only adds load and hides the bug.
- **Retrying at every layer.** 3 layers of 4 tries make 64 calls to the bottom one.
- **No idempotency key on a retried payment.** A timed-out first try that actually worked means a double charge.
- **A new idempotency key on each try.** The server can't tell the tries are the same request.
- **Ignoring Retry-After.** The server told you when it would be ready; earlier tries are wasted.
- **No timeout on each try.** A hanging call holds a thread forever, and the retry never starts.
- **No limit on tries.** A dead dependency gets called forever, and requests pile up.
- **Showing "failed" when the tries run out.** The first try may have worked. Show "pending" and check.

## Interview Q&As

**Q: Why does jitter help if the average wait stays about the same?**

A: The problem isn't how long clients wait, it's that they come back at the same moment. Clients that failed together and use the same backoff numbers retry together, so the server sees big waves. Jitter spreads each wave over the whole wait, so the server sees a steady trickle it can handle. In the simulator, the busiest second after recovery drops from 10,000 requests to about 1,500.

**Q: Which failures would you retry?**

A: Timeouts, connection errors, 502, 503, 504, and 429 after its Retry-After. Maybe a 500 once. Never 400, 401, 403, 404 or 422: the request is wrong and will fail again. And only retry a call that changes data if it has an idempotency key.

**Q: Three services each retry 3 times. How many calls can one user request cause at the bottom?**

A: Each layer makes 4 tries: the first and 3 retries. So 4 × 4 × 4 = 64 calls to the bottom service. The fix is to retry at one layer only, the one just above the failure, and to return an "overloaded, don't retry" error upward when it gives up.

**Q: What is a retry budget?**

A: A limit on retries as a share of all requests, such as 10% over the last minute. While things are healthy, retries are rare and always allowed. When a dependency is failing, the budget runs out quickly and the client fails fast. The extra load from retries is then at most 10%, however bad the outage.

**Q: How do retries and idempotency keys work together for payments?**

A: The client makes one idempotency key per payment and sends it on every try. The provider stores the result under that key. If the first try worked but the answer was lost, the retry gets the stored result instead of a second charge.

**Q: The last retry fails. What does the user see?**

A: "Payment pending", not "failed", because an earlier try may have worked. The payment goes to a dead-letter queue. A worker checks its status with the provider later, using the same idempotency key, and the app updates when it knows.

## Related topics

- [Idempotent Payments](/?topic=payment-idempotency&read): the idempotency keys that make retries safe.
- [Circuit Breaker and Resilience Patterns](/?topic=circuit-breaker&read): timeouts, the circuit breaker, bulkheads and fallbacks around a slow dependency.
- [API Gateway](/?topic=api-gateway&read): where the circuit breaker and timeouts usually live.
- [Rate Limiter](/?topic=rate-limiter&read): the other side: refusing too many requests, and sending Retry-After.
- [Distributed Message Queue](/?topic=message-queue&read): retries of queue messages, and dead-letter queues.
- [Notification System](/?topic=notification-system&read): retrying pushes, emails and texts without sending twice.

## Sources

- Marc Brooker, AWS Architecture Blog: [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) (2015)
- Amazon Builders' Library: [Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- Google SRE book: [Handling Overload](https://sre.google/sre-book/handling-overload/) (retry budgets) and [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) (the 64 attempts)
- Envoy docs: [Router filter retries](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter) (fully jittered exponential back-off by default)
- RFC 9110: [Retry-After](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after)

## Why This Matters

Every design that calls another service has to say what happens when the call fails, and "we retry" is never the whole answer. Interviewers follow up: how long do you wait, what if every client retries at once, which errors, how many layers, and what about double charges? Being able to say "full jitter, 3 tries, a 10% retry budget, one layer, an idempotency key, then a dead-letter queue and a pending screen" shows you've thought about your system and the one it depends on, on their worst day together.
