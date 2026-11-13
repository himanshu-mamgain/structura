import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator is a small Redis: a keyspace of strings, hashes, lists, sets and
// sorted sets with expiry, running the same commands you'd type into redis-cli and
// printing redis-cli's replies. Each use case runs its real command sequence.

// ---------- a tiny Redis ----------

interface Types {
  string: string
  hash: Map<string, string>
  list: string[]
  set: Set<string>
  zset: Map<string, number>
}
type Kind = keyof Types
type Value = { type: Kind; v: Types[Kind] }

type Reply = string | number | null | Reply[]

class MiniRedis {
  private keys = new Map<string, { value: Value; expiresAt?: number }>()
  now = 0 // seconds

  private get(key: string) {
    const e = this.keys.get(key)
    // Lazy expiry: a key past its deadline is deleted the moment anyone touches it.
    if (e?.expiresAt !== undefined && e.expiresAt <= this.now) {
      this.keys.delete(key)
      return undefined
    }
    return e
  }

  /** The value at key, created empty if missing. */
  private of<T extends Kind>(key: string, type: T, create: () => Types[T]): Types[T] {
    const found = this.peek(key, type)
    if (found !== undefined) return found
    const v = create()
    this.keys.set(key, { value: { type, v } })
    return v
  }

  private peek<T extends Kind>(key: string, type: T): Types[T] | undefined {
    const e = this.get(key)
    if (e && e.value.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    return e?.value.v as Types[T] | undefined
  }

  run(cmd: string, ...a: string[]): Reply {
    switch (cmd) {
      case 'SET': {
        const ex = a.indexOf('EX')
        this.keys.set(a[0], { value: { type: 'string', v: a[1] }, expiresAt: ex > 0 ? this.now + Number(a[ex + 1]) : undefined })
        return 'OK'
      }
      case 'GET':
        return this.peek(a[0], 'string') ?? null
      case 'INCR':
      case 'INCRBY': {
        const n = Number(this.peek(a[0], 'string') ?? '0') + (cmd === 'INCR' ? 1 : Number(a[1]))
        const e = this.get(a[0])
        this.keys.set(a[0], { value: { type: 'string', v: String(n) }, expiresAt: e?.expiresAt })
        return n
      }
      case 'EXPIRE': {
        const e = this.get(a[0])
        if (!e) return 0
        e.expiresAt = this.now + Number(a[1])
        return 1
      }
      case 'TTL': {
        const e = this.get(a[0])
        return !e ? -2 : e.expiresAt === undefined ? -1 : Math.ceil(e.expiresAt - this.now)
      }
      case 'HSET': {
        const h = this.of(a[0], 'hash', () => new Map())
        let added = 0
        for (let i = 1; i < a.length; i += 2) {
          if (!h.has(a[i])) added++
          h.set(a[i], a[i + 1])
        }
        return added
      }
      case 'HGETALL': {
        const h = this.peek(a[0], 'hash')
        return h ? [...h.entries()].flat() : []
      }
      case 'HINCRBY': {
        const h = this.of(a[0], 'hash', () => new Map())
        const n = Number(h.get(a[1]) ?? '0') + Number(a[2])
        h.set(a[1], String(n))
        return n
      }
      case 'LPUSH': {
        const l = this.of(a[0], 'list', () => [])
        for (const x of a.slice(1)) l.unshift(x)
        return l.length
      }
      case 'LLEN':
        return this.peek(a[0], 'list')?.length ?? 0
      case 'LRANGE': {
        const l = this.peek(a[0], 'list') ?? []
        const end = Number(a[2]) < 0 ? l.length + Number(a[2]) : Number(a[2])
        return l.slice(Number(a[1]), end + 1)
      }
      case 'LMOVE': {
        // LMOVE source destination RIGHT LEFT: take the oldest job and park it in one atomic step.
        const src = this.peek(a[0], 'list')
        if (!src?.length) return null
        const item = a[2] === 'RIGHT' ? src.pop()! : src.shift()!
        const dst = this.of(a[1], 'list', () => [])
        if (a[3] === 'LEFT') dst.unshift(item)
        else dst.push(item)
        return item
      }
      case 'LREM': {
        const l = this.peek(a[0], 'list')
        if (!l) return 0
        const i = l.indexOf(a[2])
        if (i < 0) return 0
        l.splice(i, 1)
        return 1
      }
      case 'SADD': {
        const s = this.of(a[0], 'set', () => new Set())
        let added = 0
        for (const x of a.slice(1)) if (!s.has(x)) (s.add(x), added++)
        return added
      }
      case 'SCARD':
        return this.peek(a[0], 'set')?.size ?? 0
      case 'SISMEMBER':
        return this.peek(a[0], 'set')?.has(a[1]) ? 1 : 0
      case 'ZADD': {
        const z = this.of(a[0], 'zset', () => new Map())
        let added = 0
        for (let i = 1; i < a.length; i += 2) {
          if (!z.has(a[i + 1])) added++
          z.set(a[i + 1], Number(a[i]))
        }
        return added
      }
      case 'ZINCRBY': {
        const z = this.of(a[0], 'zset', () => new Map())
        const n = (z.get(a[2]) ?? 0) + Number(a[1])
        z.set(a[2], n)
        return String(n)
      }
      case 'ZREVRANGE': {
        const ranked = this.ranked(a[0])
        const out = ranked.slice(Number(a[1]), Number(a[2]) + 1)
        return a[3] === 'WITHSCORES' ? out.flatMap(([m, s]) => [m, String(s)]) : out.map(([m]) => m)
      }
      case 'ZREVRANK': {
        const i = this.ranked(a[0]).findIndex(([m]) => m === a[1])
        return i < 0 ? null : i
      }
      default:
        throw new Error(`ERR unknown command '${cmd}'`)
    }
  }

  /** Highest score first; ties broken by member, as Redis does (reverse lexicographic for ZREVRANGE). */
  private ranked(key: string): [string, number][] {
    const z = this.peek(key, 'zset')
    return z ? [...z.entries()].sort((x, y) => y[1] - x[1] || (y[0] > x[0] ? 1 : -1)) : []
  }

  type(key: string): string {
    return this.get(key)?.value.type ?? 'none'
  }
}

/** A reply the way redis-cli prints it. */
function show(r: Reply): string {
  if (r === null) return '(nil)'
  if (typeof r === 'number') return `(integer) ${r}`
  if (Array.isArray(r)) return r.length ? r.map((x, i) => `${i + 1}) ${show(x)}`).join('\n') : '(empty array)'
  // redis-cli escapes quotes inside a bulk string.
  return r === 'OK' ? 'OK' : `"${r.replace(/"/g, '\\"')}"`
}

/** Splits a command line the way redis-cli does: on spaces, keeping single-quoted strings whole. */
const words = (line: string) => (line.match(/'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^'|'$/g, ''))

// ---------- the use cases ----------

type Then = 'read' | 'wait' | 'race'

interface Step {
  text: string
  type: 'Strings' | 'Hashes' | 'Lists' | 'Sets' | 'Sorted Sets'
  lines: string[]
  /** Who sends it: the app, or the background worker. */
  from?: 'App Server' | 'Email Worker'
}

interface UseCase {
  key: string
  intro: string
  steps: Step[]
  then: Record<Then, (r: MiniRedis) => { text: string; type: Step['type']; lines: string[]; replies?: string[]; from?: Step['from']; expiry?: boolean }>
  bigO: string
}

const JOB = (n: number, to: string) => `{"id":${n},"to":"${to}","template":"welcome"}`

const USE_CASES: Record<string, UseCase> = {
  'Session store (hash + TTL)': {
    key: 'session:9f2c41',
    intro: 'Asha logs in. Instead of a session table in Postgres, the app keeps her session in Redis as a hash: one key, several fields, gone after 30 minutes of nothing.',
    steps: [
      { text: 'Store the session as a hash: a key with field-value pairs, like a small JSON object Redis can update field by field.', type: 'Hashes', lines: ['HSET session:9f2c41 user_id 4107 name Asha cart_items 3'] },
      { text: 'Give it a time to live (TTL). After 1,800 seconds without being renewed, Redis deletes it on its own.', type: 'Hashes', lines: ['EXPIRE session:9f2c41 1800', 'TTL session:9f2c41'] },
      { text: 'On her next request the app reads the whole session in one round trip, and adds an item to her cart without reading it first.', type: 'Hashes', lines: ['HGETALL session:9f2c41', 'HINCRBY session:9f2c41 cart_items 1'] },
    ],
    then: {
      read: () => ({ text: 'Each request renews the 30 minutes, so an active user stays logged in.', type: 'Hashes', lines: ['EXPIRE session:9f2c41 1800', 'TTL session:9f2c41'] }),
      wait: (r) => {
        r.now += 31 * 60
        return { text: 'Asha leaves for 31 minutes. The TTL ran out, so the key is gone: the next request finds no session and sends her to the login page. Nobody had to write a clean-up job.', type: 'Hashes', lines: ['TTL session:9f2c41', 'HGETALL session:9f2c41'], expiry: true }
      },
      race: () => ({ text: 'Two tabs add an item at the same moment. HINCRBY is a single command, and Redis runs commands one at a time, so both count: 4 becomes 6, never 5.', type: 'Hashes', lines: ['HINCRBY session:9f2c41 cart_items 1', 'HINCRBY session:9f2c41 cart_items 1'] }),
    },
    bigO: 'HSET, HINCRBY and EXPIRE are O(1) per field; HGETALL is O(number of fields).',
  },
  'Leaderboard (sorted set)': {
    key: 'leaderboard:2026-11',
    intro: 'A quiz app ranks players by points for the month. A sorted set keeps members ordered by score, so the top 3 is one command, not a SQL ORDER BY over every player.',
    steps: [
      { text: 'Add four players with their scores. Each member appears once; its score decides its place.', type: 'Sorted Sets', lines: ['ZADD leaderboard:2026-11 1520 asha 1385 ben 1610 chen 990 divya'] },
      { text: 'Ben answers a hard question: add 120 points. Redis moves him in the order as part of the same command.', type: 'Sorted Sets', lines: ['ZINCRBY leaderboard:2026-11 120 ben'] },
      { text: 'Read the top 3, highest first, with scores, and Ben\'s rank (counting from 0).', type: 'Sorted Sets', lines: ['ZREVRANGE leaderboard:2026-11 0 2 WITHSCORES', 'ZREVRANK leaderboard:2026-11 ben'] },
    ],
    then: {
      read: () => ({ text: 'Divya, at the bottom, asks for her rank. It costs O(log n) whether there are 4 players or 4 million.', type: 'Sorted Sets', lines: ['ZREVRANK leaderboard:2026-11 divya'] }),
      wait: (r) => {
        r.now += 31 * 60
        return { text: 'Half an hour later nothing has changed: this key has no TTL, so it stays until the month\'s key is replaced. Data without a TTL lives until you delete it, or until Redis runs out of memory.', type: 'Sorted Sets', lines: ['TTL leaderboard:2026-11', 'ZREVRANGE leaderboard:2026-11 0 0 WITHSCORES'] }
      },
      race: () => ({ text: 'Chen and Asha score at the same moment. Each ZINCRBY is atomic, so both scores change correctly and the order is right afterwards.', type: 'Sorted Sets', lines: ['ZINCRBY leaderboard:2026-11 50 chen', 'ZINCRBY leaderboard:2026-11 200 asha', 'ZREVRANGE leaderboard:2026-11 0 1 WITHSCORES'] }),
    },
    bigO: 'ZADD, ZINCRBY and ZREVRANK are O(log n); ZREVRANGE is O(log n + number returned).',
  },
  'Job queue (list)': {
    key: 'jobs:email',
    intro: 'Sign-ups should get a welcome email without making the sign-up request wait. The app pushes a job onto a list; a background worker takes jobs off the other end.',
    steps: [
      { text: 'Three people sign up. Each request pushes a job on the left of the list and returns at once.', type: 'Lists', lines: [`LPUSH jobs:email '${JOB(1, 'asha@example.com')}'`, `LPUSH jobs:email '${JOB(2, 'ben@example.com')}'`, `LPUSH jobs:email '${JOB(3, 'chen@example.com')}'`, 'LLEN jobs:email'] },
      { text: 'The worker takes the oldest job from the right and, in the same atomic step, parks it in a processing list. If the worker crashes, the job isn\'t lost.', type: 'Lists', from: 'Email Worker', lines: ['LMOVE jobs:email jobs:email:processing RIGHT LEFT'] },
      { text: 'The email is sent, so the worker removes the job from the processing list.', type: 'Lists', from: 'Email Worker', lines: [`LREM jobs:email:processing 1 '${JOB(1, 'asha@example.com')}'`, 'LRANGE jobs:email 0 -1'] },
    ],
    then: {
      read: () => ({ text: 'The worker keeps going: next comes job 2, first in, first out.', type: 'Lists', from: 'Email Worker', lines: ['LMOVE jobs:email jobs:email:processing RIGHT LEFT', 'LLEN jobs:email'] }),
      wait: (r) => {
        r.run('LMOVE', 'jobs:email', 'jobs:email:processing', 'RIGHT', 'LEFT') // job 2 taken…
        r.now += 31 * 60 // …and the worker died before finishing it
        return { text: 'A worker took job 2 and crashed before sending it. 31 minutes later a sweeper finds the job still in the processing list and puts it back on the queue. With a plain RPOP, Ben\'s email would simply never have been sent.', type: 'Lists', from: 'Email Worker', lines: ['LRANGE jobs:email:processing 0 -1', 'LMOVE jobs:email:processing jobs:email RIGHT RIGHT', 'LLEN jobs:email'] }
      },
      race: () => ({ text: 'Two workers ask for a job at the same moment. LMOVE is atomic, so each gets a different job; no email goes out twice.', type: 'Lists', from: 'Email Worker', lines: ['LMOVE jobs:email jobs:email:processing RIGHT LEFT', 'LMOVE jobs:email jobs:email:processing RIGHT LEFT', 'LLEN jobs:email'] }),
    },
    bigO: 'LPUSH and LMOVE are O(1); LREM and LRANGE are O(n), fine for short lists.',
  },
  'Unique visitors (set)': {
    key: 'visitors:2026-11-13',
    intro: 'Marketing wants to know how many different people visited today. A set stores each member once, however many times it\'s added.',
    steps: [
      { text: 'Each page view adds the visitor\'s id. Asha visits twice; the second add changes nothing.', type: 'Sets', lines: ['SADD visitors:2026-11-13 asha ben asha chen', 'EXPIRE visitors:2026-11-13 172800'] },
      { text: 'Count them, and check whether Ben came today.', type: 'Sets', lines: ['SCARD visitors:2026-11-13', 'SISMEMBER visitors:2026-11-13 ben'] },
    ],
    then: {
      read: () => ({ text: 'Divya arrives: a new member, so the count goes up by one.', type: 'Sets', lines: ['SADD visitors:2026-11-13 divya', 'SCARD visitors:2026-11-13'] }),
      wait: (r) => {
        r.now += 31 * 60
        return { text: 'Half an hour later the set is still there: it expires after two days, when nobody needs today\'s count any more.', type: 'Sets', lines: ['TTL visitors:2026-11-13', 'SCARD visitors:2026-11-13'] }
      },
      race: () => ({ text: 'Ben opens two pages at the same moment. Both SADDs run, one after the other; the second finds him already there and adds nothing.', type: 'Sets', lines: ['SADD visitors:2026-11-13 ben', 'SADD visitors:2026-11-13 ben', 'SCARD visitors:2026-11-13'] }),
    },
    bigO: 'SADD and SISMEMBER are O(1); SCARD is O(1). For millions of visitors, a HyperLogLog (PFADD, PFCOUNT) counts in 12 KB with about 0.81% error.',
  },
  'Page views (string counter)': {
    key: 'views:article:42',
    intro: 'Every time someone reads article 42, its view count goes up. A string holding a number, with INCR, is the simplest counter there is.',
    steps: [
      { text: 'Three readers open the article. INCR creates the key at 0 if it\'s missing and returns the new value.', type: 'Strings', lines: ['INCR views:article:42', 'INCR views:article:42', 'INCR views:article:42'] },
      { text: 'Read it back: the count is a string Redis knows how to add to.', type: 'Strings', lines: ['GET views:article:42'] },
    ],
    then: {
      read: () => ({ text: 'A batch import adds 100 views in one command.', type: 'Strings', lines: ['INCRBY views:article:42 100', 'GET views:article:42'] }),
      wait: (r) => {
        r.now += 31 * 60
        return { text: 'No TTL: the counter is still there half an hour later, and will be until someone deletes it.', type: 'Strings', lines: ['TTL views:article:42', 'GET views:article:42'] }
      },
      race: (r) => {
        // Two app servers doing read-then-write instead of INCR.
        const a = Number(r.run('GET', 'views:article:42'))
        const b = Number(r.run('GET', 'views:article:42'))
        r.run('SET', 'views:article:42', String(a + 1))
        r.run('SET', 'views:article:42', String(b + 1))
        const lost = r.run('GET', 'views:article:42')
        r.run('SET', 'views:article:42', String(a)) // replay the same moment with INCR
        r.run('INCR', 'views:article:42')
        const right = r.run('INCR', 'views:article:42')
        return {
          text: `Two servers each add a view at the same moment. Done as GET then SET, both read ${a} and both write ${a + 1}: one view is lost. Done with INCR, Redis does the read and write as one step: ${right}.`,
          type: 'Strings',
          lines: [],
          replies: [
            `server A> GET views:article:42 → "${a}"`,
            `server B> GET views:article:42 → "${b}"`,
            `server A> SET views:article:42 ${a + 1}`,
            `server B> SET views:article:42 ${b + 1}`,
            `> GET views:article:42 → ${show(lost)}   ✗ one view lost`,
            `with INCR on both servers → (integer) ${right}   ✓`,
          ],
        }
      },
    },
    bigO: 'INCR, INCRBY and GET are O(1).',
  },
}

const THEN: Record<string, Then> = {
  'Read it back': 'read',
  'Wait 31 minutes': 'wait',
  'Two clients at the same moment': 'race',
}

function execute(r: MiniRedis, lines: string[]): string[] {
  return lines.map((line) => {
    const [cmd, ...args] = words(line)
    let out: string
    try {
      out = show(r.run(cmd, ...args))
    } catch (e) {
      out = `(error) ${(e as Error).message}`
    }
    return `> ${line.length > 92 ? `${line.slice(0, 89)}…` : line}\n${out}`
  })
}

const simulator: Simulator = {
  fields: [
    { id: 'use', label: 'Use case', options: Object.keys(USE_CASES) },
    { id: 'then', label: 'Then', options: Object.keys(THEN) },
  ],
  defaults: { use: 'Session store (hash + TTL)', then: 'Read it back' },
  run({ use, then }) {
    const uc = USE_CASES[use] ?? USE_CASES['Session store (hash + TTL)']
    const t = THEN[then] ?? 'read'
    const r = new MiniRedis()
    const steps: Trace['steps'] = [
      {
        text: `${uc.intro} The App Server talks to Redis over one TCP connection, sending commands in Redis's simple text protocol (RESP).`,
        nodes: ['Users', 'App Server', 'Event Loop'],
        data: `key: ${uc.key}\nfirst command: ${uc.steps[0].lines[0].slice(0, 80)}`,
      },
    ]
    for (const s of uc.steps) {
      steps.push({ text: s.text, nodes: [s.from ?? 'App Server', 'Event Loop', 'Keyspace', s.type], data: execute(r, s.lines).join('\n\n') })
    }
    const last = uc.then[t](r)
    steps.push({
      text: last.text,
      nodes: last.expiry ? ['Expiry', 'Keyspace', 'App Server'] : [last.from ?? 'App Server', 'Event Loop', last.type],
      data: (last.replies ?? execute(r, last.lines)).join(last.replies ? '\n' : '\n\n'),
    })
    steps.push({
      text: `Redis keeps every key in memory and runs one command at a time on a single thread, which is why each command is atomic and most take microseconds. ${uc.bigO}`,
      nodes: ['Event Loop', 'Keyspace', 'Postgres'],
      data: `TYPE ${uc.key} → ${r.type(uc.key)}\nsource of truth for users, orders and content: Postgres\nRedis: fast, in memory, and (by default) allowed to lose recent data`,
    })
    const type = r.type(uc.key)
    return { input: `${use} · ${then.toLowerCase()} → ${type === 'none' ? `${uc.key} expired` : `${uc.key} is a ${type}`}`, steps }
  },
}

const run = (use: string, then = 'Read it back') => ({ use, then })

export const redisBasics: StaticTopic = {
  kind: 'static',
  difficulty: 'Beginner',
  id: 'redis-basics',
  title: 'Redis Basics: Data Types',
  blurb: 'Strings, hashes, lists, sets and sorted sets, with TTLs and atomic commands, by real use case',
  guides: ['the-ultimate-redis-101', 'how-can-redis-be-used', 'why-is-redis-so-fast', 'memcached-vs-redis', 'scale-scaling-job-queue-with-redis-at-slack', 'scale-storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-at-ins'],
  story: {
    title: 'Five problems, five data types',
    dek: 'A small quiz app keeps running into the same kind of problem: Postgres is too slow or too clumsy for one job. Each time, a different Redis data type is the answer.',
    chapters: [
      {
        heading: 'Sessions that clean up after themselves',
        body: `Meghna's quiz app stored login sessions in a Postgres table. Every request read a row, and a nightly job deleted expired sessions, except the nights it failed. The table grew to 40 million rows.

She moved sessions to **Redis**, an in-memory data store. Redis isn't a cache with values you can't look inside: it stores **data types**, and each comes with commands that work on it in place.

A session became a **hash**: one key, \`session:9f2c41\`, holding fields like \`user_id\`, \`name\` and \`cart_items\`. Then one more command: \`EXPIRE session:9f2c41 1800\`. That's a **TTL** (time to live). If 30 minutes pass without the app renewing it, Redis deletes the key by itself. The nightly job was deleted instead.`,
        replay: { label: 'Run the session store', values: run('Session store (hash + TTL)', 'Wait 31 minutes') },
      },
      {
        heading: 'A leaderboard without ORDER BY',
        body: `The monthly leaderboard was a SQL query: sort every player by points, take the top 10. With 2 million players it took a second and a half, and the page showed it on every visit.

A **sorted set** keeps members ordered by a score as you write. \`ZINCRBY leaderboard:2026-11 120 ben\` adds 120 points to Ben and moves him to his new place in the same step. \`ZREVRANGE … 0 9 WITHSCORES\` reads the top 10 in microseconds, and \`ZREVRANK\` tells any player their position, in time that grows with the logarithm of the number of players, not the number itself.`,
        replay: { label: 'Run the leaderboard', values: run('Leaderboard (sorted set)') },
      },
      {
        heading: 'Emails that don\'t slow down sign-up',
        body: `Sign-up sent a welcome email before answering, and the email provider sometimes took 3 seconds. A **list** fixed that. The request does \`LPUSH jobs:email <job>\` and returns at once; a background worker takes jobs from the other end.

The first worker used \`RPOP\`, and one day it crashed halfway through a batch. Those emails were never sent: the jobs had left the queue and existed nowhere else. The fix is \`LMOVE jobs:email jobs:email:processing RIGHT LEFT\`, which takes a job and parks it in a processing list in one atomic step. The worker removes it only after the email is sent, and a sweeper returns jobs that sit there too long.`,
        replay: { label: 'Replay the crashed worker', values: run('Job queue (list)', 'Wait 31 minutes') },
      },
      {
        heading: 'Counting people, not visits',
        body: `"How many different people used the app today?" A **set** stores each member once. \`SADD visitors:2026-11-13 asha\` twice still leaves one Asha, and \`SCARD\` returns the count instantly.

For tens of millions of visitors, even a set gets big. Redis has a **HyperLogLog** for that: \`PFADD\` and \`PFCOUNT\` count unique items in 12 KB, with an error of about 0.81%, which marketing was happy with.`,
        replay: { label: 'Run the visitor count', values: run('Unique visitors (set)', 'Two clients at the same moment') },
      },
      {
        heading: 'The counter that lost views',
        body: `Article view counts came out low. The code read the count, added one and wrote it back: \`GET\`, then \`SET\`. When two servers did that at the same moment, both read 3 and both wrote 4. One view vanished.

\`INCR views:article:42\` does the read and the write as one command. Redis runs commands **one at a time** on a single thread, so nothing can happen in between: every command is atomic. That's also why one slow command, like \`KEYS *\` on a million keys, stalls every other client. Meghna replaced the one \`KEYS\` call she found with \`SCAN\`, which walks the keys a little at a time.

> Redis is fast because it keeps everything in memory and does one thing at a time. Both facts shape how you use it.`,
        replay: { label: 'Replay the lost views', values: run('Page views (string counter)', 'Two clients at the same moment') },
      },
    ],
  },
  takeaways: [
    'Redis is an in-memory store of data types (strings, hashes, lists, sets and sorted sets), each with commands that change it in place.',
    'A TTL makes a key delete itself, which suits sessions, caches and anything temporary.',
    'Redis runs one command at a time, so every command is atomic: INCR, HINCRBY and ZINCRBY never lose updates.',
    'Read-then-write from the app (GET, then SET) is a race; use the single command that does both.',
    'Pick the type by the question: a sorted set for rankings, a list for queues, a set for uniqueness, a hash for objects.',
    'Avoid commands that touch every key (KEYS *) in production; one slow command blocks every client.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'redis', label: 'Redis server' },
      { id: 'types', label: 'Data types' },
    ],
    nodes: [
      { id: 'users', label: 'Users', shape: 'ellipse', color: 'blue', group: null },
      { id: 'app', label: 'App Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'worker', label: 'Email Worker', shape: 'rectangle', color: 'orange', group: null },
      { id: 'loop', label: 'Event Loop', shape: 'rectangle', color: 'violet', group: 'redis' },
      { id: 'keyspace', label: 'Keyspace', shape: 'rectangle', color: 'red', group: 'redis' },
      { id: 'expiry', label: 'Expiry', shape: 'rectangle', color: 'orange', group: 'redis' },
      { id: 'strings', label: 'Strings', shape: 'rectangle', color: 'red', group: 'types' },
      { id: 'hashes', label: 'Hashes', shape: 'rectangle', color: 'red', group: 'types' },
      { id: 'lists', label: 'Lists', shape: 'rectangle', color: 'yellow', group: 'types' },
      { id: 'sets', label: 'Sets', shape: 'rectangle', color: 'red', group: 'types' },
      { id: 'zsets', label: 'Sorted Sets', shape: 'rectangle', color: 'red', group: 'types' },
      { id: 'pg', label: 'Postgres', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'users', to: 'app', label: 'requests', dashed: false },
      { from: 'app', to: 'loop', label: 'commands (RESP)', dashed: false },
      { from: 'worker', to: 'loop', label: 'LMOVE', dashed: false },
      { from: 'loop', to: 'keyspace', label: 'look up key', dashed: false },
      { from: 'keyspace', to: 'strings', label: 'counters', dashed: false },
      { from: 'keyspace', to: 'hashes', label: 'sessions', dashed: false },
      { from: 'keyspace', to: 'lists', label: 'queues', dashed: false },
      { from: 'keyspace', to: 'sets', label: 'unique ids', dashed: false },
      { from: 'keyspace', to: 'zsets', label: 'rankings', dashed: false },
      { from: 'expiry', to: 'keyspace', label: 'delete expired', dashed: true },
      { from: 'loop', to: 'app', label: 'reply', dashed: true },
      { from: 'app', to: 'pg', label: 'source of truth', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'session',
        name: 'session:<id> (hash, TTL 30 min)',
        columns: [
          { name: 'user_id', type: 'string', pk: false, fk: 'users.id', nullable: false, unique: false },
          { name: 'name', type: 'string', pk: false, fk: null, nullable: false, unique: false },
          { name: 'cart_items', type: 'integer string', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'leaderboard',
        name: 'leaderboard:<month> (zset)',
        columns: [
          { name: 'member', type: 'username', pk: true, fk: 'users.id', nullable: false, unique: true },
          { name: 'score', type: 'double', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['ordered by score (skip list)'],
      },
      {
        id: 'users',
        name: 'users (Postgres)',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'users', to: 'session', kind: 'one-to-many', label: 'logged in as' },
      { from: 'users', to: 'leaderboard', kind: 'one-to-many', label: 'ranked in' },
    ],
  },
  explanation: {
    title: 'Redis Basics: Data Types',
    summary:
      'Redis is an in-memory data store. Instead of plain values, it stores data types (strings, hashes, lists, sets and sorted sets) with commands that change them in place, and it runs one command at a time, so each command is atomic. Keys can expire on their own.',
    sections: [
      {
        heading: 'Overview',
        body: 'Redis keeps all its data in memory, which makes reads and writes take microseconds. Every key holds one data type:\n- String: text, a number or bytes. INCR adds to a number.\n- Hash: field-value pairs under one key, like a small object.\n- List: an ordered sequence; push and pop at either end, which makes a queue.\n- Set: unique members, with fast membership checks.\n- Sorted set: unique members ordered by a score, which makes a ranking.\n\nAny key can have a TTL (time to live) after which Redis deletes it. Redis executes commands one at a time on a single thread, so a command never sees another one half done.\n\nThe simulator is a small Redis running in your browser: it executes the real command sequence for each use case and prints redis-cli\'s replies.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Store login sessions that expire after 30 minutes of inactivity.\n- Rank players by monthly points and show anyone\'s position.\n- Queue emails for a background worker without losing jobs if it crashes.\n- Count unique daily visitors and article views.\n\nNon-functional:\n- Each operation in under a millisecond.\n- No lost updates when two servers write at once.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Sessions: 50,000 active × about 200 bytes each ≈ 10 MB.\n- Leaderboard: 2 million players × roughly 100 bytes per sorted-set entry (member, score and skip-list overhead) ≈ 200 MB.\n- Visitors: 1 million ids a day in a set at about 60 bytes each ≈ 60 MB; a HyperLogLog counts the same in 12 KB.\n- Throughput: a single Redis instance commonly handles around 100,000 simple commands a second.',
      },
      {
        heading: 'Step by step',
        body: '1. Users send requests to the App Server.\n2. The App Server sends commands to Redis over a connection; the Event Loop runs them one at a time.\n3. The Event Loop finds the key in the Keyspace and applies the command to its type: Strings, Hashes, Lists, Sets or Sorted Sets.\n4. The Email Worker takes jobs from the Lists with LMOVE.\n5. Expiry deletes keys whose TTL has passed.\n6. The reply goes back to the App Server; durable data such as users and orders stays in Postgres.',
      },
      {
        heading: 'Components',
        body: '- Users: people using the app.\n- App Server: the application; uses Redis for fast, temporary or derived data.\n- Email Worker: a background process that takes jobs from a Redis list.\n- Event Loop: Redis\'s single thread, which reads commands and runs them one after another.\n- Keyspace: the dictionary from every key to its value and optional expiry time.\n- Expiry: deletes expired keys, both when they\'re touched and by sampling in the background.\n- Strings: counters and simple values (INCR, GET, SET with EX).\n- Hashes: objects with fields (HSET, HGETALL, HINCRBY).\n- Lists: queues (LPUSH, LMOVE, LRANGE).\n- Sets: unique members (SADD, SCARD, SISMEMBER).\n- Sorted Sets: rankings (ZADD, ZINCRBY, ZREVRANGE, ZREVRANK).\n- Postgres: the source of truth for anything that must not be lost.',
      },
      {
        heading: 'Key decisions',
        body: '- Data type: choose by the question you\'ll ask. "Top 10?" is a sorted set; "seen before?" is a set; "next job?" is a list; "this user\'s fields?" is a hash.\n- Key names: use colons for structure (session:<id>, leaderboard:2026-11), so keys are easy to find and expire by pattern of use.\n- TTLs: put one on anything temporary; keys without a TTL live until deleted or evicted.\n- Atomic commands over read-modify-write: INCR, HINCRBY, ZINCRBY and LMOVE; for several commands together, MULTI/EXEC or a Lua script.\n- Redis or the database: Redis for speed and temporary data; the database for the record you must keep.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Memory is the limit: set maxmemory and an eviction policy, and watch big keys.\n- Slow commands block everyone: avoid KEYS *, and use SCAN, HSCAN and SSCAN to iterate.\n- By default Redis can lose recent writes on a crash; persistence and replicas are the advanced topic.\n- One instance handles a lot; beyond that, shard with Redis Cluster (see the distributed cache topic).',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why is Redis single-threaded, and why is it still fast?\n- How would you build a leaderboard for 10 million players?\n- How do you make a Redis job queue not lose jobs when a worker crashes?\n- When would you use a hash instead of many string keys?\n- Why is GET-then-SET a bug, and what replaces it?\n- How do expired keys actually get deleted?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Sessions in a hash with a TTL (TypeScript)',
        language: 'typescript',
        source: `import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const THIRTY_MINUTES = 30 * 60

export async function saveSession(id: string, user: { id: number; name: string }) {
  const key = \`session:\${id}\`
  await redis.hSet(key, { user_id: String(user.id), name: user.name, cart_items: '0' })
  await redis.expire(key, THIRTY_MINUTES) // Redis deletes it if nobody renews it
}

export async function readSession(id: string) {
  const key = \`session:\${id}\`
  const session = await redis.hGetAll(key)
  if (!Object.keys(session).length) return null // expired or never existed
  await redis.expire(key, THIRTY_MINUTES) // activity renews it
  return session
}`,
      },
      {
        title: 'A monthly leaderboard (TypeScript)',
        language: 'typescript',
        source: `import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const board = () => \`leaderboard:\${new Date().toISOString().slice(0, 7)}\` // leaderboard:2026-11

export const addPoints = (player: string, points: number) => redis.zIncrBy(board(), points, player)

export async function top(n = 10) {
  // Highest first, with scores: [{ value: 'chen', score: 1610 }, ...]
  return redis.zRangeWithScores(board(), 0, n - 1, { REV: true })
}

export async function rankOf(player: string) {
  const rank = await redis.zRevRank(board(), player) // 0 = first place
  return rank === null ? null : rank + 1
}`,
      },
      {
        title: 'A queue that survives a crashed worker (Python)',
        language: 'python',
        source: `import json
import redis

r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)

def enqueue(to: str) -> None:
    r.lpush("jobs:email", json.dumps({"to": to, "template": "welcome"}))

def work_forever(send) -> None:
    while True:
        # Take the oldest job and park it in one atomic step; wait up to 5 s for one.
        job = r.blmove("jobs:email", "jobs:email:processing", 5, "RIGHT", "LEFT")
        if job is None:
            continue
        send(json.loads(job))
        r.lrem("jobs:email:processing", 1, job)  # only now is it really done`,
      },
      {
        title: 'Trying it in redis-cli (bash)',
        language: 'bash',
        source: `docker run -d --name redis -p 6379:6379 redis:7

docker exec -it redis redis-cli
# > INCR views:article:42
# (integer) 1
# > ZADD leaderboard:2026-11 1520 asha 1385 ben
# (integer) 2
# > ZREVRANGE leaderboard:2026-11 0 -1 WITHSCORES
# 1) "asha"  2) "1520"  3) "ben"  4) "1385"
# > SET otp:4107 593021 EX 300
# OK
# > TTL otp:4107
# (integer) 300`,
      },
    ],
    related: ['Query cache', 'Distributed cache', 'Rate limiter', 'Distributed locking', 'Redis persistence and replication'],
  },
  simulator,
}
