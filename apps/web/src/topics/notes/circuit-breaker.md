# Circuit Breaker and Resilience Patterns

> 💡 **TL;DR**: A slow service is more dangerous than a dead one. Each waiting call holds a **thread**, and a server has a fixed number of them, so one slow dependency can use them all up and take your whole app down. Four small patterns stop this: a **timeout** bounds every wait, **retries with backoff and jitter** ride out short glitches, a **circuit breaker** stops calling a service that keeps failing, and a **bulkhead** gives each dependency its own threads. Pick a **fallback** (such as "pay later") before the outage, not during it.

## At a glance

| | Timeout | Retry | Circuit breaker | Bulkhead |
|---|---|---|---|---|
| Question it answers | How long will I wait? | Was that a glitch? | Is this service worth calling right now? | How much of my app can this service hurt? |
| What it limits | Time per call | Failures you can hide | Calls to a failing service | Threads (or connections) per service |
| Without it | Threads wait for ever | One lost packet is an error | Callers pile onto a service that is down | One slow service starves everything |
| Main risk | Too short: good calls fail | Too eager: a retry storm | Too touchy: opens on one error | Too small: refuses good traffic |
| Example setting | 1 s | 2 retries, 200 ms then 400 ms | Open after 5 failures, for 3 s | 10 threads for payments |

## The problem: one slow service takes everyone down

A shop has 20 threads on its checkout server. Checkout calls the Payment Service. When Payment Service **hangs** (it accepts the call and never answers), each checkout holds one thread for ever.

At 10 orders a second, all 20 threads are stuck after 2 seconds. Now the server cannot do anything: not even show a product page, which doesn't use payments at all. This is a **cascading failure**: trouble in one place spreads to places that were fine.

**Little's law** tells you how bad it gets: threads in use = calls per second × seconds each call takes.

| Situation | Calls a second | Seconds per call | Threads needed |
|---|---|---|---|
| Healthy | 200 | 0.05 | 10 |
| Hanging, with a 1 s timeout | 200 | 1 | 200 |
| Answers after 8 s, no timeout | 200 | 8 | 1,600 |

A server has a few hundred threads at most. So even a 1 s timeout isn't enough at 200 orders a second: you need the other patterns too.

## Timeouts

A timeout is the cheapest protection and the one everything else depends on. A call with no timeout can wait for ever.

- **Set it from data.** Look at a healthy call's 99th percentile (p99, the time that 99 of 100 calls beat) and use a little more. If p99 is 300 ms, a 1 s timeout is generous.
- **Keep inner timeouts shorter than outer ones.** If the shopper's app waits 3 s, Checkout must finish its payment call, retries included, in under 3 s. Otherwise the shopper gives up while you are still working.
- **Set connect and read timeouts separately.** Connecting should take milliseconds. Reading a big answer can take longer.

## Retries, backoff and jitter

Many failures are short: a restarting server, one lost packet. A retry hides them. But retries add load, and they land exactly when the service is weakest.

**Rules for retrying:**

1. Retry only what is safe: reads, and writes that carry an **idempotency key** (a unique id the server uses to spot a repeat). A payment retried without one can charge the shopper twice.
2. Retry only errors that can pass: timeouts, connection errors, 503. Never a 400, because the same bad request fails again.
3. Retry a few times, not for ever. Two or three is normal.
4. Wait between tries, and let the wait **grow**. This is **exponential backoff**: 200 ms, then 400 ms, then 800 ms.
5. Add **jitter**: multiply each wait by a random number between 0 and 1.

Why jitter? Say a service blips and 1k clients fail together. With backoff alone they all retry at exactly 200 ms: 1k calls in one instant, and the service falls over again. With full jitter, the retries spread over the 200 ms: about 1k ÷ 200 = 5 calls per millisecond.

Retries also **multiply** across layers. If a request passes through 3 layers and each tries a call 3 times (1 call and 2 retries), the service at the bottom sees 3 × 3 × 3 = 27 calls for one request. Retry in one layer only, or use a **retry budget**: retries may be at most 10% of normal traffic.

```javascript
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function withRetry(fn, { retries = 2, baseMs = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === retries || err.status === 400) throw err
      await sleep(Math.random() * baseMs * 2 ** attempt) // full jitter: 0..200 ms, then 0..400 ms
    }
  }
}
```

## Circuit breaker: the three states

A **circuit breaker** is named after the switch in a fuse box. It watches calls to one dependency. When too many fail, it "trips" and stops sending calls for a while.

| State | What it does | Moves to the next state when |
|---|---|---|
| **Closed** | Normal. Every call goes through, and failures are counted. | 5 failures in a row (or a failure rate such as 50% over the last 20 calls) → **open** |
| **Open** | Fail fast. Calls are refused in about 1 ms and use the fallback. Nothing reaches the service, so it can recover. | 3 seconds pass → **half-open** |
| **Half-open** | Let **one probe** call through. Other calls still fail fast. | Probe works → **closed**. Probe fails → **open** again |

In the simulator, with 10 orders a second and Payment Service down from 3 s to 7 s, the breaker opens at 3.5 s (5 failures in a row, 100 ms each), tries a probe at 6.5 s, sees it fail, opens again, and finally closes at 9.7 s after a good probe. About 60 calls never left Checkout.

Two details that matter:

- **Count per dependency.** One breaker for Payment, one for Email. A broken email provider must not stop payments.
- **Ask for a minimum number of calls.** One failure at 3 a.m. with 1 call in the window is 100% failures, but it isn't evidence. Require, say, 20 calls before the rate counts.

```javascript
// In use: the breaker returns the fallback instead of calling a failing service.
const payments = new CircuitBreaker(5, 3000)

const result = await payments.call(
  () => paymentApi.charge(order), // the real call
  () => queuePayLater(order),      // the fallback: save it, charge it later
)
```

## Bulkheads: separate pools

A ship's hull is split into watertight compartments (**bulkheads**), so a leak floods one compartment, not the whole ship. In software, give each dependency its own small pool of threads, or its own limit on concurrent calls.

With 10 threads kept for payments and 20 for everything else:

- Healthy payments take 0.05 s, so 10 threads handle 10 ÷ 0.05 = 200 calls a second.
- Hanging payments with a 1 s timeout handle 10 ÷ 1 = 10 calls a second. The rest are refused at once, with no waiting.
- Product pages keep all 20 of their threads. In the simulator, 50 of 50 page requests are served during a payment hang. With one shared pool of 20, 40 of them are blocked.

A bulkhead is not a rate limiter. A rate limiter protects a service from too many requests. A bulkhead protects *you* from one slow dependency.

## Fallbacks: decide before the outage

When the breaker is open or the bulkhead is full, something has to answer. Choose per call:

| Call | Good fallback | Bad fallback |
|---|---|---|
| Product recommendations | An empty list, or the most popular items | An error page |
| Product price | A cached price, marked as possibly old | A made-up price |
| Charging a card | Save the order as `payment_pending` and charge from a queue later | Saying "paid" when it wasn't |
| Sending an email | Put it in a queue | Dropping it quietly |

**Never pretend a write worked.** Tell the shopper plainly: "We have your order and will charge your card shortly."

## Putting them in order

For one call, the checks run in this order:

1. **Bulkhead**: is there a free thread for this dependency? If not, refuse now.
2. **Circuit breaker**: is the dependency healthy enough to call? If not, use the fallback.
3. **Timeout** around each attempt.
4. **Retry** (inside the breaker, so every failed attempt counts), with backoff and jitter.
5. **Fallback** if it all failed.

Run it with 10 orders a second against a hanging Payment Service for 10 seconds and the simulator shows the difference:

| Protection | Orders paid | Failed or stuck | Product pages served |
|---|---|---|---|
| None | 0 | 100 (80 turned away, 20 stuck for ever) | 10 of 50 |
| Timeout + 3 retries | 0 | 100 | 10 of 50 |
| Circuit breaker + bulkhead + fallback | 0 now, 100 later | 0 | 50 of 50 |

Nothing can make a hanging service pay. The difference is that the protected app stays up and keeps every order.

## How to choose

Every call to another service needs a **timeout**. Add the rest by what the call is like:

| The call | Add | Why |
|---|---|---|
| Any network call | A timeout, a little above the slowest normal answer | Without one, a hanging service holds your threads for ever |
| A read, or a write with an idempotency key | Up to 2 retries with backoff and jitter | Most glitches pass in a moment; a retry is safe if it can't do the work twice |
| A write without an idempotency key | No retry | A second try might charge or order twice |
| A dependency that can be slow for minutes | A circuit breaker | Stop calling it, so failures are fast and the service can recover |
| Several dependencies sharing your threads | A bulkhead per dependency | One slow service can only use its own pool |
| Something users can live without for a while | A fallback, chosen in advance | Show a cached price or "pending" instead of an error |

Start small: timeouts everywhere, then a breaker and a bulkhead around the one or two dependencies that have hurt you before. Every extra pattern is another setting to tune and test.

## ⚠️ Critical Mistakes

- **No timeout.** The default in many HTTP clients is "wait for ever" or minutes.
- **Retrying a non-idempotent call.** Charging a card twice is worse than failing once.
- **Retrying without backoff and jitter.** Retries from many clients arrive together and keep the service down.
- **Retrying at every layer.** 3 × 3 × 3 = 27 calls for one request.
- **One breaker for everything.** An unrelated failure opens it, and healthy dependencies are cut off.
- **Opening on a single error.** Use a failure rate with a minimum number of calls.
- **A fallback that lies.** "Order paid" when it isn't makes things worse than an error.
- **Never testing it.** Break the dependency in staging, and check that the breaker opens and pages still load.
- **Ignoring the open breaker.** It is an alarm. Page someone when it trips.

## Interview Q&As

**Q: Why is a slow service worse than one that is down?**

A: A down service refuses calls quickly, so callers fail fast and move on. A slow one accepts the call and keeps the caller waiting. Each waiting call holds a thread, so threads run out. With 200 calls a second and an 8 s answer you need 200 × 8 = 1,600 threads, and the app stops serving everything, even features that don't use that service.

**Q: What are the three states of a circuit breaker?**

A: Closed: calls go through and failures are counted. Open: calls are refused straight away and the fallback is used, so the failing service gets time to recover. Half-open: after a set time, one probe call is let through. If it works, the breaker closes. If it fails, it opens again.

**Q: Why add jitter to retry delays?**

A: Without jitter, every client that failed at the same moment retries at the same moment, so 1k retries arrive together and can knock the service over again. Multiplying each wait by a random number from 0 to 1 spreads them out: about 5 a millisecond instead of 1k at once.

**Q: A customer was charged twice after a retry. What went wrong?**

A: The charge was retried without an idempotency key. The first call probably worked but its answer was lost, so the client retried. Send a unique key with each charge, and have the payment service return the first result when it sees the same key again.

**Q: How is a bulkhead different from a rate limiter?**

A: A rate limiter protects a service from too many requests from its callers. A bulkhead protects the caller: it caps how many threads one dependency can use, so a slow dependency cannot starve the rest of the app.

**Q: How do you choose the timeout, the failure threshold and the open time?**

A: Timeout from the dependency's healthy p99, plus some margin, and always below the caller's own timeout. Failure threshold from normal error rates: high enough that a normal blip doesn't trip it (a failure rate over a minimum number of calls works better than a count). Open time long enough for a restart to finish, usually a few seconds to a minute, with some jitter so servers don't all probe at once.

## Related topics

- [API Gateway](/?topic=api-gateway&read): a gateway usually runs a breaker per upstream service.
- [Rate Limiter](/?topic=rate-limiter&read): the other way to protect a service, and its fail-open and fail-closed choices.
- [Payment Idempotency](/?topic=payment-idempotency&read): why retried charges need a key.
- [Distributed Message Queue](/?topic=message-queue&read): the queue behind "pay later".
- [Metrics & Monitoring](/?topic=metrics-monitoring&read): how to alert when a breaker opens.

## Sources

- Michael Nygard, *Release It!* (Pragmatic Bookshelf): the book that made the circuit breaker and bulkhead patterns well known.
- Martin Fowler: [Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- Microsoft Azure Architecture Center: [Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker), [Bulkhead pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead) and [Retry pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry)
- AWS Architecture Blog: [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- Resilience4j documentation: [CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker)

## Why This Matters

"What happens when a service you call is slow?" is a favourite follow-up in system design interviews, and "add a retry" is the answer that gets you in trouble. A strong answer names the thread-pool arithmetic, then layers the tools: timeout, backoff with jitter on idempotent calls only, a breaker with a fallback, and a bulkhead so the blast radius is one feature. Saying "orders go to a pay-later queue, and product pages keep working" shows you design for the bad day, not the good one.
