# Scaling WebSockets vs HTTP

> 💡 **TL;DR**: An **HTTP** server answers short, separate requests. Any server can answer any request, so you scale by adding servers and counting **requests a second**. A **WebSocket** is one connection that stays open, so the server can push data the moment it exists. That connection lives on one server, often for hours. So you scale by **connections held**, and each server only knows its own connections. Four things follow. A broadcast must reach every server, through **pub/sub**. Quiet connections need **pings**, or the load balancer cuts them. A restart drops thousands of connections, so clients must **reconnect with jitter**. And new servers start empty. **Socket.IO** is a library with its own protocol on top of WebSocket, which adds rooms and reconnection and brings rules of its own.

## At a glance

| | HTTP request / response | WebSocket |
|---|---|---|
| A connection lasts | one request (or a few, with keep-alive) | minutes to hours |
| Who can answer | any server | only the server holding the connection |
| You size servers by | requests a second | connections held at once |
| Server can send without being asked | no | yes |
| Cost per message | headers on every request (hundreds of bytes) | 2 to 14 bytes of framing |
| Broadcasting to everyone | nothing special: everyone asks the same cache | every server must hear it (pub/sub) |
| Deploying a new version | finish current requests, then stop | thousands of connections drop and come back |
| Load balancer | any algorithm | must pass the upgrade; idle timeout matters |

## What each one is

**HTTP** works as request and response. The app sends `GET /score`, the server answers, and the exchange is done. Servers keep no memory of the app between requests (they're **stateless**), so the load balancer can send each request to any of them.

**Polling** is how you get "live" data over plain HTTP: ask again every few seconds. It's simple and works everywhere, but most answers are "nothing new", and data waits until the next ask.

**Long polling** is a smarter ask: the server holds the request open until there *is* something new (or a timeout, such as 30 s), then answers, and the app asks again at once. Updates arrive almost instantly, but every update costs a fresh request with full headers.

**A WebSocket** starts as an HTTP request with an `Upgrade: websocket` header. The server answers `101 Switching Protocols`, and from then on the same TCP connection carries small **frames** both ways, for as long as both sides keep it open:

```http
GET /live?match=IND-AUS HTTP/1.1
Host: api.scorelive.in
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

The server works out `Sec-WebSocket-Accept` from the key the app sent, which proves it understood the WebSocket request. A frame from the server carrying a small message adds just 2 bytes; bigger messages add up to 10, and frames from the app add 4 more (a mask).

**Server-sent events** (SSE) are a fourth option: one long HTTP response that the server keeps writing events to. Push in one direction only, over plain HTTP.

## Follow one example: a live cricket score app

The topic's simulator: 1,000,000 fans follow a match, and a ball is bowled about every 30 s. The planning numbers are illustrative: an HTTP server handles 5,000 requests a second, a WebSocket server holds 50,000 connections, and a poll's headers are about 700 bytes.

| | Polling every 5 s | Long polling | WebSocket |
|---|---|---|---|
| Requests a second | 1,000,000 ÷ 5 = 200,000 | 1,000,000 ÷ 30 = 33,333 | none, after connecting |
| Connections held | none | 1,000,000 | 1,000,000 |
| Servers | 200,000 ÷ 5,000 = 40 | 1,000,000 ÷ 50,000 = 20 | 20 |
| Average delay before a fan sees the ball | 5 ÷ 2 = 2.5 s | about one round trip | about one round trip |
| Polls with nothing new | 5 of every 6: 83% | none | none |
| Traffic | about 142 MB a second, mostly headers | about 25 MB a second | about 2.1 MB a second |

Where the WebSocket traffic comes from: each ball is 1,000,000 messages of 60 bytes plus 2 bytes of framing, every 30 s. That's 62,000,000 ÷ 30 ≈ 2.1 MB a second.

WebSockets win on delay and traffic. But the 20 servers now hold state, and four problems appear that polling never had.

## Problem 1: a broadcast reaches one server's fans

A ball is bowled, and the Score Service sends it to a WebSocket server. That server writes it to its 50,000 connections, and the other 950,000 fans see nothing. A server only knows its own connections. It worked in testing, with one server.

The fix is **pub/sub** (publish/subscribe): every WebSocket server subscribes to a channel, here `match:IND-AUS`, and the Score Service publishes each ball once. The pub/sub system delivers it to all 20 servers, and each one writes it to its own fans.

```
PUBLISH match:IND-AUS '{"over":"14.4","score":"116/3","ball":"FOUR"}'
→ delivered to 20 subscribed servers → each writes to its 50,000 fans
```

- **Redis Pub/Sub** is the usual start: fast and simple, but fire-and-forget. A server that's disconnected at that moment misses the message for good.
- **Redis Streams, Kafka, or NATS (an open-source messaging system) with its JetStream storage** keep messages, so a server (or an app) that reconnects can catch up from where it left off.

Polling never had this problem: every poll reads the latest score from a shared cache, whichever server answers.

## Problem 2: quiet connections get cut

Load balancers, proxies and mobile networks close connections that carry nothing for a while. An ALB (AWS's Application Load Balancer) closes them after 60 s of silence by default: its **idle timeout**. In a 20-minute innings break with no balls, every connection goes quiet, and all 1,000,000 are cut at about the same moment. Then they all reconnect at once.

The fix is a **heartbeat**: the server sends a tiny ping frame every 30 s, shorter than the shortest idle timeout on the path. The app answers with a pong automatically. For 1,000,000 connections that's 1,000,000 ÷ 30 = 33,333 tiny frames a second: cheap. Pings also find dead connections: one that didn't answer the last ping is closed, freeing its memory.

## Problem 3: a restart drops thousands at once

Deploying a new version means restarting servers. Restarting one WebSocket server drops its 50,000 connections, and those apps reconnect to the other 19. Each reconnect is a TLS handshake (the encryption setup) plus a token check.

| | Reconnects | Per remaining server |
|---|---|---|
| All at once | 50,000 in about 1 s | about 2,632 a second |
| Each app waits a random 0 to 30 s first | about 1,667 a second for 30 s | about 88 a second |

That random wait is **jitter**. Add **exponential backoff** too (wait longer after each failed attempt), so a struggling server isn't hammered. See [Retries: Backoff and Jitter](/?topic=retry-backoff&read).

Better still, **drain** a server before stopping it: stop sending it new connections, ask its apps to reconnect elsewhere over a minute or two, then stop it.

## Problem 4: new servers start empty

An HTTP fleet rebalances itself: every new request can go to the new server. Long-lived connections don't move. Add a 21st server during a match and it only gets fans who connect from now on, while the old 20 stay full. Fixes:

- route new connections to the **least-loaded** server (fewest connections), not round robin;
- give connections a **maximum age** (say an hour, with jitter), after which the app reconnects, so load slowly evens out;
- scale **before** the big match, not during it.

## What limits connections per server

The 50,000 above is a planning number. The real limit depends on:

- **Memory**: each connection has buffers, plus your own per-user state. Multiply by connections.
- **File descriptors**: each connection is an open file to the operating system; raise the limit (`ulimit -n`) well above your target.
- **CPU**: TLS handshakes (worst during reconnect storms), pings, and writing each broadcast to every connection.
- **Slow clients**: a phone on a weak network can't take data as fast as you send it, and its buffer grows. Cap it, and skip or drop old updates for that fan.

Measure it with a load test. The record is far higher: in January 2012, WhatsApp's blog showed one FreeBSD server holding 2,277,845 open connections, with servers written in Erlang, a language built for many small concurrent processes.

## Socket.IO vs plain WebSockets

**Socket.IO** is a popular JavaScript library for real-time apps. It is *not* a WebSocket implementation: it runs its own protocol on top, and its documentation says a plain WebSocket client can't talk to a Socket.IO server, nor a Socket.IO client to a plain WebSocket server. What it adds:

- **rooms** and broadcasting to them;
- **acknowledgements**: send an event and get a reply;
- **automatic reconnection** with exponential backoff;
- a **fallback to HTTP long polling** when a WebSocket can't be opened (strict firewalls and proxies).

What that costs at scale:

- **Sticky sessions** while the long-polling fallback is used: its many separate HTTP requests must all reach the same server. If you allow only the WebSocket transport, you don't need them.
- An **adapter** (Redis, Postgres and others) to broadcast across servers: the same pub/sub idea as above, built in.
- Its own client library in every app, and a protocol that other tools don't speak.

At the scale of messaging apps with billions of users, teams use their own protocols on plain TCP or WebSocket connections, tuned for memory per connection; WhatsApp's servers grew from an XMPP (Extensible Messaging and Presence Protocol) chat server written in Erlang. For most apps, Socket.IO or plain WebSockets with Redis pub/sub are plenty.

## How to choose

- **Updates every few minutes, or a small audience?** Polling. It's stateless, cacheable and boring.
- **Push one way (scores, prices, notifications) over plain HTTP?** Server-sent events.
- **Push both ways, often (chat, games, collaborative editing)?** WebSockets.
- **Need rooms, acks and a fallback for strict networks, in JavaScript?** Socket.IO, with only the WebSocket transport if you can, and its Redis adapter.
- **Whatever you choose for WebSockets**: pub/sub between servers, pings under the idle timeout, reconnect with backoff and jitter, least-connections routing, and a load test to find your real connections per server.

## ⚠️ Critical Mistakes

- **Broadcasting from one server.** Only that server's users get it. Publish to pub/sub that every server subscribes to.
- **No heartbeats.** Quiet connections are cut by the load balancer's idle timeout (60 s on an ALB by default), all at once.
- **Reconnecting immediately.** One restart becomes a storm of handshakes. Add random jitter and backoff.
- **Round-robin routing for long-lived connections.** Servers drift apart in load. Route by fewest connections.
- **Keeping per-user state only in the server's memory.** When that server restarts, it's gone. Keep what matters in Redis or a database, and let apps re-sync.
- **Unbounded send buffers.** One slow phone holds megabytes. Cap and drop.
- **Using Socket.IO's long-polling fallback without sticky sessions.** Requests land on the wrong server and the session breaks.

## Interview Q&As

**Q: Why can any HTTP server answer any request, but not any WebSocket server?**

A: HTTP requests are separate and the servers keep no state between them, so any server can answer. A WebSocket is one long connection that lives on the server it reached; only that server can write to it. So you scale WebSocket servers by connections held, and you need a way for every server to hear messages meant for its users.

**Q: How does a message reach users connected to other servers?**

A: Every server subscribes to a pub/sub channel (Redis Pub/Sub, NATS, Kafka). The sender publishes once, every server receives it, and each writes it to its own matching connections. For one user, keep a registry of which server holds their connection, and send to that server only.

**Q: What happens to WebSockets during a deploy, and how do you make it smooth?**

A: Each restarted server drops all its connections, and those clients reconnect elsewhere. Drain servers first (stop new connections, ask clients to move), make clients wait a random time with exponential backoff before reconnecting, and route new connections to the least-loaded server. Clients should re-sync what they missed, from the latest state or by last message id.

**Q: Why do idle WebSocket connections get closed?**

A: Load balancers and proxies close connections that send nothing for a while; an ALB's default idle timeout is 60 s. Send a ping every 30 s or so, shorter than the shortest timeout on the path. Pings also reveal dead connections, which you can close.

**Q: Polling, long polling, server-sent events or WebSockets?**

A: Polling for rare updates or small audiences: stateless and simple. Long polling when you need quick updates but can't hold WebSockets. Server-sent events for one-way push over plain HTTP. WebSockets for frequent two-way messages. For 1,000,000 fans and a ball every 30 s: polling every 5 s needs 200,000 requests a second and 2.5 s of delay; WebSockets need 1,000,000 held connections and about 2.1 MB a second.

**Q: What does Socket.IO add over WebSockets, and what does it cost?**

A: Rooms, acknowledgements, automatic reconnection and a fallback to HTTP long polling. The costs: it's its own protocol (plain WebSocket clients can't connect), the fallback needs sticky sessions across servers, and broadcasting across servers needs an adapter such as Redis.

## Related topics

- [Chat System](/?topic=chat-system&read): a WebSocket gateway, a session registry and store-then-deliver messages.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): spreading reconnects out.
- [Load Balancer](/?topic=load-balancer&read): round robin vs least connections, and health checks.
- [Redis Basics](/?topic=redis-basics&read): pub/sub and streams.

## Sources

- IETF: [RFC 6455, The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- Socket.IO: [Introduction](https://socket.io/docs/v4/) and [Using multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)
- WhatsApp blog: [1 million is so 2011](https://blog.whatsapp.com/1-million-is-so-2011) (January 2012)
- Elastic Load Balancing: [Connection idle timeout for Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#connection-idle-timeout)

## Why This Matters

"Add WebSockets" is an easy box to draw and a hard one to run. Interviewers follow up with the questions this topic answers: how does a message reach users on other servers, what happens on deploy, why do connections drop at night, and why not just use Socket.IO. Knowing that HTTP scales by requests and WebSockets by connections, and the four problems that come with holding state, is what separates a diagram from a design.
