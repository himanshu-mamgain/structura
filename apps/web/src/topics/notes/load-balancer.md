# Load Balancer

> 💡 **TL;DR**: One server always runs out of CPU, memory or network at some point, and it can fail. So you run several identical copies of the app, and put a **load balancer** in front: one address that receives every request and passes each to a healthy copy. It picks a copy with an **algorithm** (take turns, fewest connections, or a hash of the client), stops using a copy that fails its **health checks**, and lets you add or remove copies with no downtime. It works best when the copies are **stateless** (they keep nothing about users in their own memory), and the load balancer itself must not be the one thing that can take the site down.

## At a glance

| Question | Answer |
|---|---|
| What it is | One address in front of many app servers; it passes each request to one of them |
| Why | One server has a ceiling and can fail; many copies scale and survive failures |
| Layer 4 | Passes TCP connections on without reading them: very fast, can't see paths or headers |
| Layer 7 | Reads the HTTP request: can route by path, add headers, retry, and decrypt HTTPS once |
| Round robin | Takes turns: fair when requests cost about the same |
| Least connections | Picks the server with the fewest open connections: better when requests vary |
| Hash of the client | The same client always reaches the same server |
| Health checks | `GET /healthz` every 5 s; out after 3 failures (15 s), back after 2 successes |
| Sessions | Kept in a shared store like Redis, so any server can answer any user |
| Its own failure | Two load balancers sharing one address, or a managed cloud load balancer |

## What a load balancer is, and why you need one

An app on one server has a ceiling: at some point its CPU, memory or network is full and requests slow down or fail. You can buy a bigger server (**scaling up**), but that gets expensive fast and it's still one machine that can break.

The better answer is **scaling out**: run many identical copies of the app on several servers. Now something must decide which copy gets each request, notice when a copy dies, and keep sending users only to healthy ones. That's the **load balancer**. Users only ever see one address; behind it you can have 3 servers or 300.

Without one, you'd give users a list of server addresses and hope they spread out, and a dead server would keep getting traffic.

### Layer 4 and layer 7

These names come from the layers of a network model.

- A **layer 4** load balancer works with **TCP** connections (the reliable byte streams under HTTP). It picks a server when the connection opens and passes bytes back and forth without reading them. That makes it very fast (well under a millisecond), but it can't see the URL or headers.
- A **layer 7** load balancer reads each **HTTP** request. It can send `/api/*` to one group of servers and `/images/*` to another, add a header with the user's real address, retry a failed request, and **end TLS**: decrypt HTTPS once at the front, so the servers behind don't have to. It adds a few milliseconds.

Most web apps use layer 7. AWS (Amazon Web Services) calls its version an ALB (Application Load Balancer).

## Follow one request all the way through

A shop runs three copies of its app. Right now App Server 1 has 12 open connections, App Server 2 has 4, and App Server 3 has 9. A customer at IP address 198.51.100.23 sends request number 1000.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The browser looks up `shop.example.com`; DNS returns the load balancers' addresses | Client (Browser) → DNS (round-robin records) |
| 2 | The browser sends `GET /products` to the active load balancer | Load Balancer (active) |
| 3 | The health checker says all three servers are healthy | Health Checker |
| 4 | **Round robin**: 1000 mod 3 = 1, so the second healthy server, App Server 2 | Algorithm (picks a server) |
| 5 | (With **least connections** it would also pick App Server 2: 4 is fewer than 12 and 9) | Algorithm (picks a server) |
| 6 | The load balancer passes the request on, adding `X-Forwarded-For: 198.51.100.23` so the server sees the real client address | Load Balancer (active) → App Server 2 |
| 7 | App Server 2 reads the user's session from Redis, so it doesn't matter which server they reached last time | Session Store (Redis) |
| 8 | The answer goes back through the load balancer to the browser | App Server 2 → Load Balancer (active) → Client (Browser) |
| 9 | The request's time and status are recorded | Metrics & Logs |
| 10 | The standby load balancer hears the active one's heartbeat, and waits | Load Balancer (standby) |

`mod` means "the remainder after dividing": 1000 ÷ 3 is 333 with 1 left over.

## The algorithms

| Algorithm | How it picks | Good when | Weak spot |
|---|---|---|---|
| Round robin | Takes turns: 1, 2, 3, 1, 2, 3… | Requests cost about the same | Doesn't notice a slow server; keeps sending it its share |
| Least connections | The server with the fewest open connections right now | Requests vary a lot (10 ms and 2 s) | Needs to track connections; a brand-new server gets flooded at first |
| Weighted | Bigger servers get a bigger share (weight 2 = twice as much) | Servers of different sizes | You must set the weights |
| Hash of the client | `hash(client IP) mod N`: the same client gets the same server | A server keeps a local cache per user | Uneven if a few clients are huge; adding a server moves most clients |

The last weak spot has a fix. With plain "hash mod N", going from 3 servers to 4 changes the answer for about three quarters of clients. **Consistent hashing** places servers and keys on a ring so that adding one server moves only about a quarter of the keys.

## Health checks: noticing a dead server

The **Health Checker** calls `GET /healthz` on every server every 5 seconds. A server that fails 3 checks in a row is taken out; one that then passes 2 in a row is let back in.

- **How long until a dead server is removed?** 3 failures × 5 seconds = **15 seconds**. Checking every second would cut that to about 3 seconds, but adds load and more false alarms from a single slow reply.
- **A slow server still passes.** If App Server 2 answers `/healthz` but takes 3 seconds for real requests, it stays in. Round robin keeps sending it a third of the traffic. Least connections helps (slow requests pile up as open connections, so it gets fewer new ones), and so does removing a server whose error rate stands out.

A good `/healthz` checks what the server really needs, such as its database connection, but stays fast and cheap.

## Keep servers stateless

If a server keeps a user's session (their login, their cart) in its own memory, the next request must reach that same server. Load balancers can do that, called **sticky sessions**, but it makes load uneven, and the session is lost when that server dies.

Better: keep sessions in a shared store such as **Redis**, an in-memory database. Then every server is interchangeable, any server can answer any request, and losing one loses nothing.

## The numbers, worked out

An example shop at its busiest: 20k requests a second, each taking 50 ms and returning 50 KB.

- **Requests in progress at once** = rate × time = 20k × 0.05 s = **1k**. (This is Little's law: how many things are in a system equals how fast they arrive times how long each stays.)
- **Data going out** = 20k × 50 KB = 1 GB a second = 8 Gbit a second. A single 10 Gbit network link would be 80% full, too little room.
- **Servers needed**: if one server handles 2,500 requests a second, 20k ÷ 2,500 = **8** is the bare minimum. To keep each at about 75% at the peak: 8 ÷ 0.75 = 10.7, so **11 servers**, each at 20k ÷ 11 ≈ 1,818 requests a second (73%).
- **Losing one**: the other 10 take 2k each (80%), still fine. With only 8 servers, losing one would push the rest over their limit.
- **Health-check cost**: 11 servers every 5 seconds ≈ 2 checks a second. Nothing.

## What it costs and where it stops

- **The load balancer can be the single point of failure.** Run two that share one address: the standby takes over when the active one stops sending **heartbeats** (small "I'm alive" messages). Or use a managed cloud load balancer, which runs on many machines for you.
- **It adds a hop**: under a millisecond at layer 4, a few milliseconds at layer 7.
- **Deploys need draining**: before restarting a server, mark it "draining" so it finishes its current requests and gets no new ones.
- **Retries can multiply load**: retry only requests that are safe to repeat, on a different server, with a limit.
- **One region only**: a load balancer spreads traffic inside one place. To share traffic between regions you need DNS or anycast routing in front (see Global Load Balancing).

## How to choose

- **Ordinary web app, similar requests?** Layer 7, round robin, health checks, sessions in Redis.
- **Requests vary a lot in cost?** Least connections.
- **Servers of different sizes?** Weighted.
- **Each server caches per user or per key?** A hash of the client or key, with consistent hashing.
- **Raw speed, non-HTTP traffic, or millions of connections?** Layer 4.
- **On a cloud?** Use its managed load balancer rather than running your own pair.

## ⚠️ Critical Mistakes

- **Keeping sessions in server memory.** Users get logged out when their server dies or traffic shifts. Use a shared session store.
- **A health check that's too shallow** (always says OK) or **too deep** (calls every dependency, so one slow database takes every server out at once).
- **One load balancer, no standby.** It becomes the one thing that takes the site down.
- **Round robin with a slow server.** It keeps getting its full share. Use least connections or remove servers whose errors stand out.
- **Restarting servers without draining.** In-flight requests fail on every deploy.
- **Plain "hash mod N" with servers that come and go.** Most clients move on every change. Use consistent hashing.

## Interview Q&As

**Q: What's the difference between a load balancer, a reverse proxy and an API gateway?**

A: A reverse proxy is any server that receives requests for other servers. A load balancer is a reverse proxy whose job is spreading traffic across copies and avoiding dead ones. An API gateway is a reverse proxy for APIs that adds checks such as tokens, rate limits and routing to different services. One product often does all three.

**Q: How do you stop the load balancer from being a single point of failure?**

A: Run two that share one address; the standby takes the address when the active one's heartbeats stop. Or use a managed cloud load balancer, which runs on many machines. DNS can also return several load-balancer addresses.

**Q: One server is up but very slow. What happens with round robin, and what would you change?**

A: Round robin keeps sending it a third of requests, so a third of users get slow answers. Least connections sends it less, because its slow requests stay open longer. Also watch per-server error rates and response times, and take out a server that stands out.

**Q: How do you ship a new version with no downtime?**

A: Replace servers a few at a time. Drain each one first (no new requests, let current ones finish), update it, wait until it passes its health checks, then move on. Keep servers stateless so users don't notice which one they reach.

**Q: When would you choose layer 4 over layer 7?**

A: When you need the lowest delay, have non-HTTP traffic (a database, a game protocol), or hold very many long connections. Choose layer 7 when you need to route by path or header, end TLS once, or retry requests.

## Related topics

- [Global Load Balancing](/?topic=global-load-balancing&read): choosing a region before choosing a server.
- [AWS Application Load Balancer](/?topic=aws-alb&read): a managed layer 7 load balancer in practice.
- [Consistent Hashing](/?topic=consistent-hashing&read): adding a server without moving most clients.
- [API Gateway](/?topic=api-gateway&read): the reverse proxy that also checks tokens and limits.
- [Redis Basics](/?topic=redis-basics&read): where the sessions live.

## Sources

- AWS: [What is an Application Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) and [Health checks for target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- NGINX: [HTTP load balancing](https://nginx.org/en/docs/http/load_balancing.html)
- System Design Primer: [Load balancer](https://github.com/donnemartin/system-design-primer#load-balancer)

## Why This Matters

Almost every design you draw starts with "a load balancer in front of the app servers". Interviewers then ask what happens when a server dies, when one is slow, when the load balancer itself dies, and where the sessions live. Knowing the algorithms, the health-check timings and why servers should be stateless turns that one box into a confident answer.
