# Global vs Local Load Balancing

> 💡 **TL;DR**: An app running in two regions makes three routing decisions for every request, at three layers. A **global load balancer** picks the **region**. On AWS that's **Route 53**, which answers the DNS lookup with the closest healthy region, or **Global Accelerator**, which gives the app two fixed anycast IP addresses. An **API gateway** checks the **request** (token, rate limit) and sends it to the right **service**. A **local load balancer**, such as an Application Load Balancer (ALB), picks a healthy **server** in the region. Each layer handles a different failure: the global layer a dead region, the local one a dead server or zone. With DNS, a failover also waits for cached answers to expire, so it is slower than the health checks alone.

## At a glance

| Layer | AWS service | Decides | Works with | Reacts to | Typical time to react |
|---|---|---|---|---|---|
| Global, by DNS | Route 53 | which region | DNS answers | a region failing its health checks | 90 s to notice + up to the TTL (time to live: how long devices cache the answer) |
| Global, by anycast | Global Accelerator | which region | 2 static IP addresses, routing inside AWS | a region failing its health checks | only the time to notice; then new connections move at once |
| Content at the edge | CloudFront | which edge copy of a file | a CDN (content delivery network) | an origin failing | depends on its settings |
| API front door | API Gateway | is this request allowed, and which service | tokens, rate limits, paths | bad or too many requests | at once, per request |
| Local | ALB | which server | HTTP rules, target groups | a server or zone failing its health checks | 60 s with defaults |

(The times assume health checks every 30 s, which is the default.)

## What each layer is

**A region** is one of AWS's areas of data centres, such as Mumbai (`ap-south-1`) or Frankfurt (`eu-central-1`). Each region has several **availability zones** (AZs): separate data centres a few kilometres apart, with their own power and network. Running in two zones protects you from one building failing; running in two regions protects you from a whole region failing, and puts the app closer to users far away.

**A load balancer** spreads requests across several places that can serve them, and stops sending to the ones that fail. The question is *what* it chooses between.

**A local load balancer** chooses between servers. AWS's **ALB** (Application Load Balancer) works with HTTP: it reads the path and headers, matches rules such as "`/api/orders/*` goes to the orders target group", and picks a healthy server (a **target**) in any of the region's zones. Its sibling, the **NLB** (Network Load Balancer), works at the level of TCP and UDP connections, for raw speed and fixed IP addresses. See [AWS Application Load Balancer](/?topic=aws-alb&read).

**A global load balancer** chooses between regions. A user in Delhi should reach Mumbai; a user in London, Frankfurt. And if Mumbai fails, Delhi's users should reach Frankfurt instead. Without one, you either run in a single region or ask users to pick a server themselves.

**An API gateway** isn't really a load balancer. It's the front door for an API: it checks the caller's token, applies rate limits and API keys, and routes each path to a service. On AWS it's **API Gateway**. See [API Gateway](/?topic=api-gateway&read).

## Route 53: balancing with DNS answers

**DNS** turns a name such as `api.shopkart.in` into an IP address. **Route 53** is AWS's DNS service, and it can give different answers to different users. You create one record per region, all with the same name, and choose a **routing policy**:

| Policy | Answers with | Use it for |
|---|---|---|
| Latency | the region with the lowest latency from the user's DNS resolver | the closest region, the usual choice |
| Geolocation | a region chosen by the user's country or continent | data that must stay in a country |
| Weighted | regions in proportions you set, such as 90% and 10% | moving traffic slowly to a new region |
| Failover | the primary, or the standby when the primary is unhealthy | active-passive setups |
| Simple | one fixed answer | one region only |

There are also geoproximity, IP-based and multivalue answer policies.

Each record can have a **health check**. Route 53's health checkers, in many locations, call an address you give (say `https://mumbai.api.shopkart.in/health/deep`) every 30 s, or every 10 s for an extra charge. After 3 failures in a row (by default), the endpoint is unhealthy. Route 53 treats it as healthy while more than 18% of its checkers say so, so one checker with a bad network can't take your region out. Unhealthy records are left out of the answers.

### Why DNS failover is slow

A DNS answer comes with a **TTL** (time to live): how many seconds resolvers and devices may keep it before asking again. Route 53 stops giving out Mumbai's address once Mumbai is unhealthy, but everyone who already has it keeps using it until their copy expires. So a user waits for both:

```
time to notice      = check interval × failure threshold = 30 s × 3 = 90 s
cached answers last = up to the TTL                       = up to 60 s
worst case          = 90 + 60                             = 150 s
```

Copies expire at random points within the TTL, so on average users wait 90 + 60 ÷ 2 = 120 s. With a 300 s TTL, the worst case is 390 s. Some apps and resolvers keep answers longer than the TTL, and you can't control them.

**Alias records** point a name at an AWS resource (a load balancer, an API Gateway domain, CloudFront). They're free to look up and follow the resource's address changes; their TTL is set by the target, not by you.

## Global Accelerator: balancing with anycast

**Anycast** means the same IP address is announced from many places at once. Internet routing then delivers each user's packets to the nearest one. **Global Accelerator** gives your app two static IPv4 addresses, announced from AWS's edge locations around the world:

1. The user's app connects to one of the two addresses. They never change.
2. The packets enter AWS's network at the nearest edge location.
3. AWS routes them over its own network to the nearest healthy **endpoint group** (one per region), and to an endpoint in it (a load balancer, or servers).

When a region becomes unhealthy, Global Accelerator sends new connections to the next region **at once**. The addresses are the same, so there's no cached DNS answer to wait for: failover takes only the time to notice. Connections already open stay pointed at the old endpoint until they time out (340 s for TCP), so apps should reconnect when a call fails.

Two dials control the share of traffic:

- A **traffic dial** per endpoint group (region): 50% means half the traffic that would go to this region is sent to others instead. Useful to drain a region before maintenance.
- A **weight** per endpoint within a group: 128 by default, up to 255; traffic is shared in proportion.

For load-balancer endpoints, Global Accelerator uses the load balancer's own health checks: an ALB counts as healthy if every one of its target groups has at least one healthy target. If no endpoint is healthy anywhere, it sends traffic to all of them rather than none.

When to pay for it instead of Route 53: you need fast failover regardless of DNS caching, fixed IP addresses (customers or firewalls that allow-list IPs), or non-HTTP traffic such as games or voice over UDP.

## API Gateway: checking and routing requests

Behind the global layer, each region has an **API Gateway**. For an HTTP API it:

- checks the caller's **JWT** (JSON Web Token: a signed token saying who the user is);
- applies **throttling**: by default an account may send 10,000 requests a second through API Gateway in each region, with bursts up to 5,000, using a token bucket;
- routes each path to a service; here `/api/orders/*` goes through a **VPC link** (a private connection into the region's own network, its VPC or virtual private cloud) to an internal ALB;
- limits each request: up to 10 MB, and up to 30 s for the service to answer.

So API Gateway decides *whether* a request may go in and *which service* gets it. It doesn't pick between servers; the ALB behind it does. A small app with one service can skip API Gateway and put the ALB straight behind the global layer.

## The ALB: picking a server

Inside the region, the ALB checks each target with `GET /status` every 30 s. A target that fails twice in a row is taken out (2 × 30 = 60 s). That's how a **zone** failure is handled: the region's other zone carries on, and the global layer does nothing. It shouldn't: moving a whole region's users because one zone is down would make things worse.

### Two kinds of health check

| | Region health check (global layer) | Target health check (ALB) |
|---|---|---|
| Asks | can this region take an order? | can this one process serve? |
| Checks | the API and its database: `/health/deep` | the process only: `/status` |
| If it's too deep | (fine) | one slow database takes every task out at once |
| If it's too shallow | a region with a dead database keeps getting users | (fine) |

## Follow one example: Mumbai goes down

A user in Delhi, 1,000 requests a second from Delhi's users, Route 53 latency routing, health checks every 30 s, TTL 60 s. The round trips are illustrative. To compare like with like, the simulator gives Global Accelerator the same 3 checks to notice a dead region, so the only difference is the DNS cache.

| Time | What happens | Delhi's requests |
|---|---|---|
| Before | Route 53 answers Delhi with Mumbai (30 ms away, against 130 ms to Frankfurt) | served by Mumbai |
| 0 s | the Mumbai region stops answering | fail |
| 30, 60, 90 s | three health checks fail in a row | still fail |
| 90 s | Route 53 stops answering with Mumbai | fail until each user's cached answer expires |
| up to 150 s | the last cached answers expire | served by Frankfurt, 130 ms away |

About 1,000 × 120 = **120,000** requests fail on average. With the alternatives:

| Setup | Time users fail | Requests failed |
|---|---|---|
| Route 53, checks every 30 s, TTL 60 s | up to 150 s (120 on average) | 120,000 |
| Route 53, checks every 30 s, TTL 300 s | up to 390 s (240 on average) | 240,000 |
| Route 53, checks every 10 s, TTL 60 s | up to 90 s (60 on average) | 60,000 |
| Global Accelerator, checks every 30 s | 90 s | 90,000 |
| Global Accelerator, checks every 10 s | 30 s | 30,000 |
| One Mumbai zone down (ALB, checks every 30 s) | half the requests for 60 s | 30,000 |

After the failover, Delhi's users are served from Frankfurt: it works, but each round trip is about 100 ms longer. Two things must already be true: Frankfurt has the data (the databases replicate, usually a few seconds behind), and Frankfurt has spare capacity for Mumbai's users.

## How to choose

- **One region?** You need only the local layer: an ALB across two or three zones, behind Route 53 with a simple record.
- **Two or more regions, web and mobile apps?** Route 53 latency routing with health checks, alias records, and 60 s TTLs on anything that moves. Cheap and enough for most.
- **Failover must take seconds, or customers allow-list IP addresses, or the traffic isn't HTTP?** Global Accelerator.
- **Data must stay in a country?** Route 53 geolocation routing, with each region's data kept in place.
- **Many services behind one API, with tokens, API keys and rate limits?** API Gateway in each region, in front of internal ALBs. One service and simple auth? An ALB is enough.
- **Static files?** CloudFront, close to users, whatever you choose for the API.
- **Health checks:** deep for regions, shallow for servers, and every 10 s where a minute matters.

## ⚠️ Critical Mistakes

- **High TTLs on records that move.** A 3,600 s TTL can keep users on a dead region for an hour.
- **A shallow region health check.** `/status` says "process up" while the region's database is down; users keep being sent there.
- **A deep health check on the ALB.** One slow database marks every task unhealthy and the region serves nothing.
- **Making the global layer react to one bad server or zone.** That's the ALB's job; moving whole regions over small failures causes more harm than it fixes.
- **Failing over to a region that can't take the load.** It falls over too. Keep headroom, or scale it up first.
- **Forgetting the data.** A healthy region with an empty or stale database isn't a failover.
- **Calling API Gateway a load balancer.** It checks and routes requests to services; the load balancing between servers happens behind it.
- **Never testing failover.** Switch a region off on purpose, regularly, and measure how long users fail.

## Interview Q&As

**Q: What is the difference between a global load balancer, an API gateway and a local load balancer?**

A: They make different decisions. The global load balancer picks the region (Route 53 with DNS answers, or Global Accelerator with anycast addresses). The API gateway checks each request (tokens, rate limits) and routes it to a service by path. The local load balancer (an ALB) picks a healthy server in the region's zones. A request passes through all three: user, global layer, region, API gateway, ALB, server.

**Q: Why does DNS failover take longer than the health checks?**

A: The health checks only decide when Route 53 stops giving out the dead region's address. Resolvers and devices that already have it keep using it until its TTL runs out. With checks every 30 s, 3 failures and a 60 s TTL, users can fail for up to 90 + 60 = 150 s. Lower TTLs, faster checks, or Global Accelerator (no DNS change at all) shorten it.

**Q: How does Global Accelerator fail over without changing DNS?**

A: Its two IP addresses are anycast: announced from AWS edge locations everywhere, so users always reach the nearest edge. Behind the edge, AWS chooses the region. When a region becomes unhealthy, AWS sends new connections to another region; the users' addresses never change, so there's nothing cached to expire.

**Q: One availability zone fails. What should happen?**

A: The ALB's health checks take that zone's targets out (with defaults, after 2 × 30 = 60 s), and the other zones carry the load. The region is still healthy, so the global layer should do nothing. That's why region health checks should test whether the region can serve, not whether every server is up.

**Q: What must be true before you fail over a region?**

A: The other region has the data (replicated, accepting that asynchronous replication may lose the last seconds of writes), the capacity to take the extra users, and the same configuration and code. And the failover has been tested.

## Related topics

- [Load Balancer](/?topic=load-balancer&read): how a load balancer picks a server, and health checks.
- [AWS Application Load Balancer](/?topic=aws-alb&read): listeners, rules, target groups and the 502, 503 and 504 errors.
- [API Gateway](/?topic=api-gateway&read): tokens, rate limits and routing for many services.
- [Disaster Recovery on AWS](/?topic=aws-disaster-recovery&read): how fast you must come back, and how much data you may lose.
- [CDN](/?topic=cdn&read): serving files from near the user.

## Sources

- Amazon Route 53: [Choosing a routing policy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html), [How Route 53 determines whether a health check is healthy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html), [Values for health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html)
- AWS Global Accelerator: [How it works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html), [Health check options](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups-health-check-options.html)
- Amazon API Gateway: [Quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)
- Elastic Load Balancing: [Health checks for Application Load Balancer target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)

## Why This Matters

"User → Route 53 → API Gateway → ALB → services" is drawn in almost every AWS design, and interviewers ask what each box actually decides. If you can say "Route 53 picks the region from health checks and DNS answers, so failover takes the check time plus the TTL; API Gateway checks tokens and limits and routes by path; the ALB picks a healthy task across zones, and handles a zone failure by itself in about a minute", you show you know which layer to fix when something breaks.
