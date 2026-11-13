# Application Load Balancer: Listeners, Rules, Target Groups, Health Checks and 502s

> 💡 **TL;DR**: An **Application Load Balancer** gives many servers or containers one HTTPS address. A **listener** (port + protocol) terminates TLS with a certificate from ACM, then checks its **rules** in priority order: host, path, header, method, query or source IP. The first match **forwards** to a **target group**, redirects, or returns a fixed response. Target groups hold instances, IPs (ECS tasks) or Lambdas, and **health checks** decide which get traffic. It runs nodes in every AZ you give it and scales them on its own. Most production pain comes from three places: a broad rule with a low number swallowing everything, health checks that are too deep (or too slow), and keep-alive timeouts that cause **502s**.

Builds on [VPC Networking](/?topic=aws-vpc&read): the ALB lives in the public subnets and forwards into the private ones. Next: [ECS on Fargate](/?topic=aws-ecs-fargate&read) registers its tasks here.

---

## Elastic Load Balancing at a glance

| Type | Layer | Understands | Pick it for |
| --- | --- | --- | --- |
| **Application LB** | 7 (HTTP) | Hosts, paths, headers, cookies; HTTP/2, gRPC, WebSockets | Websites and APIs: almost always |
| **Network LB** | 4 (TCP, UDP, TLS) | Connections, not requests | Static IPs, non-HTTP protocols, millions of connections, lowest latency |
| **Gateway LB** | 3 (IP packets) | Nothing above IP | Sending traffic through firewall appliances |
| Classic LB | 4 and 7 | A little of both | Nothing new: it's the old generation |

---

## Anatomy of an ALB

```text
Shopper ──HTTPS──► Listener :443  (TLS ends here, certificate from ACM, chosen by SNI)
                     │
                     ├─ rule 10   host admin.example.com              → forward: admin targets
                     ├─ rule 20   path /api/* AND header X-Canary: 1  → forward: api-v2 targets
                     ├─ rule 30   path /api/*                          → forward: api targets
                     └─ default                                        → forward: web targets
         Listener :80  → redirect to https://#{host}:443/#{path}?#{query} (301)

Target group "api" (type ip, port 3001, health check GET /status)
   ├── 10.0.3.25  zone a   healthy
   ├── 10.0.4.31  zone b   healthy
   └── 10.0.5.17  zone c   healthy
```

| Piece | What it is | Notes |
| --- | --- | --- |
| Listener | A port and protocol the ALB accepts | Usually 443 (HTTPS) and 80 (redirect only) |
| Rule | Conditions + an action, with a priority | Lowest number first; first full match wins |
| Default action | What happens when no rule matches | Every listener has one |
| Target group | A pool of targets with one health check and algorithm | Can belong to several rules and listeners |
| Target | An instance, an IP (ECS tasks on `awsvpc`) or a Lambda | ECS registers and deregisters tasks for you |
| Health check | A request the ALB sends each target on a timer | Decides who gets new requests |

---

## Rules: conditions and actions

| Condition | Matches | Example |
| --- | --- | --- |
| `host-header` | The `Host` header, wildcards allowed | `admin.example.com`, `*.example.com` |
| `path-pattern` | The path, **case-sensitive**; `*` any characters, `?` one | `/api/*`, `/v?/orders` |
| `http-header` | Any header's value | `X-Canary: 1` |
| `http-request-method` | GET, POST… | Send `GET /reports/*` to read replicas' service |
| `query-string` | Key/value pairs | `?version=2` |
| `source-ip` | The client's address range | Office-only admin paths |

| Action | Does |
| --- | --- |
| `forward` | Sends to one target group, or **weighted** across several (95/5 for a canary) |
| `redirect` | 301/302 to another scheme, host, port or path |
| `fixed-response` | Returns a status and body straight from the ALB (maintenance page, 404 for `/wp-admin`) |
| `authenticate-oidc` / `authenticate-cognito` | Signs users in before forwarding |

**Priority is everything.** In the topic's story, someone added `path /*` at priority 1 for a maintenance banner and forgot it. Every request, including `/api/orders/42`, matched it first and went to the website. Give specific rules low numbers, broad ones high numbers, and let the default action catch the rest. A listener allows 100 rules by default.

---

## What the ALB adds to each request

The target sees the ALB as the client. The real details arrive in headers:

| Header | Holds |
| --- | --- |
| `X-Forwarded-For` | The client's IP (the left-most entry you trust) |
| `X-Forwarded-Proto` | `https` or `http`, as the client connected |
| `X-Forwarded-Port` | The port the client connected to |
| `X-Amzn-Trace-Id` | A request id you can log and follow across services |

```javascript
import express from 'express';

const app = express();
// One proxy (the ALB) in front: req.ip and req.protocol come from X-Forwarded-* headers
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Request-Id', req.get('X-Amzn-Trace-Id') ?? '');
  next();
});
```

---

## TLS and certificates

- Certificates come from **AWS Certificate Manager (ACM)**: free for use on the ALB, validated by DNS, **renewed automatically**.
- One HTTPS listener can hold several certificates; the ALB picks one by **SNI** (the host name the browser asks for).
- A **security policy** sets the allowed TLS versions and ciphers: pick one that requires TLS 1.2 or newer and supports TLS 1.3.
- The ALB terminates TLS; traffic to targets inside your VPC is usually plain HTTP. If you need encryption all the way, give the target group HTTPS.
- Port 80 exists only to **redirect** to HTTPS (301).

---

## Health checks

Defaults for instance and IP targets: `GET /` every **30 s**, **5 s** timeout, healthy after **5** successes, unhealthy after **2** failures, success = HTTP 200.

| Question | Math (defaults) | With interval 10 s, unhealthy 3 |
| --- | --- | --- |
| How long until a dead target stops getting requests? | 2 × 30 s = up to **60 s** | 3 × 10 s = up to **30 s** |
| How long until a fixed target gets traffic again? | 5 × 30 s = **150 s** | 3 × 10 s = **30 s** |
| Requests sent to a dead task at 600 req/s over 3 tasks | 200 req/s × 60 s = **12,000** failed | 200 × 30 = **6,000** |

### Shallow, not deep

```javascript
let ready = false; // flipped on once config is loaded and the database pool is open

// "Can this process serve requests?" Fast, no calls to other services.
app.get('/status', (req, res) => {
  res.status(ready ? 200 : 503).json({ ready });
});
```

If `/status` also checked the database, a slow database would mark **every** task unhealthy at once, and the ALB would have nowhere healthy to send anything. Check dependencies in metrics and alarms, not in the load balancer's health check.

**Fail open**: if every target in a group is unhealthy, the ALB routes to all of them anyway, on the theory that a health check is more likely to be wrong than every server.

---

## Spreading the load

| Setting | Default | What it does |
| --- | --- | --- |
| Algorithm: round robin | yes | Each target in turn: fine when requests cost about the same |
| Algorithm: least outstanding requests | no | Sends to the target with the fewest requests in flight: better when some requests are slow (report exports) |
| Algorithm: weighted random | no | Random, and can steer away from targets that are returning errors |
| Cross-zone load balancing | on (ALB) | Targets get equal shares even if zones have different numbers of them |
| Slow start | off | Ramps traffic to a new target over 30 to 900 s, so its cold cache isn't flooded |
| Deregistration delay | 300 s | How long a leaving target keeps finishing in-flight requests during a deploy |
| Stickiness | off | Pins a client to one target by cookie; makes load uneven, so keep sessions out of servers instead |

---

## 502, 503 and 504: what each one means

| Code | Comes from | Usual cause | Fix |
| --- | --- | --- | --- |
| **502** Bad Gateway | ALB | The target closed the connection or sent a broken response; or a Lambda target errored | Keep-alive timeout below the ALB's; app crashed mid-request |
| **503** Service Unavailable | ALB | The target group has **no registered targets** | Deploy registered nothing, or tasks never started |
| **504** Gateway Timeout | ALB | The target didn't answer within the **idle timeout** (60 s default) | Slow query or call; raise the timeout only if you mean it |
| **460** | ALB | The client closed the connection before the response | Client timeout shorter than your response time |
| 5xx with a **target** status | Your app | The app itself returned the error | Read the app's logs |

The classic 502: Node closes idle keep-alive connections after **5 s** by default; the ALB keeps them for **60 s**. Sometimes the ALB sends a request down a connection Node is just closing, and returns 502. Make the app's timeout **longer** than the ALB's:

```javascript
const server = app.listen(3000);
server.keepAliveTimeout = 65_000; // longer than the ALB's 60 s idle timeout
server.headersTimeout = 66_000;   // must be above keepAliveTimeout
```

Access logs show which side failed: `elb_status_code` and `target_status_code` per request, with `-` for the target when it never answered.

---

## Canary and blue/green with weighted target groups

```hcl
# 95% of /api traffic to the current version, 5% to the new one
resource "aws_lb_listener_rule" "api_canary" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  condition {
    path_pattern { values = ["/api/*"] }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.api_blue.arn
        weight = 95
      }
      target_group {
        arn    = aws_lb_target_group.api_green.arn
        weight = 5
      }
      stickiness {
        enabled  = true
        duration = 600   # a user stays on one version for 10 minutes
      }
    }
  }
}
```

Watch the green group's 5xx rate and latency in CloudWatch, then move the weights to 50/50 and 0/100, or back to 100/0 if anything looks wrong. ECS with CodeDeploy does exactly this for you: see [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read).

---

## Cost and capacity

- An ALB is billed per hour (about $0.0225 in us-east-1) plus **LCUs** (Load Balancer Capacity Units, about $0.008 per LCU-hour). An LCU-hour is the most you use of any one dimension: 25 new connections a second, 3,000 active connections a minute, 1 GB of traffic an hour to EC2 or IP targets, or 1,000 rule evaluations a second (the first 10 rules are free).
- The ALB scales its nodes by itself, in minutes. For a launch or sale with a sudden 10× jump, reserve capacity ahead of time (LCU reservation) instead of hoping it scales fast enough.
- Access logs: 600 req/s × 86,400 s × about 400 bytes ≈ **20.7 GB a day** in S3. Set a lifecycle rule.

---

## Security

- The ALB's security group: 443 (and 80 for the redirect) from `0.0.0.0/0`. The targets' security group: the app port **from the ALB's security group only**.
- Attach **AWS WAF** to block common attacks (SQL injection, bad bots, rate-based rules) before they reach the app.
- `fixed-response` 404 for paths you never serve (`/wp-admin`, `/.env`) keeps scanners off your app.
- `authenticate-oidc` can put a login in front of an internal tool with no code in the tool.
- Internal services use an **internal** ALB (private subnets, no public address).

---

## How to choose

```text
HTTP or gRPC with routing by host, path or header?    → ALB
TCP/UDP, static IPs, client IP preserved, huge scale? → NLB
Many small APIs, auth, quotas, per-request pricing?   → API Gateway (in front of Lambda or an ALB/NLB)
Static files and global caching?                      → CloudFront (in front of S3 or the ALB)
Service-to-service inside the VPC?                    → internal ALB, or ECS Service Connect
```

---

## ⚠️ Critical Mistakes

- A broad rule (`/*`) with a **low priority number** that catches everything below it.
- **Deep health checks** that call the database: one slow dependency marks every target unhealthy at once.
- A health check path that **redirects** (302 to `/login`) or needs auth: the target never becomes healthy.
- Node's **5 s keep-alive** under the ALB's 60 s idle timeout: intermittent 502s.
- Leaving **deregistration delay at 300 s** for an API whose requests take 200 ms: every deploy waits five minutes.
- Targets' security group open to `0.0.0.0/0` instead of only the ALB's security group.
- Trusting **every** `X-Forwarded-For` entry: clients can send their own. Trust only what your proxy added.
- **Sticky sessions** to hide state in servers: uneven load and lost sessions when a target goes.
- An ALB in **one AZ** (you need at least two subnets in different AZs anyway).
- Forgetting the **HTTP → HTTPS redirect**, or serving the app on port 80 too.
- No **access logs**: you can't tell a 502 from the ALB from a 500 from the app.

---

## Interview Q&As

**Q: A request matches two rules. Which one wins, and how do you check?**

A: The one with the lower priority number: rules are evaluated in priority order and the first rule whose conditions all match wins; the default action catches anything left. To check, list the listener's rules sorted by priority, or look at the access log's `matched_rule_priority` field for the request.

**Q: How long can a dead target keep getting traffic, and how would you shorten it?**

A: Up to the unhealthy threshold times the interval: with the defaults, 2 × 30 s = 60 s. Lower the interval and threshold (say 10 s × 3 = 30 s) to detect sooner, at the cost of reacting to short pauses, such as a GC pause. Pair it with client retries for idempotent requests.

**Q: Why does an ALB route to unhealthy targets when they're all unhealthy?**

A: Fail-open. If every target fails, it's more likely the health check is wrong (bad path, a shared dependency down) than every server being dead, so the ALB keeps sending traffic rather than returning errors for all of it.

**Q: When would you choose a Network Load Balancer instead?**

A: For non-HTTP protocols (TCP, UDP, TLS passthrough), when clients need static IP addresses to allow-list, when you need the client's source IP preserved at the target, or for very high connection counts at the lowest latency. NLBs don't route by path or host.

**Q: How do you send 5% of real traffic to a new version?**

A: A forward action with weighted target groups: the current version's group at 95 and the new one's at 5, with stickiness so a user stays on one version. Watch the new group's errors and latency, then shift the weights. A header-based rule (`X-Canary: 1`) is useful to let testers reach it first.

**Q: Deploys cause a burst of 502 errors. What would you look at?**

A: Tasks being stopped before they're deregistered (stop timeout shorter than in-flight work, no SIGTERM handling), keep-alive timeouts on the app shorter than the ALB's idle timeout, new tasks registered before they're ready (health check passes too early), and the access logs to see whether the target returned anything.

**Q: What's the difference between a 502, a 503 and a 504 from an ALB?**

A: 502: the target sent an invalid response or closed the connection. 503: no registered targets in the target group. 504: the target didn't respond within the idle timeout (60 s by default).

**Q: Where does TLS end, and how do certificates renew?**

A: At the ALB's HTTPS listener, using an ACM certificate chosen by SNI. ACM renews DNS-validated certificates automatically. Traffic from the ALB to the targets is usually HTTP inside the VPC, or HTTPS if you configure the target group for it.

---

## Related topics

- [VPC Networking](/?topic=aws-vpc&read): the public subnets the ALB lives in
- [ECS on Fargate](/?topic=aws-ecs-fargate&read): tasks registered as IP targets
- [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read): blue/green deploys through two target groups
- [Load Balancer](/?topic=load-balancer&read): load balancing as a general idea, algorithms and layers
- [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read): where the load balancer enters the story

---

## Sources

- [What is an Application Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [Listener rules](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-update-rules.html)
- [Health checks for target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [Troubleshoot your Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html)
- [Elastic Load Balancing pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [terraform-aws-modules/alb](https://github.com/terraform-aws-modules/terraform-aws-alb) (Apache 2.0)

---

## Why This Matters

✅ "Put a load balancer in front" is in every design answer; knowing listeners, rules, target groups and health checks lets you say what it actually does.

✅ Health check math and fail-open explain real outages, and interviewers love "a dead target got traffic for a minute: why?".

✅ The keep-alive 502 and the forgotten `/*` rule are the two bugs you're most likely to meet in production, and both are one-line fixes once you know them.
