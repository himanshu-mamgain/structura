# API Gateway: One Front Door, Many Services

> 💡 **TL;DR**: An **API gateway** is the single entry point for your clients. It does the work every request needs: check the **token**, apply the **rate limit**, pick the **route**, maybe serve a **cached** answer, and protect services with **timeouts** and a **circuit breaker**. Do the cheap checks first, retry only safe requests, and keep the gateway thin and stateless, because every request depends on it.

Related: [Rate Limiter](/?topic=rate-limiter&read), [Load Balancer](/?topic=load-balancer&read), [CDN](/?topic=cdn&read), [Role-Based Access Control](/?topic=rbac&read), [Idempotent Payments](/?topic=payment-idempotency&read).

---

## Gateway, reverse proxy and load balancer

| | Load balancer | Reverse proxy | API gateway |
| --- | --- | --- | --- |
| Main job | Spread traffic over copies of one service | Sit in front of servers, hide them, terminate TLS | Be the front door of an API |
| Looks at | IP and port, or the HTTP host and path | HTTP requests | Tokens, API keys, routes, plans |
| Typical extras | Health checks | Caching, compression | Auth, rate limits, routing, retries, circuit breaking |
| Example | AWS ALB (Application Load Balancer), HAProxy | Nginx | Kong, AWS API Gateway, Envoy-based gateways |

They overlap, and one product can do all three. A common set-up is a load balancer in front of several gateway copies.

---

## The life of one request

1. **Request.** The app sends `GET /v1/orders/42` with a bearer token.
2. **Token check.** The gateway verifies the JWT (JSON Web Token: a signed token that says who the caller is) signature with a cached public key, then the `exp` time and the scope. Fail: **401**.
3. **Rate limit.** The user's counter goes up. Over the limit: **429** with `Retry-After`.
4. **Route.** The longest matching path prefix gives the service, its timeout and its retry rule.
5. **Cache.** For a safe GET, a fresh copy is returned at once. A stale copy is kept for step 7.
6. **Circuit breaker.** Closed: call the service. Open: skip the call.
7. **Fallback.** A timeout or an open circuit gives a stale copy (reads) or a clear error: **502**, **503** or **504**.
8. **Log.** Route, status and latency are recorded, whatever the result.

---

## The order of checks matters

| Check | Cost | Failure code |
| --- | --- | --- |
| Token signature and expiry | about 1 ms, no network | 401 |
| Scope (is this user allowed here?) | in memory | 403 |
| Rate limit | one Redis call, about 2 ms | 429 |
| Route match | in memory | 404 |
| Cache | memory or Redis | none (a hit is a success) |
| Upstream call | tens to hundreds of ms | 502 / 503 / 504 |

Put the cheapest, most likely to fail checks first. A flood of bad tokens then costs almost nothing.

---

## Circuit breaker: three states

- **Closed:** normal. Count failures in a row. A success resets the count.
- **Open:** after 5 failures in a row, block every call for 20 seconds. Answer from the fallback in under a millisecond.
- **Half-open:** when the timer ends, let **one** probe through. Success closes the circuit. Failure opens it again for another 20 seconds.

**Why it matters (Little's law).** Connections waiting = requests per second × seconds each waits. If 10,000 requests a second go to a hung service with an 800 ms timeout, 10,000 × 0.8 = **8,000** connections wait at once. Add a retry and it doubles. An open breaker brings this near zero.

```js
const breaker = new CircuitBreaker({ tripAfter: 5, openMs: 20_000 })

async function callOrders(req) {
  try {
    return await breaker.call(() => fetch(url, { signal: AbortSignal.timeout(800) }))
  } catch {
    return fallback(req) // stale copy for reads, a clear error for writes
  }
}
```

---

## How to choose

| Situation | Choice |
| --- | --- |
| One service, one team | A reverse proxy or load balancer is enough |
| Many services, one public API | An API gateway |
| Web and mobile need different response shapes | One gateway per client type (backend for frontend) |
| Services call each other a lot | A service mesh for service-to-service traffic, a gateway only for the edge |
| Third-party developers use your API | A gateway with API keys, plans and a developer portal |

---

## ⚠️ Critical Mistakes

1. **No timeout.** A hung service then holds a connection forever. Always set one, per route.
2. **Retrying POST.** A retry can create a second order or payment. Retry only safe methods, or use an idempotency key.
3. **Retries without a limit.** Three layers that each make 3 tries send up to 3 × 3 × 3 = 27 calls for one request. Retry in one place, once or twice, with a pause.
4. **Business logic in the gateway.** It becomes a bottleneck that every team must change. Keep policy in the gateway and rules in services.
5. **Trusting the gateway only.** Services still decide what a user may do with each record. A gateway check on the route is not enough.
6. **A single gateway copy.** It is on every path. Run three or more, in different zones.
7. **Checking the token with a database call.** Use a signed token and a cached public key, and refresh the key when you see a new `kid`.
8. **A health check that tests everything.** One slow dependency then removes every gateway copy at once.

---

## Interview Q&As

**Q: Why use an API gateway instead of putting auth in each service?**
A: Auth, limits and logging are the same for every service. Done once at the gateway, they stay consistent and services stay small. Services still check what a user may do with their own data.

**Q: How does the gateway check a token without a database call?**
A: The token is a signed JWT. The gateway holds the identity provider's public key and checks the signature and expiry in memory. For a revoked token, keep a short deny list or use short-lived tokens.

**Q: A service starts timing out. What happens?**
A: Each call waits for the timeout, then fails. After 5 failures in a row the circuit opens, so calls fail at once and connections stay free. After 20 seconds one probe tests the service. Reads can use a stale cached copy meanwhile.

**Q: Which requests are safe to retry?**
A: Reads (GET) and anything idempotent. A POST is not, unless it carries an idempotency key the service uses to ignore repeats.

**Q: Is the gateway a single point of failure?**
A: Yes, so it is built to be replaceable. It keeps no state, runs as several copies behind a load balancer in different zones, and gets slow, careful deploys.

**Q: How do you capacity-plan it?**
A: Take peak requests per second and divide by what one copy handles. At 30,000 a second and 8,000 per copy, that is 3.75, so 4 copies, plus 1 spare for failure: 5.

---

## Related topics

- [Rate Limiter](/?topic=rate-limiter&read): the limit check the gateway runs on every request.
- [Circuit Breaker and Resilience Patterns](/?topic=circuit-breaker&read): timeouts, breakers, bulkheads and fallbacks in depth.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): which calls to retry, and how long to wait.
- [Load Balancer](/?topic=load-balancer&read): what sits in front of the gateway copies.
- [Role-Based Access Control](/?topic=rbac&read): what a user may do once the gateway knows who they are.
- [Idempotent Payments](/?topic=payment-idempotency&read): making a retried POST safe.
- [LLM Gateway](/?topic=llm-gateway&read): the same idea for calls to AI models.

## Sources

- Martin Fowler: [CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- Microsoft Azure Architecture Center: [Gateway Offloading pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-offloading) and [Backends for Frontends pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)
- Envoy docs: [Circuit breaking](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking)
- Amazon API Gateway: [Developer Guide](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html)
- RFC 7519: [JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519)

---

## Why This Matters

Every large API has a gateway, whether it is called that or not. The ideas here (cheap checks first, timeouts, circuit breakers, safe retries, stale fallbacks) are also the answer to "what happens when a dependency is down?", which comes up in almost every system design interview.
