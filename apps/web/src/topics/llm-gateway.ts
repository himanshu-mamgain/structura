import type { Trace } from '@structura/shared'
import { stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator pushes one real sample of 40 requests (a slice of one minute)
// through the gateway: it redacts personal data with the same patterns a
// gateway would use, routes, looks requests up in an exact and a semantic
// cache, applies per-model token limits and fails over between providers.
// The totals are then scaled to the chosen traffic. Prices are illustrative.

type App = 'support' | 'review' | 'summary'
type Model = 'S' | 'L' | 'B'

interface Req {
  app: App
  text: string
  /** What the request is really asking; two requests share it when one answer fits both. */
  intent: string
}

const S = (text: string, intent: string): Req => ({ app: 'support', text, intent })
const R = (text: string): Req => ({ app: 'review', text, intent: text })
const M = (text: string): Req => ({ app: 'summary', text, intent: text })

const SAMPLE: Req[] = [
  S('How do I reset my password?', 'password'),
  R('Review PR #812: add retries to the payment webhook'),
  S('Where is my refund?', 'refund'),
  M('Summarise contract MSA-2291 (34 pages)'),
  S('How do I reset my password?', 'password'),
  S('What are your opening hours?', 'hours'),
  S('How do I cancel my order?', 'cancel-order'),
  R('Review PR #813: migrate the sessions table'),
  S('how do I reset my password', 'password'),
  S('When will I get my refund?', 'refund'),
  S('How do I cancel my subscription?', 'cancel-subscription'),
  M('Summarise incident report INC-4471'),
  S('What are your opening hours?', 'hours'),
  S('Change the delivery address for order 4471 to 22 MG Road, call me on 98450 12345', 'address-4471'),
  S('I forgot my password, how can I reset it?', 'password'),
  R('Review PR #814: fix the N+1 query in the orders API'),
  S('Do you deliver on Sundays?', 'sunday'),
  S('Where is my refund?', 'refund'),
  M('Summarise contract MSA-2291 (34 pages)'),
  S('How do I reset my password?', 'password'),
  S('Change the delivery address for order 5120 to 9 Park Street, email riya@example.com', 'address-5120'),
  S('What are your opening hours?', 'hours'),
  R('Review PR #815: add rate limit headers'),
  S('Do you deliver on Sundays?', 'sunday'),
  S('How do I cancel my order?', 'cancel-order'),
  M('Summarise the Q3 2026 board deck'),
  S('How do I reset my password?', 'password'),
  S('When will I get my refund?', 'refund'),
  R('Review PR #816: upgrade React to 19'),
  S('Is delivery available on Sunday?', 'sunday'),
  S('How do I cancel my subscription?', 'cancel-subscription'),
  M('Summarise RFC-0042: event sourcing for carts'),
  S('What are your opening hours?', 'hours'),
  S('I forgot my password, how can I reset it?', 'password'),
  R('Review PR #817: remove the legacy coupon code'),
  S('Where is my refund?', 'refund'),
  M('Summarise call transcript CALL-8812'),
  S('How do I reset my password?', 'password'),
  S('What time do you open?', 'hours'),
  S('Do you deliver on Sundays?', 'sunday'),
]

/** Answers already in the cache from earlier in the day: the most common phrasing of the top questions. */
const WARM: Req[] = [
  S('How do I reset my password?', 'password'),
  S('Where is my refund?', 'refund'),
  S('What are your opening hours?', 'hours'),
  S('Do you deliver on Sundays?', 'sunday'),
  S('How do I cancel my subscription?', 'cancel-subscription'),
]

const APPS: Record<App, { name: string; input: number; output: number }> = {
  // Input includes the app's system prompt and any retrieved context.
  support: { name: 'Support Bot', input: 850, output: 120 },
  review: { name: 'Code Review', input: 3200, output: 450 },
  summary: { name: 'Doc Summariser', input: 7500, output: 600 },
}

const MODELS: Record<Model, { name: string; inPrice: number; outPrice: number; tpm: number; ms: number }> = {
  // Prices in dollars per million tokens (illustrative); tpm = the provider's tokens-a-minute limit for this account.
  S: { name: 'Small Model (A)', inPrice: 0.15, outPrice: 0.6, tpm: 20_000_000, ms: 350 },
  L: { name: 'Large Model (A)', inPrice: 3, outPrice: 15, tpm: 6_000_000, ms: 900 },
  B: { name: 'Large Model (B)', inPrice: 3.5, outPrice: 17.5, tpm: 6_000_000, ms: 1100 },
}

const EXACT_MS = 15
const SEMANTIC_MS = 60 // embed the prompt, then a nearest-neighbour lookup
const FAILOVER_MS = 200 // the failed attempt before the retry on provider B
const BREAKER_AFTER = 5 // consecutive failures before the breaker opens

// ---------- guardrails: personal data ----------

const PII: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '<EMAIL>'],
  [/\b[6-9]\d{4}\s?\d{5}\b/g, '<PHONE>'], // Indian mobile numbers
]

function redact(text: string): { text: string; found: number } {
  let found = 0
  let out = text
  for (const [re, tag] of PII)
    out = out.replace(re, () => {
      found++
      return tag
    })
  return { text: out, found }
}

// ---------- caches ----------

const normalise = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s#-]/gu, '').replace(/\s+/g, ' ').trim()

const STOP = new Set('a an the i my me you your we do does how can it is are what where when will get receive on to for of in and'.split(' '))
// A toy embedding: synonyms share a concept, and the action words weigh double,
// which is roughly how a real model weighs "cancel" against "order".
const CONCEPTS: Record<string, string> = { forgot: 'forgot', delivery: 'deliver', deliver: 'deliver', sundays: 'sunday', time: 'hours', hours: 'hours', opening: 'open', open: 'open' }
const ACTIONS = new Set(['reset', 'cancel', 'refund', 'deliver', 'change'])

function embed(text: string): Map<string, number> {
  const v = new Map<string, number>()
  for (const w of normalise(text).split(' ')) {
    if (!w || STOP.has(w)) continue
    const c = CONCEPTS[w] ?? w
    v.set(c, (v.get(c) ?? 0) + (ACTIONS.has(c) ? 2 : 1))
  }
  return v
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [k, x] of a) {
    na += x * x
    dot += x * (b.get(k) ?? 0)
  }
  for (const x of b.values()) nb += x * x
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// ---------- running the sample ----------

type CacheMode = 'off' | 'exact' | 'strict' | 'loose'

interface Options {
  perMinute: number
  smallFirst: boolean
  cache: CacheMode
  outage: boolean
  fallback: boolean
}

interface Outcome {
  req: Req
  model: Model | null
  how: 'exact' | 'semantic' | 'model' | 'failover' | 'rejected' | 'failed'
  wrong?: string
  similarity?: number
  redacted?: string
  ms: number
}

const THRESHOLD: Record<'strict' | 'loose', number> = { strict: 0.95, loose: 0.75 }

function simulate(o: Options) {
  // The 40 sample requests stand for 40 / perMinute of a minute, so each model's
  // per-minute token limit is scaled down to the same slice.
  const slice = SAMPLE.length / o.perMinute
  const budget: Record<Model, number> = { S: MODELS.S.tpm * slice, L: MODELS.L.tpm * slice, B: MODELS.B.tpm * slice }
  const used: Record<Model, number> = { S: 0, L: 0, B: 0 }
  const tokens: Record<Model, { input: number; output: number }> = { S: { input: 0, output: 0 }, L: { input: 0, output: 0 }, B: { input: 0, output: 0 } }
  const exact = new Map<string, string>()
  const semantic: { app: App; model: Model; vec: Map<string, number>; text: string; intent: string }[] = []
  const outcomes: Outcome[] = []
  let failures = 0
  const store = (req: Req, model: Model) => {
    exact.set(`${req.app}|${model}|${normalise(req.text)}`, req.intent)
    semantic.push({ app: req.app, model, vec: embed(req.text), text: req.text, intent: req.intent })
  }
  if (o.cache !== 'off') for (const w of WARM) store(w, o.smallFirst ? 'S' : 'L')

  for (const req of SAMPLE) {
    const { text, found } = redact(req.text)
    const model: Model = o.smallFirst && req.app === 'support' ? 'S' : 'L'
    const cacheable = o.cache !== 'off' && found === 0 // never cache answers about one person's data
    const key = `${req.app}|${model}|${normalise(text)}`
    const base = { req, redacted: found ? text : undefined }

    if (cacheable && exact.has(key)) {
      outcomes.push({ ...base, model: null, how: 'exact', ms: EXACT_MS })
      continue
    }
    if (cacheable && (o.cache === 'strict' || o.cache === 'loose')) {
      const vec = embed(text)
      let best: (typeof semantic)[number] | null = null
      let bestSim = 0
      for (const e of semantic) {
        if (e.app !== req.app || e.model !== model) continue
        const sim = cosine(vec, e.vec)
        if (sim > bestSim) {
          bestSim = sim
          best = e
        }
      }
      if (best && bestSim >= THRESHOLD[o.cache]) {
        outcomes.push({ ...base, model: null, how: 'semantic', similarity: bestSim, wrong: best.intent !== req.intent ? best.text : undefined, ms: SEMANTIC_MS })
        continue
      }
    }

    const size = APPS[req.app].input + APPS[req.app].output
    let target: Model | null = model
    let how: Outcome['how'] = 'model'
    let extra = 0

    // Provider A is down: calls fail until the breaker opens, then go straight to B (or fail fast).
    if (o.outage) {
      if (failures < BREAKER_AFTER) {
        failures++
        extra = FAILOVER_MS
      }
      if (o.fallback) {
        target = 'B'
        how = 'failover'
      } else {
        outcomes.push({ ...base, model, how: 'failed', ms: extra })
        continue
      }
    }
    // Token limits: over A's budget, spill to B if allowed, otherwise 429.
    if (used[target] + size > budget[target]) {
      if (o.fallback && target !== 'B' && used.B + size <= budget.B) {
        target = 'B'
        how = 'failover'
      } else {
        outcomes.push({ ...base, model: target, how: 'rejected', ms: 0 })
        continue
      }
    }
    used[target] += size
    tokens[target].input += APPS[req.app].input
    tokens[target].output += APPS[req.app].output
    outcomes.push({ ...base, model: target, how, ms: MODELS[target].ms + extra })
    if (cacheable) store(req, model)
  }

  const cost = (m: Model) => (tokens[m].input * MODELS[m].inPrice + tokens[m].output * MODELS[m].outPrice) / 1e6
  const sampleCost = cost('S') + cost('L') + cost('B')
  const served = outcomes.filter((x) => x.how !== 'rejected' && x.how !== 'failed')
  return {
    outcomes,
    tokens,
    used,
    budget,
    slice,
    perMinuteCost: sampleCost / slice,
    count: (h: Outcome['how']) => outcomes.filter((x) => x.how === h).length,
    wrong: outcomes.filter((x) => x.wrong),
    avgMs: served.reduce((s, x) => s + x.ms, 0) / Math.max(1, served.length),
    served: served.length,
    failuresBeforeOpen: failures,
  }
}


// ---------- the walkthrough ----------

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const clip = (t: string, n = 44) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

const CACHE_OPTIONS: Record<string, CacheMode> = {
  Off: 'off',
  'Exact match': 'exact',
  'Semantic, similarity ≥ 0.95': 'strict',
  'Semantic, similarity ≥ 0.75': 'loose',
}

const simulator: Simulator = {
  fields: [
    { id: 'traffic', label: 'Traffic', options: ['Normal day (1,000 requests a minute)', 'Sale day (6,000 requests a minute)'] },
    { id: 'routing', label: 'Routing', options: ['Large model for everything', 'Small model for support questions'] },
    { id: 'cache', label: 'Response cache', options: Object.keys(CACHE_OPTIONS) },
    { id: 'provider', label: 'Provider A', options: ['Healthy', 'Down (returning 503s)'] },
    { id: 'fallback', label: 'Fallback', options: ['Off', 'Fail over to provider B'] },
  ],
  defaults: { traffic: 'Normal day (1,000 requests a minute)', routing: 'Large model for everything', cache: 'Off', provider: 'Healthy', fallback: 'Off' },
  run(values) {
    const perMinute = values.traffic.startsWith('Sale') ? 6000 : 1000
    const o: Options = {
      perMinute,
      smallFirst: values.routing.startsWith('Small'),
      cache: CACHE_OPTIONS[values.cache] ?? 'off',
      outage: values.provider.startsWith('Down'),
      fallback: values.fallback.startsWith('Fail'),
    }
    const r = simulate(o)
    const scale = perMinute / SAMPLE.length
    const steps: Trace['steps'] = []
    const byApp = (app: App) => SAMPLE.filter((q) => q.app === app).length
    const tokensPerMinute = SAMPLE.reduce((sum, q) => sum + APPS[q.app].input + APPS[q.app].output, 0) * scale

    steps.push({
      text: `In one minute of a ${perMinute === 1000 ? 'normal' : 'sale'} day, ${int(perMinute)} requests reach the Gateway API from three apps. Each app calls one API with its own virtual key; the real provider keys never leave the gateway, and Keys & Budgets checks every team's spend so far. The simulator runs a real sample of 40 of them and scales the totals.`,
      nodes: ['Product Apps', 'Gateway API', 'Keys & Budgets'],
      data: [
        ...(['support', 'review', 'summary'] as App[]).map((a) => `${APPS[a].name.padEnd(15)} ${byApp(a)} of 40   ${int(APPS[a].input)} tokens in, ${APPS[a].output} out`),
        `≈ ${int(tokensPerMinute)} tokens a minute if every request reached a model`,
      ].join('\n'),
    })

    const redacted = r.outcomes.filter((x) => x.redacted)
    steps.push({
      text: `Guardrails scan every prompt for personal data before it leaves the company. ${redacted.length} of the 40 contain a phone number or an email address: they are masked, and these requests are never cached, because the answer belongs to one customer.`,
      nodes: ['Guardrails'],
      data: redacted.map((x) => `before: ${x.req.text}\nafter:  ${x.redacted}`).join('\n\n'),
    })

    const toSmall = o.smallFirst ? byApp('support') : 0
    steps.push({
      text: o.smallFirst
        ? `Which Model? sends support questions to the Small Model, which costs 20 to 25 times less per token and answers FAQ-style questions well, and keeps code reviews and summaries on the Large Model.`
        : 'Which Model? sends everything to the Large Model. Simple, but a password-reset question costs as much per token as reviewing a pull request.',
      nodes: o.smallFirst ? ['Which Model?', 'Small Model (A)', 'Large Model (A)'] : ['Which Model?', 'Large Model (A)'],
      data: [
        `Small Model (A): ${toSmall} requests   ${usd(MODELS.S.inPrice)} / ${usd(MODELS.S.outPrice)} per million tokens in / out`,
        `Large Model (A): ${40 - toSmall} requests   ${usd(MODELS.L.inPrice)} / ${usd(MODELS.L.outPrice)} per million tokens in / out`,
      ].join('\n'),
    })

    if (o.cache !== 'off') {
      const exact = r.count('exact')
      const sem = r.outcomes.filter((x) => x.how === 'semantic')
      const semantic = o.cache !== 'exact'
      steps.push({
        text: `${semantic ? 'The Exact Cache matches the normalised prompt (same app, same model, same words); on a miss, the Semantic Cache embeds the prompt and looks for a stored question that means the same.' : 'The Exact Cache matches the normalised prompt: same app, same model, same words after lower-casing and stripping punctuation.'} It already holds answers to the most common questions from earlier in the day. ${exact + sem.length} of 40 are answered from cache without calling a model${r.wrong.length ? `, but ${r.wrong.length} of those answers are wrong: a loose threshold matched questions that only look alike` : ''}.`,
        nodes: semantic ? ['Exact Cache', 'Semantic Cache'] : ['Exact Cache'],
        data: [
          `exact hits: ${exact}   e.g. "how do I reset my password" = "How do I reset my password?"`,
          ...(semantic ? [`semantic hits: ${sem.length}`] : []),
          ...sem
            .filter((x, i, all) => all.findIndex((y) => y.req.text === x.req.text) === i)
            .slice(0, 5)
            .map((x) => `  ${x.wrong ? '✗' : '✓'} "${clip(x.req.text, 36)}" ≈ ${x.similarity!.toFixed(2)}${x.wrong ? ` → answered as "${clip(x.wrong, 34)}"` : ''}`),
          `key: fnv1a(${'support|' + (o.smallFirst ? 'S' : 'L') + '|how do i reset my password'}) = ${stableHash(`support|${o.smallFirst ? 'S' : 'L'}|how do i reset my password`).toString(16)}`,
        ].join('\n'),
      })
    }

    const toModels = r.outcomes.filter((x) => x.how !== 'exact' && x.how !== 'semantic')
    const limitNodes = ['Token Limiter', o.smallFirst ? 'Small Model (A)' : 'Large Model (A)', 'Large Model (A)', ...(o.fallback ? ['Large Model (B)'] : [])]
    const rejected = r.count('rejected')
    const spilled = o.outage ? 0 : r.count('failover')
    steps.push({
      text: `The Token Limiter keeps each model under the provider's tokens-a-minute limit, counting tokens, not requests, because one summary uses more than eight times the tokens of a support answer. ${rejected ? `This minute needs more than the limit: ${int(rejected * scale)} requests a minute get "429 Too Many Requests"${o.fallback ? ', even after spilling to provider B' : ''}.` : spilled ? `Provider A's limit runs out, so ${int(spilled * scale)} requests a minute spill over to provider B.` : 'Everything fits within the limits.'}`,
      nodes: [...new Set(limitNodes)].slice(0, 4),
      data: (['S', 'L', 'B'] as Model[])
        .filter((m) => m !== 'B' || o.fallback)
        .filter((m) => m !== 'S' || o.smallFirst)
        .map((m) => `${MODELS[m].name.padEnd(16)} limit ${int(MODELS[m].tpm)} a minute, used ${int(r.used[m] * scale)}`)
        .concat(`${toModels.length} of 40 needed a model; ${rejected} rejected with 429`)
        .join('\n'),
    })

    if (o.outage) {
      const fo = r.count('failover')
      steps.push({
        text: o.fallback
          ? `Provider A is returning 503s. The first ${r.failuresBeforeOpen} calls fail and are retried on provider B (about ${FAILOVER_MS} ms lost each). After ${BREAKER_AFTER} failures in a row the circuit breaker opens: Provider Healthy? stops sending to A at all, and tries it again every 30 seconds.`
          : `Provider A is returning 503s and there is nowhere else to go. After ${BREAKER_AFTER} failures in a row the circuit breaker opens, so requests fail fast instead of waiting for timeouts, but they still fail. Only cached answers get through.`,
        nodes: o.fallback ? ['Provider Healthy?', 'Large Model (A)', 'Large Model (B)'] : ['Provider Healthy?', 'Large Model (A)', 'Small Model (A)'],
        data: o.fallback
          ? `failed over to Large Model (B): ${fo} of 40 (${int(fo * scale)} a minute), at ${usd(MODELS.B.inPrice)} / ${usd(MODELS.B.outPrice)} per million tokens\nfailed: ${r.count('failed')}`
          : `failed: ${r.count('failed')} of 40 (${int(r.count('failed') * scale)} requests a minute)\nserved from cache: ${r.count('exact') + r.count('semantic')}`,
      })
    }

    const appCost = (app: App) =>
      r.outcomes
        .filter((x) => x.req.app === app && x.model && (x.how === 'model' || x.how === 'failover'))
        .reduce((sum, x) => sum + (APPS[app].input * MODELS[x.model!].inPrice + APPS[app].output * MODELS[x.model!].outPrice) / 1e6, 0) * scale
    steps.push({
      text: `Every call is written to the Usage Log with its team, model and tokens, and summed in the Usage Store, so each team sees its own bill and Keys & Budgets can stop a runaway job. This minute costs ${usd(r.perMinuteCost)}, about ${usd(r.perMinuteCost * 60)} an hour.`,
      nodes: ['Usage Log', 'Usage Store', 'Keys & Budgets'],
      data: (['support', 'review', 'summary'] as App[])
        .map((a) => `${APPS[a].name.padEnd(15)} ${usd(appCost(a))} a minute`)
        .concat(`total           ${usd(r.perMinuteCost)} a minute, ${usd(r.perMinuteCost * 60)} an hour`)
        .join('\n'),
    })

    const failed = r.count('failed') + rejected
    steps.push({
      text: `${failed ? `${int(failed * scale)} of ${int(perMinute)} requests a minute fail.` : 'Every request gets an answer.'} ${r.wrong.length ? `${int(r.wrong.length * scale)} a minute get a confident answer to a different question. ` : ''}Average time to the first token: ${int(r.avgMs)} ms.`,
      nodes: ['Gateway API', 'Product Apps'],
      data: [
        `answered by a model: ${r.count('model') + r.count('failover')} of 40`,
        `answered from cache: ${r.count('exact') + r.count('semantic')} of 40${r.wrong.length ? ` (${r.wrong.length} wrong)` : ''}`,
        `failed: ${failed} of 40${rejected ? ` (${rejected} × 429)` : ''}${r.count('failed') ? ` (${r.count('failed')} × 503)` : ''}`,
        `cost: ${usd(r.perMinuteCost)} a minute`,
      ].join('\n'),
    })

    return {
      input: `${int(perMinute)}/min · ${o.smallFirst ? 'small for support' : 'large for all'} · cache ${o.cache}${o.outage ? ' · A down' : ''}${o.fallback ? ' · failover' : ''} → ${failed ? `${Math.round((failed / 40) * 100)}% failed` : 'all answered'}${r.wrong.length ? `, ${r.wrong.length} wrong` : ''}, ${usd(r.perMinuteCost)}/min`,
      steps,
    }
  },
}


const run = (v: Partial<Record<'traffic' | 'routing' | 'cache' | 'provider' | 'fallback', string>>) => ({ ...simulator.defaults, ...v })

export const llmGateway: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'llm-gateway',
  title: 'LLM Gateway',
  blurb: 'One front door for every model: keys and budgets, routing, token limits, fallbacks, caching and guardrails',
  guides: ['api-gateway-101', 'how-do-we-retry-on-failures', 'scale-circuit-breaker', 'scale-scaling-api-with-rate-limiters-at-stripe', 'scale-genie-gen-ai-on-call-copilot-at-uber', 'how-does-chatgpt-work'],
  story: {
    title: 'The weekend that cost $20,412',
    dek: 'Three AI features, three API keys and nobody watching the bill. How one gateway in front of every model fixed cost, outages, rate limits and a cache that answered the wrong question.',
    chapters: [
      {
        heading: 'Nobody knew whose bill it was',
        body: `By spring, a 300-person online shop in Hyderabad had three features built on large language models: a **Support Bot**, a **Code Review** bot and a **Doc Summariser**. Each team had signed up with the model provider on its own, pasted an API key into its own config, and called the provider directly.

One Monday, finance forwarded the provider's invoice with one line circled. Over the weekend, a summariser job had hit an error and retried the same request three times a second, for 60 hours:
- 3 × 60 × 60 × 60 = 648,000 calls
- each call: 7,500 tokens in at $3 per million, 600 out at $15 per million = $0.0315
- 648,000 × $0.0315 = **$20,412**

Nobody could say which team owned the job, because two teams shared that key. Rotating it broke both. A third key turned out to be committed to a public repository.

Arjun from the platform team proposed what they'd done for every other shared dependency: put one service in front of it. An **LLM gateway** gives every app one API and its own **virtual key**, keeps the real provider keys to itself, logs every call with its team, model, tokens and cost, and stops a team when it passes its budget.`,
        replay: { label: 'See one normal minute through the gateway', values: run({}) },
      },
      {
        heading: 'The day the provider went down',
        body: `Three weeks later, the provider had a 40-minute outage. Every AI feature in the company failed at once. Worse, each failed call waited 30 seconds for a timeout, so threads piled up and the checkout service, which shared a server with the Support Bot, slowed down too.

The gateway got two new parts:
- A **circuit breaker** per provider. After 5 failures in a row it opens: calls stop going to the broken provider at all, so they fail in milliseconds instead of 30 seconds. Every 30 seconds it lets one test call through to see if the provider is back.
- A **fallback**: a second provider with a comparable large model, with the team's prompts tested against both. When the breaker opens, requests go there instead.

The second provider costs a little more, $11.93 a minute instead of $10.22 on a normal day, and answers a little slower. During an outage, nobody minds.`,
        replay: { label: 'Replay the outage with failover', values: run({ provider: 'Down (returning 503s)', fallback: 'Fail over to provider B' }) },
      },
      {
        heading: 'Sale day',
        body: `On the first big sale, traffic went from 1,000 requests a minute to 6,000. The provider limits each account to a number of **tokens a minute**, here 6 million for the large model. That day needed 14.6 million.

More than half of all requests, 3,300 a minute, came back with \`429 Too Many Requests\`. The Support Bot went quiet exactly when most customers were asking it questions.

Three changes made the next sale uneventful:
- **Count tokens, not requests.** A summary uses more than eight times the tokens of a support answer, so a limit on requests says little about the provider's limit. The gateway reserves each request's input tokens plus its maximum output before calling, and corrects the count afterwards.
- **Route by task.** "How do I reset my password?" doesn't need the largest model. Support questions now go to a small model that costs 20 to 25 times less per token, which frees the large model's limit for code reviews and summaries.
- **Spill over.** When provider A's limit runs out, the rest goes to provider B instead of failing.`,
        replay: { label: 'Replay the sale with routing and spill-over', values: run({ traffic: 'Sale day (6,000 requests a minute)', routing: 'Small model for support questions', fallback: 'Fail over to provider B' }) },
      },
      {
        heading: 'The cache that answered the wrong question',
        body: `Most support questions are the same few questions. An **exact cache** stores each answer under the app, the model and the prompt, lower-cased and stripped of punctuation, so "how do I reset my password" matches "How do I reset my password?". With yesterday's common answers already cached, 22 of every 40 requests on a normal day never reached a model, and the bill fell from $10.22 a minute to $7.15.

Then someone added a **semantic cache**: embed the question, and reuse an answer whose question means nearly the same. It caught "I forgot my password, how can I reset it?" and "Is delivery available on Sunday?". It also decided that "How do I cancel my order?" was close enough (similarity 0.80) to "How do I cancel my subscription?". Customers who wanted to cancel one order were told how to end their membership, and some did.

> A cache that's wrong is worse than no cache: it is fast, confident and repeated to everyone who asks.

The fixes: a threshold of 0.95, so only near-identical questions match; cache keys that include the app, the model and the system prompt's version; a time limit on every entry; and never caching a request that contains personal data.`,
        replay: { label: 'Replay the loose semantic cache', values: run({ cache: 'Semantic, similarity ≥ 0.75' }) },
      },
      {
        heading: 'One front door',
        body: `A year on, nobody at the company calls a model provider directly. The gateway does a few plain things, in order, for every request:
- checks the virtual key and the team's budget
- masks phone numbers and email addresses before a prompt leaves the company
- picks a model for the task
- answers from cache when it safely can
- keeps every model under its token limit, and fails over when a provider is down
- logs the team, model, tokens, cost and latency of every call

A normal minute now costs $6.41 instead of $10.22, 37% less, with no wrong cached answers, and a provider outage is a dashboard alert instead of an incident. Adding a new model is a config change in one place.`,
        replay: { label: 'Run the finished setup', values: run({ routing: 'Small model for support questions', cache: 'Semantic, similarity ≥ 0.95', fallback: 'Fail over to provider B' }) },
      },
    ],
  },
  takeaways: [
    'An LLM gateway is one API in front of every model provider: apps get virtual keys, and the real keys, limits and logs live in one place.',
    'Log every call with its team, model, tokens and cost, and enforce budgets, or a single retry loop can run up a five-figure bill unnoticed.',
    'Providers limit tokens a minute, not requests, so rate-limit by tokens and route easy tasks to smaller, cheaper models.',
    'A circuit breaker turns a provider outage into fast failures, and a tested fallback provider turns it into slower successes.',
    'Exact caching is safe and cheap; semantic caching needs a strict threshold, narrow keys and no personal data, or it serves confident wrong answers.',
    'Mask personal data before prompts leave the company, and treat prompt logs as sensitive data.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'gateway', label: 'LLM gateway' },
      { id: 'cache', label: 'Caches' },
      { id: 'dispatch', label: 'Calling providers' },
      { id: 'providerA', label: 'Provider A' },
      { id: 'providerB', label: 'Provider B' },
    ],
    nodes: [
      { id: 'apps', label: 'Product Apps', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: 'Gateway API', shape: 'rectangle', color: 'violet', group: 'gateway' },
      { id: 'keys', label: 'Keys & Budgets', shape: 'rectangle', color: 'violet', group: 'gateway' },
      { id: 'guard', label: 'Guardrails', shape: 'rectangle', color: 'violet', group: 'gateway' },
      { id: 'route', label: 'Which Model?', shape: 'diamond', color: 'violet', group: 'gateway' },
      { id: 'exact', label: 'Exact Cache', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'semantic', label: 'Semantic Cache', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'limit', label: 'Token Limiter', shape: 'rectangle', color: 'violet', group: 'dispatch' },
      { id: 'health', label: 'Provider Healthy?', shape: 'diamond', color: 'violet', group: 'dispatch' },
      { id: 'small', label: 'Small Model (A)', shape: 'cloud', color: 'violet', group: 'providerA' },
      { id: 'large', label: 'Large Model (A)', shape: 'cloud', color: 'violet', group: 'providerA' },
      { id: 'largeB', label: 'Large Model (B)', shape: 'cloud', color: 'violet', group: 'providerB' },
      { id: 'log', label: 'Usage Log', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'usage', label: 'Usage Store', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'apps', to: 'api', label: 'one API, virtual key', dashed: false },
      { from: 'api', to: 'keys', label: 'key, budget', dashed: false },
      { from: 'api', to: 'guard', label: 'prompt', dashed: false },
      { from: 'guard', to: 'route', label: 'masked prompt', dashed: false },
      { from: 'route', to: 'exact', label: 'lookup', dashed: false },
      { from: 'exact', to: 'semantic', label: 'miss', dashed: false },
      { from: 'semantic', to: 'limit', label: 'miss', dashed: false },
      { from: 'limit', to: 'health', label: 'within limit', dashed: false },
      { from: 'health', to: 'small', label: 'easy tasks', dashed: false },
      { from: 'health', to: 'large', label: 'hard tasks', dashed: false },
      { from: 'health', to: 'largeB', label: 'A is down', dashed: true },
      { from: 'limit', to: 'largeB', label: 'over A\'s limit', dashed: true },
      { from: 'api', to: 'log', label: 'team, tokens, cost', dashed: false },
      { from: 'log', to: 'usage', label: 'totals', dashed: false },
      { from: 'usage', to: 'keys', label: 'spend so far', dashed: true },
      { from: 'exact', to: 'api', label: 'hit', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'teams',
        name: 'teams',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'monthly_budget_usd', type: 'numeric(10,2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'alert_at_percent', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'virtual_keys',
        name: 'virtual_keys',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'team_id', type: 'uuid', pk: false, fk: 'teams.id', nullable: false, unique: false },
          { name: 'key_hash', type: 'bytea', pk: false, fk: null, nullable: false, unique: true },
          { name: 'allowed_models', type: 'text[]', pk: false, fk: null, nullable: false, unique: false },
          { name: 'tokens_per_minute', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'revoked_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(team_id)'],
      },
      {
        id: 'usage_events',
        name: 'usage_events',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'key_id', type: 'uuid', pk: false, fk: 'virtual_keys.id', nullable: false, unique: false },
          { name: 'model', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'input_tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'output_tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'cost_usd', type: 'numeric(12,6)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'cache', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'status', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'latency_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(key_id, created_at)', '(created_at)'],
      },
    ],
    relations: [
      { from: 'teams', to: 'virtual_keys', kind: 'one-to-many', label: 'owns' },
      { from: 'virtual_keys', to: 'usage_events', kind: 'one-to-many', label: 'logged as' },
    ],
  },
  explanation: {
    title: 'LLM Gateway',
    summary:
      'An LLM gateway sits between a company\'s apps and the model providers they call. It holds the real API keys, gives each team its own virtual key and budget, routes each request to a suitable model, caches safe answers, keeps calls under the providers\' token limits, fails over when a provider is down, masks personal data and logs the cost of every call.',
    sections: [
      {
        heading: 'Overview',
        body: 'A large language model (LLM) is usually called over an API, priced per token: roughly three quarters of a word. Once several teams use several models, the same problems show up in every team: keys pasted into configs, no idea who spends what, outages that take every feature down at once, and rate-limit errors on busy days.\n\nA gateway solves them once. Apps call one API with a virtual key; the gateway does the rest and calls the provider with the real key. It is an API gateway that understands tokens, models and prompts.\n\nThe simulator runs a real sample of 40 requests through the gateway: it masks personal data with real patterns, routes, looks each request up in an exact and a semantic cache, applies per-model token limits and fails over. Totals are scaled to the chosen traffic. Prices are illustrative.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- One API for every model and provider, with streaming.\n- Virtual keys per team, with allowed models, a tokens-a-minute limit and a monthly budget.\n- Routing by task, and failover to another provider.\n- Exact and (optionally) semantic caching.\n- Mask personal data before it leaves the company.\n- A usage log: team, model, tokens, cost, latency and status for every call.\n\nNon-functional:\n- Adds under 20 ms at p99, excluding the model itself.\n- 6,000 requests a minute at peak.\n- More available than any single provider: 99.95%.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Normal day: 1,000 requests a minute = 1.44 million a day.\n- Tokens: the sample averages (28 × 970 + 6 × 3,650 + 6 × 8,100) ÷ 40 ≈ 2,442 tokens a request, so 2.44 million tokens a minute, and 14.6 million on a 6,000-a-minute sale day.\n- Cost with the large model for everything: $10.22 a minute ≈ $14,720 a day. Routing support to the small model and caching brings it to $6.41 a minute.\n- Open streams (Little\'s law): 1,000 a minute ÷ 60 × 4 seconds a response ≈ 67 at once; 400 on a sale day.\n- Usage log: 1.44 million rows a day × about 1 KB = 1.44 GB a day, without prompt text.',
      },
      {
        heading: 'Step by step',
        body: '1. Product Apps call the Gateway API with a virtual key.\n2. Keys & Budgets checks the key, its allowed models and the team\'s spend so far.\n3. Guardrails mask phone numbers, emails and other personal data in the prompt.\n4. Which Model? picks a model: the Small Model (A) for easy tasks, the Large Model (A) for hard ones.\n5. The Exact Cache, then the Semantic Cache, are checked; a safe hit is returned straight away.\n6. The Token Limiter reserves the request\'s tokens against the model\'s limit, or sends it to the Large Model (B) when A\'s limit is used up.\n7. Provider Healthy? sends the call to provider A, or to the Large Model (B) while A\'s circuit breaker is open.\n8. The answer streams back, and the Gateway API writes the call to the Usage Log, which the Usage Store sums for budgets and dashboards.',
      },
      {
        heading: 'Components',
        body: '- Product Apps: the support bot, code review bot and document summariser; they know a virtual key and a model name, nothing else.\n- Gateway API: one HTTP API for every model, with streaming; runs the steps in order and writes usage.\n- Keys & Budgets: virtual keys mapped to teams, allowed models, limits and budgets; revoking a key affects one team.\n- Guardrails: masks personal data in prompts and can block requests that break policy.\n- Which Model?: picks a model per request, by task, cost or a cascade from small to large.\n- Exact Cache: answers keyed by app, model, prompt version and normalised prompt, with a time limit.\n- Semantic Cache: answers to questions that mean nearly the same, found by embedding similarity above a strict threshold.\n- Token Limiter: per-model and per-team token budgets a minute, shared across gateway instances.\n- Provider Healthy?: a circuit breaker per provider that stops calls after repeated failures and tests recovery.\n- Small Model (A): a cheap, fast model for routine questions.\n- Large Model (A): the main model for hard tasks.\n- Large Model (B): a comparable model at a second provider, for failover and overflow.\n- Usage Log: an append-only stream of every call\'s team, model, tokens, cost and status.\n- Usage Store: totals by team, model and day, for budgets, alerts and invoices.',
      },
      {
        heading: 'Key decisions',
        body: '- Build or adopt: open-source gateways (LiteLLM, for example) and managed ones already do most of this; build only the parts that are specific to you.\n- Routing: static rules by task are predictable; a cascade (try the small model, escalate when it is unsure) saves more but adds latency to escalated requests.\n- Failover needs tested prompts: models differ in format and behaviour, so run the same evaluation set against the fallback before relying on it.\n- Rate limits by tokens: reserve input tokens plus max_tokens before the call, then correct to the real count. Keep counters in Redis so every gateway instance shares them.\n- Retry only what is safe: retry 429 and 5xx with backoff and jitter, never a 400, and cap retries so a loop can\'t run all weekend.\n- Caching: exact caching is almost free of risk. Semantic caching needs a high threshold, keys that include the app, model and prompt version, a time limit, and must skip personal data.\n- Logging prompts: useful for debugging, but they are sensitive. Mask first, restrict access and keep them briefly.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The gateway is stateless; run several instances across zones behind a load balancer, with limits and breaker state in Redis.\n- It is now a single point of failure for every AI feature: keep it simple, fast to deploy and well monitored, and let apps degrade gracefully when it is down.\n- Budgets are enforced from the usage totals a few seconds behind; add a hard per-key tokens-a-minute cap so a runaway job is stopped within a minute, not at month end.\n- Breakers per provider and region: one region\'s outage shouldn\'t move all traffic.\n- Streaming: keep connections open through the gateway without buffering whole responses; count output tokens as they stream.\n- Spikes: queue low-priority work (batch summaries) and let interactive requests go first.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you enforce a monthly budget exactly, not just eventually?\n- A provider returns 429 for one model but not another. How should routing react?\n- How do you test that a fallback model is good enough before an outage?\n- How would you design a semantic cache that never leaks one customer\'s answer to another?\n- How do you rate-limit by tokens when you don\'t know the output length in advance?\n- Where should personal data be masked, and what breaks if the model needs it?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Token limiter with Redis (TypeScript)',
        language: 'typescript',
        source: `import { Redis } from 'ioredis'

const redis = new Redis()

// Reserve tokens for this minute before calling the model. Input tokens are
// known; the output is capped by max_tokens, so reserve that and correct later.
export async function reserve(key: string, limitPerMinute: number, input: number, maxOutput: number) {
  const bucket = \`tpm:\${key}:\${Math.floor(Date.now() / 60_000)}\`
  const want = input + maxOutput
  const used = await redis.incrby(bucket, want)
  if (used === want) await redis.expire(bucket, 120)
  if (used > limitPerMinute) {
    await redis.decrby(bucket, want) // give it back: this request won't run
    return { ok: false as const, retryAfterSeconds: 60 - (Math.floor(Date.now() / 1000) % 60) }
  }
  return { ok: true as const, bucket, reserved: want }
}

// After the call: return what the model didn't use.
export async function settle(bucket: string, reserved: number, actualTokens: number) {
  if (reserved > actualTokens) await redis.decrby(bucket, reserved - actualTokens)
}`,
      },
      {
        title: 'Circuit breaker with failover (TypeScript)',
        language: 'typescript',
        source: `type Call = (prompt: string) => Promise<string>

class Breaker {
  private failures = 0
  private openUntil = 0
  constructor(private readonly threshold = 5, private readonly coolDownMs = 30_000) {}

  get open() {
    return Date.now() < this.openUntil
  }
  success() {
    this.failures = 0
  }
  failure() {
    // After enough failures in a row, stop calling for a while instead of waiting on timeouts.
    if (++this.failures >= this.threshold) this.openUntil = Date.now() + this.coolDownMs
  }
}

const breakers = new Map<string, Breaker>()

export async function complete(prompt: string, providers: { name: string; call: Call }[]) {
  for (const p of providers) {
    const b = breakers.get(p.name) ?? breakers.set(p.name, new Breaker()).get(p.name)!
    if (b.open) continue
    try {
      const text = await p.call(prompt)
      b.success()
      return { text, provider: p.name }
    } catch {
      b.failure() // try the next provider
    }
  }
  throw new Error('All providers are unavailable')
}`,
      },
      {
        title: 'A cache key that can\'t mix up answers (Python)',
        language: 'python',
        source: `import hashlib
import re

EMAIL = re.compile(r"[\\w.+-]+@[\\w-]+\\.[\\w.]+")
PHONE = re.compile(r"\\b[6-9]\\d{4}\\s?\\d{5}\\b")

def normalise(prompt: str) -> str:
    text = re.sub(r"[^\\w\\s#-]", "", prompt.lower())
    return re.sub(r"\\s+", " ", text).strip()

def cache_key(app: str, model: str, prompt_version: str, prompt: str) -> str | None:
    # Answers about one person's data are never shared.
    if EMAIL.search(prompt) or PHONE.search(prompt):
        return None
    # Same app, model and system prompt, and the same words: only then is it the same question.
    raw = "|".join([app, model, prompt_version, normalise(prompt)])
    return hashlib.sha256(raw.encode()).hexdigest()

print(cache_key("support", "small-a", "v7", "How do I reset my password?")
      == cache_key("support", "small-a", "v7", "how do I reset my password"))  # True`,
      },
      {
        title: 'Calling the gateway (bash)',
        language: 'bash',
        source: `# Apps send the same request shape for every model; the gateway holds the provider keys.
curl https://llm-gateway.internal/v1/chat/completions \\
  -H "Authorization: Bearer $SUPPORT_BOT_VIRTUAL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "model": "support-default",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": "How do I reset my password?"}]
      }'

# Response headers say what happened:
# x-gateway-model: small-a   x-gateway-cache: exact   x-gateway-cost-usd: 0.000000`,
      },
    ],
    related: ['API gateway', 'Rate limiter', 'Circuit breaker', 'RAG pipeline', 'Distributed cache', 'AI agents'],
  },
  simulator,
}
