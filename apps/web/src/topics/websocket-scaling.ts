import { shortNumber } from '../learn/numbers'
import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator puts a live cricket score app in front of 100,000 or 1,000,000 fans and
// compares three ways of getting each ball's score to them: polling over HTTP, long
// polling, and WebSockets. It sizes the servers, then breaks things the way production
// does: a broadcast that only reaches one server's fans, an innings break that lets the
// load balancer close idle connections, and a deploy that drops 50,000 connections at once.
// Per-server capacities and header sizes are illustrative planning numbers.

type Transport = 'poll' | 'long' | 'ws'

const UPDATE_EVERY = 30 // seconds between balls, roughly
const POLL_EVERY = 5 // seconds, for plain polling
const LONG_POLL_TIMEOUT = 30 // seconds a long poll waits before answering "nothing new"
const HTTP_RPS_PER_SERVER = 5000 // requests a second one API server handles (illustrative)
const WS_CONNS_PER_SERVER = 50_000 // open connections one WebSocket server holds (illustrative)
const HTTP_OVERHEAD = 700 // bytes of request and response headers per poll (illustrative)
const PAYLOAD = 60 // bytes of JSON for one score update
const WS_FRAME = 2 // bytes a WebSocket frame adds to a small message from the server
const IDLE_TIMEOUT = 60 // seconds: the ALB's default idle timeout
const BREAK = 20 * 60 // a 20-minute innings break with no balls
const PING_EVERY = 30
const JITTER = 30 // seconds over which reconnects are spread

interface Options {
  users: number
  transport: Transport
  pubsub: boolean
  pings: boolean
  jitter: boolean
}

const int = (n: number) => shortNumber(Math.round(n))
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB/s` : `${Math.round(bytes / 1e3)} KB/s`)

function plan(o: Options) {
  const rps = o.transport === 'poll' ? o.users / POLL_EVERY : o.transport === 'long' ? o.users / Math.min(UPDATE_EVERY, LONG_POLL_TIMEOUT) : 0
  const held = o.transport === 'poll' ? 0 : o.users // connections kept open at once
  const byRequests = Math.ceil(rps / HTTP_RPS_PER_SERVER)
  const byConnections = Math.ceil(held / WS_CONNS_PER_SERVER)
  const servers = Math.max(1, byRequests, byConnections)
  const delay = o.transport === 'poll' ? POLL_EVERY / 2 : 0 // average wait before a fan sees a new ball
  const emptyShare = o.transport === 'poll' ? 1 - POLL_EVERY / UPDATE_EVERY : 0
  const bandwidth =
    o.transport === 'poll' ? rps * (HTTP_OVERHEAD + PAYLOAD * (1 - emptyShare)) : o.transport === 'long' ? rps * (HTTP_OVERHEAD + PAYLOAD) : (o.users / UPDATE_EVERY) * (WS_FRAME + PAYLOAD)
  const wsServers = o.transport === 'poll' ? 0 : servers
  const reached = o.transport === 'poll' || o.pubsub ? o.users : Math.round(o.users / wsServers)
  const idleDropped = o.transport === 'ws' && !o.pings ? o.users : 0
  const pingsPerSecond = o.transport === 'ws' && o.pings ? o.users / PING_EVERY : 0
  const perServer = o.transport === 'poll' ? 0 : Math.ceil(o.users / servers)
  const others = Math.max(1, servers - 1)
  const reconnectRate = o.jitter ? perServer / JITTER : perServer // per second, across the other servers
  return { rps, held, byRequests, byConnections, servers, delay, emptyShare, bandwidth, reached, idleDropped, pingsPerSecond, perServer, others, reconnectRate }
}

const TRANSPORTS: Record<string, Transport> = {
  'HTTP polling every 5 s': 'poll',
  'HTTP long polling': 'long',
  WebSocket: 'ws',
}
const USERS: Record<string, number> = { '100,000 fans online': 100_000, '1,000,000 fans online': 1_000_000 }

const simulator: Simulator = {
  fields: [
    { id: 'users', label: 'Fans online', options: Object.keys(USERS) },
    { id: 'transport', label: 'How fans get updates', options: Object.keys(TRANSPORTS) },
    { id: 'pubsub', label: 'Between servers', options: ['Nothing: each server alone', 'Redis pub/sub'] },
    { id: 'pings', label: 'Heartbeats', options: ['None', 'Ping every 30 s'] },
    { id: 'jitter', label: 'After a server restarts', options: ['Clients reconnect at once', 'Reconnect spread over 30 s'] },
  ],
  defaults: { users: '1,000,000 fans online', transport: 'HTTP polling every 5 s', pubsub: 'Nothing: each server alone', pings: 'None', jitter: 'Clients reconnect at once' },
  run(values) {
    const o: Options = {
      users: USERS[values.users] ?? 1_000_000,
      transport: TRANSPORTS[values.transport] ?? 'poll',
      pubsub: values.pubsub.startsWith('Redis'),
      pings: values.pings.startsWith('Ping'),
      jitter: values.jitter.startsWith('Reconnect'),
    }
    const r = plan(o)
    const steps: Trace['steps'] = []
    const servers = o.transport === 'poll' ? 'HTTP API Servers' : 'WebSocket Servers'

    steps.push({
      text: `${int(o.users)} fans follow a match in the app, and a new ball is bowled about every ${UPDATE_EVERY} s. ${
        o.transport === 'poll'
          ? `Each app asks GET /score every ${POLL_EVERY} s, whether anything changed or not.`
          : o.transport === 'long'
            ? `Each app sends GET /score and the server holds the request open until the next ball (or ${LONG_POLL_TIMEOUT} s), then the app asks again.`
            : 'Each app opens one WebSocket: a connection that stays open, so the server can send whenever it wants.'
      }`,
      nodes: ['Fan App', 'Load Balancer'],
      data:
        o.transport === 'ws'
          ? 'GET /live HTTP/1.1\nHost: api.scorelive.in\nUpgrade: websocket\nConnection: Upgrade\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\nSec-WebSocket-Version: 13\n\nHTTP/1.1 101 Switching Protocols\nUpgrade: websocket\nConnection: Upgrade\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='
          : `GET /score?match=IND-AUS HTTP/1.1\nHost: api.scorelive.in\nAuthorization: Bearer eyJhbGciOi…\n\nHTTP/1.1 200 OK\n{"over":"14.3","score":"112/3"}`,
    })

    steps.push({
      text:
        o.transport === 'poll'
          ? `That's ${int(o.users)} ÷ ${POLL_EVERY} = ${int(r.rps)} requests a second. Each is short and independent, so the Load Balancer can send it to any HTTP API Server, and adding servers adds capacity at once. At ${int(HTTP_RPS_PER_SERVER)} requests a second each (an illustrative figure), you need ${r.servers}.`
          : o.transport === 'long'
            ? `Every fan holds an open request, so ${int(r.held)} connections stay open, and each ball triggers ${int(o.users)} answers and ${int(o.users)} new requests: ${int(r.rps)} requests a second. Connections, not requests, set the size: at ${int(WS_CONNS_PER_SERVER)} each, ${r.byConnections} servers.`
            : `The Load Balancer passes the upgrade to one WebSocket Server, and the connection stays on that server until it closes. Scaling is about connections held, not requests: ${int(r.held)} connections at ${int(WS_CONNS_PER_SERVER)} each (an illustrative planning figure) is ${r.servers} servers.`,
      nodes: ['Load Balancer', servers],
      data: [
        o.transport === 'poll' ? `requests:     ${int(r.rps)} a second` : `connections:  ${int(r.held)} open at once`,
        o.transport === 'long' ? `requests:     ${int(r.rps)} a second` : '',
        `servers:      ${r.servers}${o.transport === 'poll' ? ` (by requests: ${int(r.rps)} ÷ ${int(HTTP_RPS_PER_SERVER)})` : ` (by connections: ${int(r.held)} ÷ ${int(WS_CONNS_PER_SERVER)})`}`,
        o.transport === 'poll' ? 'state on each server: none' : `state on each server: ${int(r.perServer)} open connections`,
      ].filter(Boolean).join('\n'),
    })

    steps.push({
      text:
        o.transport === 'poll'
          ? `A ball is bowled. The Scorer App sends it to the Score Service, which writes the latest score to the Score Cache. Fans see it at their next poll: ${r.delay} s later on average. And ${Math.round(r.emptyShare * 100)}% of all polls come back with nothing new, each carrying about ${HTTP_OVERHEAD} bytes of headers.`
          : o.transport === 'long'
            ? 'A ball is bowled. Every held request is answered at once, so fans see it almost immediately. Then every app sends a new request, with fresh headers and authentication, to wait for the next ball.'
            : `A ball is bowled. A WebSocket Server writes it straight to the connections it holds: a ${PAYLOAD}-byte message with ${WS_FRAME} bytes of framing. No request, no headers, no delay.`,
      nodes: o.transport === 'poll' ? ['Scorer App', 'Score Service', 'Score Cache', 'HTTP API Servers'] : ['Scorer App', 'Score Service', servers, 'Fan App'],
      data: [
        `average delay before fans see the ball: ${r.delay ? `${r.delay} s` : 'about one network round trip'}`,
        `traffic: about ${mb(r.bandwidth)}`,
        o.transport === 'poll' ? `empty polls: ${Math.round(r.emptyShare * 100)}%` : '',
      ].filter(Boolean).join('\n'),
    })

    if (o.transport !== 'poll') {
      steps.push({
        text: o.pubsub
          ? `The Score Service publishes each ball once to Redis Pub/Sub on channel match:IND-AUS. Every WebSocket Server subscribes, gets it, and sends it to its own fans. All ${int(o.users)} get it.`
          : `Here is the classic bug. The Score Service sends the ball to one WebSocket Server, and a server only knows its own connections. Only that server's ${int(r.reached)} fans get it; the other ${int(o.users - r.reached)} see nothing. It worked in testing, with one server.`,
        nodes: o.pubsub ? ['Score Service', 'Redis Pub/Sub', 'WebSocket Servers'] : ['Score Service', 'WebSocket Servers'],
        data: o.pubsub
          ? `PUBLISH match:IND-AUS '{"over":"14.4","score":"116/3","ball":"FOUR"}'\n→ received by ${r.servers} of ${r.servers} servers\n→ fans reached: ${int(r.reached)}`
          : `sent to server 1 of ${r.servers}\nfans reached: ${int(r.reached)} of ${int(o.users)}`,
      })
    } else {
      steps.push({
        text: 'Polling needs nothing between servers: every poll reads the latest score from the shared Score Cache, so whichever server answers gives the same reply. That is why stateless HTTP servers are so easy to scale.',
        nodes: ['HTTP API Servers', 'Score Cache'],
        data: `GET match:IND-AUS → {"over":"14.4","score":"116/3"}\n${int(r.rps)} reads a second, all from the cache`,
      })
    }

    if (o.transport === 'ws') {
      steps.push({
        text: o.pings
          ? `Innings break: no balls for ${BREAK / 60} minutes. The Load Balancer closes connections that are silent for ${IDLE_TIMEOUT} s, so each server pings its fans every ${PING_EVERY} s. That costs ${int(r.pingsPerSecond)} tiny frames a second, and every connection stays open.`
          : `Innings break: no balls for ${BREAK / 60} minutes. After ${IDLE_TIMEOUT} s of silence, the Load Balancer closes every connection: all ${int(r.idleDropped)} at about the same moment. Every app reconnects, and the servers face a wave of new handshakes.`,
        nodes: ['Load Balancer', 'WebSocket Servers', 'Fan App'],
        data: o.pings ? `ping every ${PING_EVERY} s < idle timeout ${IDLE_TIMEOUT} s\npings: ${int(r.pingsPerSecond)} a second` : `idle timeout: ${IDLE_TIMEOUT} s (ALB default)\nconnections closed: ${int(r.idleDropped)}`,
      })
    }

    if (o.transport !== 'poll') {
      steps.push({
        text: `A deploy restarts one WebSocket Server. Its ${int(r.perServer)} connections drop, and those apps reconnect to the other ${r.others} servers. ${
          o.jitter
            ? `Each app waits a random time up to ${JITTER} s first, so that's about ${int(r.reconnectRate)} reconnects a second, ${int(r.reconnectRate / r.others)} per server: easy.`
            : `They all reconnect at once: ${int(r.reconnectRate)} new connections, each with a TLS handshake and a token check, in about a second (${int(r.reconnectRate / r.others)} per server). That's a reconnect storm.`
        } Afterwards the restarted server comes back nearly empty: long-lived connections don't rebalance by themselves.`,
        nodes: ['WebSocket Servers', 'Load Balancer', 'Fan App'],
        data: [
          `dropped: ${int(r.perServer)} connections`,
          o.jitter ? `reconnects: about ${int(r.reconnectRate)} a second for ${JITTER} s` : `reconnects: ${int(r.reconnectRate)} in about 1 s`,
          `per remaining server: about ${int(r.reconnectRate / r.others)} a second`,
          'restarted server: refills slowly (route new connections to the least-loaded server)',
        ].join('\n'),
      })
    }

    const issues = [
      o.transport === 'poll' && `${r.delay} s delay and ${Math.round(r.emptyShare * 100)}% empty polls`,
      o.transport !== 'poll' && !o.pubsub && `${int(o.users - r.reached)} fans miss every ball`,
      o.transport === 'ws' && !o.pings && 'every connection dropped in the innings break',
      o.transport !== 'poll' && !o.jitter && 'reconnect storms on every deploy',
    ].filter(Boolean)
    steps.push({
      text: issues.length ? `Result: ${issues.join('; ')}.` : 'Result: every fan sees each ball within a moment, with small messages, steady connections and calm deploys.',
      nodes: ['Fan App'],
      data: [
        `servers:        ${r.servers}`,
        `delay:          ${r.delay ? `${r.delay} s` : '≈ 0'}`,
        `traffic:        ${mb(r.bandwidth)}`,
        `fans reached:   ${int(r.reached)} of ${int(o.users)}`,
      ].join('\n'),
    })

    return {
      input: `${int(o.users)} · ${o.transport === 'poll' ? 'polling' : o.transport === 'long' ? 'long polling' : 'WebSocket'}${o.transport !== 'poll' && o.pubsub ? ' · pub/sub' : ''}${o.transport === 'ws' && o.pings ? ' · pings' : ''}${o.transport !== 'poll' && o.jitter ? ' · jitter' : ''} → ${r.servers} servers, ${mb(r.bandwidth)}${issues.length ? `, ${issues.length} problem${issues.length > 1 ? 's' : ''}` : ''}`,
      steps,
    }
  },
}

export const websocketScaling: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'websocket-scaling',
  title: 'Scaling WebSockets vs HTTP',
  blurb: 'Why a server that keeps connections open scales differently: connections not requests, pub/sub between servers, heartbeats, reconnect storms, and Socket.IO vs plain WebSockets',
  guides: ['shortlong-polling-sse-websocket'],
  takeaways: [
    'HTTP servers handle short, independent requests, so any server can answer and you scale by requests a second.',
    'A WebSocket stays open on one server, so you scale by connections held, and each server only knows its own connections.',
    'To broadcast to everyone, every server must hear the message: publish it once to a pub/sub channel (Redis, NATS, Kafka) that all servers subscribe to.',
    'Send pings more often than the load balancer\'s idle timeout, or quiet connections are cut.',
    'After a restart, spread reconnects with random jitter, and send new connections to the least-loaded server.',
    'Socket.IO is a protocol on top of WebSocket (rooms, acks, fallback to long polling); it needs its own client, sticky sessions for polling, and an adapter to broadcast across servers.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'http', label: 'Request / response' },
      { id: 'realtime', label: 'Real time' },
    ],
    nodes: [
      { id: 'fan', label: 'Fan App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'lb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: null },
      { id: 'http', label: 'HTTP API Servers', shape: 'rectangle', color: 'violet', group: 'http' },
      { id: 'cache', label: 'Score Cache', shape: 'rectangle', color: 'red', group: 'http' },
      { id: 'ws', label: 'WebSocket Servers', shape: 'rectangle', color: 'violet', group: 'realtime' },
      { id: 'pubsub', label: 'Redis Pub/Sub', shape: 'rectangle', color: 'yellow', group: 'realtime' },
      { id: 'scorer', label: 'Scorer App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'score', label: 'Score Service', shape: 'rectangle', color: 'violet', group: null },
    ],
    edges: [
      { from: 'fan', to: 'lb', label: 'HTTPS or wss://', dashed: false },
      { from: 'lb', to: 'http', label: 'GET /score', dashed: false },
      { from: 'lb', to: 'ws', label: 'Upgrade: websocket', dashed: false },
      { from: 'http', to: 'cache', label: 'read latest', dashed: false },
      { from: 'scorer', to: 'score', label: 'ball bowled', dashed: false },
      { from: 'score', to: 'cache', label: 'write latest', dashed: false },
      { from: 'score', to: 'pubsub', label: 'publish match:IND-AUS', dashed: false },
      { from: 'pubsub', to: 'ws', label: 'to every server', dashed: false },
      { from: 'ws', to: 'fan', label: 'push the ball', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Scaling WebSockets vs HTTP',
    summary:
      'An HTTP server answers short, independent requests, so a load balancer can send each one anywhere and you scale by adding servers. A WebSocket server holds long-lived connections: each one stays on the server it reached, carries state, and can be pushed to at any time. That changes everything about scaling: you size by connections, every server must hear broadcasts through pub/sub, quiet connections need heartbeats, and restarts cause reconnect storms.',
    sections: [
      {
        heading: 'Overview',
        body: 'HTTP is request and response: the app asks, the server answers, and the exchange is over. A WebSocket starts as an HTTP request with an Upgrade header; the server answers 101 Switching Protocols, and from then on the same TCP connection carries small messages both ways, for as long as both sides keep it open.\n\nThat makes real-time features simple: a live score, a chat message or a price can be pushed the moment it exists. But the server now holds state (the open connection), and connections live for minutes or hours.\n\nThe simulator follows a live cricket score app with up to 1 million fans, and compares polling, long polling and WebSockets as each problem appears.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Show every fan each ball within a second.\n- Reach every fan, whichever server they are connected to.\n- Survive deploys, server failures and quiet periods without losing fans.\n\nNon-functional:\n- 1 million fans online at a big match.\n- Small messages: about 60 bytes per update.\n- Reconnects spread out, never all at once.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Polling every 5 s: 1 million ÷ 5 = 200k requests a second. At an illustrative 5k a second per server, 40 servers. A ball comes every 30 s, so 5 of every 6 polls (83%) return nothing new, and fans wait 2.5 s on average.\n- Polling traffic: about 700 bytes of headers per poll (illustrative) × 200k = about 140 MB a second, mostly headers.\n- WebSockets: 1 million open connections. At an illustrative 50k per server, 20 servers. Each ball is 1 million messages of 60 bytes plus 2 bytes of framing: about 2.1 MB a second averaged over 30 s.\n- Heartbeats: one ping every 30 s per connection is about 33.3k tiny frames a second.\n- One server restart drops 50k connections. Reconnecting at once: 50k handshakes in about a second across 19 servers, about 2,632 each. Spread over 30 s: about 1,667 a second in all, 88 per server.',
      },
      {
        heading: 'Step by step',
        body: '1. The Fan App connects through the Load Balancer: GET /score for polling, or an Upgrade request for a WebSocket.\n2. Polls go to any of the HTTP API Servers, which read the latest score from the Score Cache.\n3. WebSocket upgrades go to one of the WebSocket Servers, where the connection stays.\n4. The Scorer App sends each ball to the Score Service.\n5. The Score Service writes the latest score to the Score Cache and publishes the ball to Redis Pub/Sub.\n6. Every WebSocket Server is subscribed, gets the ball, and pushes it to its own fans.\n7. Servers ping quiet connections so the Load Balancer doesn\'t close them, and apps reconnect with random jitter when a connection drops.',
      },
      {
        heading: 'Components',
        body: '- Fan App: the phone or web app; polls, or holds one WebSocket and reconnects with backoff and jitter.\n- Load Balancer: passes HTTP requests to any server, and WebSocket upgrades to one server; closes connections idle longer than its idle timeout (60 s by default on an ALB).\n- HTTP API Servers: stateless; answer polls from the Score Cache.\n- Score Cache: the latest score for each match, read by every poll.\n- WebSocket Servers: hold open connections (an illustrative 50k each), subscribe to match channels and push to their fans.\n- Redis Pub/Sub: delivers each published ball to every subscribed server.\n- Scorer App: used by the official scorer to enter each ball.\n- Score Service: records each ball, updates the cache, and publishes it.',
      },
      {
        heading: 'Key decisions',
        body: '- Polling, long polling, server-sent events or WebSockets: polling is simplest and slowest; long polling is near-instant but re-sends headers for every update; server-sent events push one way over plain HTTP; WebSockets push both ways with tiny frames.\n- Pub/sub between servers: Redis Pub/Sub is simple but fire-and-forget (a server that is down misses messages); Redis Streams, NATS or Kafka keep messages for catch-up.\n- Heartbeats: ping more often than the shortest idle timeout on the path (load balancer, proxies, mobile networks).\n- Socket.IO or plain WebSockets: Socket.IO gives rooms, acknowledgements, reconnection and a long-polling fallback, but needs its own client, sticky sessions for the fallback, and an adapter for many servers. Plain WebSockets (the ws library, or the browser\'s WebSocket) are lighter and work with any client.\n- Connection budget per server: decided by memory, file descriptors (each connection is an open file) and the CPU for TLS and fan-out. Measure it with a load test.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Scaling out doesn\'t move existing connections: new servers start empty. Route new connections to the least-loaded server, and give connections a maximum age so they slowly rebalance.\n- Deploys: drain a server (stop new connections, tell clients to reconnect elsewhere) before stopping it, and let clients wait a random time before reconnecting.\n- A server dies: its clients reconnect elsewhere and must catch up on what they missed: send the latest state, or replay from a stream by last message id.\n- Slow clients: a phone on a weak network can\'t keep up; cap each connection\'s send buffer and drop or skip old updates rather than run out of memory.\n- The pub/sub layer is now critical: run it highly available, and watch its fan-out (one message to 20 servers is 20 deliveries).',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can any HTTP server answer any request, but not any WebSocket server?\n- How does a message reach users connected to other servers?\n- What happens to WebSockets when you deploy?\n- Why do quiet WebSocket connections get closed, and how do you stop it?\n- When would you choose polling, server-sent events or WebSockets?\n- What does Socket.IO add, and what does it cost?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A WebSocket server with pings and Redis pub/sub',
        language: 'javascript',
        source: `import { WebSocketServer } from 'ws'
import { createClient } from 'redis'

const wss = new WebSocketServer({ port: 8080 })
const fansByMatch = new Map() // match id → set of sockets on THIS server only

wss.on('connection', (socket, req) => {
  const match = new URL(req.url, 'http://x').searchParams.get('match')
  if (!fansByMatch.has(match)) fansByMatch.set(match, new Set())
  fansByMatch.get(match).add(socket)
  socket.isAlive = true
  socket.on('pong', () => (socket.isAlive = true))
  socket.on('close', () => fansByMatch.get(match)?.delete(socket))
})

// Ping every 30 s: shorter than the load balancer's 60 s idle timeout.
// A socket that didn't answer the last ping is dead: close it.
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue }
    socket.isAlive = false
    socket.ping()
  }
}, 30_000)

// Every server subscribes, so a ball published once reaches every fan.
const sub = createClient({ url: process.env.REDIS_URL })
await sub.connect()
await sub.pSubscribe('match:*', (message, channel) => {
  for (const socket of fansByMatch.get(channel.slice(6)) ?? []) {
    if (socket.bufferedAmount < 64_000) socket.send(message) // skip fans who can't keep up
  }
})`,
        versions: [
          {
            language: 'java',
            source: `import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.RedisPubSubAdapter;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

// Registered at /live with a WebSocketConfigurer.
public class ScoreSocketHandler extends TextWebSocketHandler {
  // match id → sockets on THIS server only
  private final Map<String, Set<WebSocketSession>> fansByMatch = new ConcurrentHashMap<>();

  public ScoreSocketHandler() {
    // Ping every 30 s: shorter than the load balancer's 60 s idle timeout.
    Executors.newSingleThreadScheduledExecutor().scheduleAtFixedRate(() ->
        fansByMatch.values().forEach(set -> set.forEach(s -> {
          try { s.sendMessage(new PingMessage()); } catch (Exception e) { set.remove(s); }
        })), 30, 30, TimeUnit.SECONDS);

    // Every server subscribes, so a ball published once reaches every fan.
    var pubsub = RedisClient.create(System.getenv("REDIS_URL")).connectPubSub();
    pubsub.addListener(new RedisPubSubAdapter<String, String>() {
      @Override public void message(String pattern, String channel, String message) {
        for (WebSocketSession s : fansByMatch.getOrDefault(channel.substring(6), Set.of())) {
          try { s.sendMessage(new TextMessage(message)); } catch (Exception e) { /* closed: removed on close */ }
        }
      }
    });
    pubsub.sync().psubscribe("match:*");
  }

  @Override public void afterConnectionEstablished(WebSocketSession s) {
    String match = s.getUri().getQuery().replace("match=", "");
    fansByMatch.computeIfAbsent(match, k -> ConcurrentHashMap.newKeySet()).add(s);
  }

  @Override public void afterConnectionClosed(WebSocketSession s, CloseStatus status) {
    fansByMatch.values().forEach(set -> set.remove(s));
  }
}`,
          },
        ],
      },
      {
        title: 'Reconnect with backoff and jitter (browser)',
        language: 'javascript',
        source: `// After a drop, wait a random time before reconnecting, longer after each failure,
// so 50,000 fans from one restarted server don't all arrive in the same second.
function connect(match, attempt = 0) {
  const socket = new WebSocket(\`wss://api.scorelive.in/live?match=\${match}\`)
  socket.onopen = () => { attempt = 0 }
  socket.onmessage = (e) => render(JSON.parse(e.data))
  socket.onclose = () => {
    const cap = Math.min(30_000, 1_000 * 2 ** attempt) // 1 s, 2 s, 4 s … up to 30 s
    const wait = Math.random() * cap                  // full jitter
    setTimeout(() => connect(match, attempt + 1), wait)
  }
}

connect('IND-AUS')`,
        versions: [
          {
            language: 'typescript',
            source: `// After a drop, wait a random time before reconnecting, longer after each failure,
// so 50,000 fans from one restarted server don't all arrive in the same second.
function connect(match: string, attempt = 0): void {
  const socket = new WebSocket(\`wss://api.scorelive.in/live?match=\${match}\`)
  socket.onopen = () => { attempt = 0 }
  socket.onmessage = (e: MessageEvent<string>) => render(JSON.parse(e.data))
  socket.onclose = () => {
    const cap = Math.min(30_000, 1_000 * 2 ** attempt) // 1 s, 2 s, 4 s … up to 30 s
    const wait = Math.random() * cap                  // full jitter
    setTimeout(() => connect(match, attempt + 1), wait)
  }
}

declare function render(update: { over: string; score: string }): void
connect('IND-AUS')`,
          },
        ],
      },
    ],
    related: ['Chat system', 'Load balancer', 'Retries: backoff and jitter', 'Redis basics', 'Notification system'],
  },
  simulator,
}
