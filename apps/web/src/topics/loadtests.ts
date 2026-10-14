// Load models for the hand-written topics: the knobs a learner can turn in the
// 3D lab, and the system each setting describes. Service times and capacities
// are typical values, not measurements of any particular product. Queue limits
// mirror real backlogs (accept queues, connection-pool waits): past them, a
// component rejects work instead of letting every request wait forever.
import { perSecond, type LoadTest } from '../sim/loadtest'

const traffic = (defaultRate: number, max: number) =>
  ({ kind: 'range', id: 'rate', label: 'Traffic', min: 100, max, default: defaultRate, log: true, format: perSecond }) as const

const retries = {
  kind: 'toggle',
  id: 'retries',
  label: 'Clients retry 3× on timeout',
  default: false,
  hint: 'Watch what retries do to an overloaded database.',
} as const

const clientPolicy = (retry: boolean) => ({ timeoutMs: 1000, retries: retry ? 3 : 0, backoffMs: 50 })

export const urlShortenerLoad: LoadTest = {
  params: [
    traffic(2000, 50_000),
    { kind: 'range', id: 'hit', label: 'Cache hit rate', min: 0, max: 0.99, default: 0.9, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
    { kind: 'range', id: 'db', label: 'Database connections', min: 2, max: 200, default: 20, step: 1, format: (v) => `${v}` },
    { kind: 'range', id: 'app', label: 'Redirect API workers', min: 4, max: 256, default: 32, step: 1, format: (v) => `${v}` },
    retries,
  ],
  build: (v) => ({
    rate: v.rate as number,
    components: [
      { id: 'lb', label: 'Load Balancer', servers: 512, serviceMs: 0.1, cv: 0.3 },
      { id: 'shorten', label: 'Shorten API', servers: 16, serviceMs: 4, cv: 0.8, queueLimit: 500 },
      { id: 'keygen', label: 'Key Generator (base62)', servers: 8, serviceMs: 0.2, cv: 0.3 },
      { id: 'redirect', label: 'Redirect API', servers: v.app as number, serviceMs: 1.5, cv: 0.8, queueLimit: 1000 },
      { id: 'cache', label: 'Redis Cache', servers: 16, serviceMs: 0.25, cv: 0.5 },
      { id: 'db', label: 'URL Database', servers: v.db as number, serviceMs: 6, cv: 1.3, queueLimit: 200 },
    ],
    flows: [
      {
        // Opening a link: cache first, the database only on a miss (then refill the cache).
        id: 'redirect',
        weight: 0.98,
        steps: [
          { kind: 'visit', component: 'lb' },
          { kind: 'visit', component: 'redirect' },
          { kind: 'visit', component: 'cache' },
          {
            kind: 'branch',
            probability: 1 - (v.hit as number),
            then: [
              { kind: 'visit', component: 'db' },
              { kind: 'visit', component: 'cache' },
            ],
          },
        ],
      },
      {
        id: 'shorten',
        weight: 0.02,
        steps: [
          { kind: 'visit', component: 'lb' },
          { kind: 'visit', component: 'shorten' },
          { kind: 'visit', component: 'keygen' },
          { kind: 'visit', component: 'db' },
        ],
      },
    ],
    client: clientPolicy(v.retries as boolean),
  }),
}

export const rbacLoad: LoadTest = {
  params: [
    traffic(1000, 20_000),
    { kind: 'range', id: 'logins', label: 'Share of requests that are logins', min: 0, max: 0.2, default: 0.02, step: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` },
    {
      kind: 'toggle',
      id: 'rolesInToken',
      label: 'Roles carried in the JWT',
      default: true,
      hint: 'Turn off to look roles up in the database on every request.',
    },
    { kind: 'range', id: 'db', label: 'Database connections', min: 2, max: 200, default: 20, step: 1, format: (v) => `${v}` },
    retries,
  ],
  build: (v) => {
    const logins = v.logins as number
    return {
      rate: v.rate as number,
      components: [
        // Password hashing (bcrypt) is deliberately slow: logins are expensive.
        { id: 'login', label: 'Login Service', servers: 16, serviceMs: 60, cv: 0.4, queueLimit: 200 },
        { id: 'userdb', label: 'Users & Roles DB', servers: v.db as number, serviceMs: 4, cv: 1.2, queueLimit: 200 },
        { id: 'issue', label: 'Issue JWT (roles claim)', servers: 16, serviceMs: 1.5, cv: 0.4 },
        { id: 'gateway', label: 'API Gateway', servers: 64, serviceMs: 0.5, cv: 0.5 },
        { id: 'policy', label: 'Policy Check', servers: 64, serviceMs: 0.1, cv: 0.5 },
        { id: 'service', label: 'Protected Service', servers: 128, serviceMs: 15, cv: 1, queueLimit: 1000 },
      ],
      flows: [
        {
          id: 'api',
          weight: 1 - logins,
          steps: [
            { kind: 'visit', component: 'gateway' },
            ...(v.rolesInToken ? [] : [{ kind: 'visit' as const, component: 'userdb' }]),
            { kind: 'visit', component: 'policy' },
            { kind: 'visit', component: 'service' },
          ],
        },
        {
          id: 'login',
          weight: logins,
          steps: [
            { kind: 'visit', component: 'login' },
            { kind: 'visit', component: 'userdb' },
            { kind: 'visit', component: 'issue' },
          ],
        },
      ],
      client: clientPolicy(v.retries as boolean),
    }
  },
}
