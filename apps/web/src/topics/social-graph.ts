import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design the data structures for a social network" in the System
// Design Primer by Donne Martin (CC BY 4.0). Requirements, estimates and the
// Person Server / Lookup Service design follow the primer; the walkthrough, the
// simulator (a real breadth-first search over a small graph, one-sided or
// bidirectional), the code and the cache and bidirectional-search detail are
// Structura's.

const PERSON_SERVERS = 3

const NAMES: Record<number, string> = { 1: 'Ana', 2: 'Ben', 3: 'Chen', 4: 'Dev', 5: 'Esha', 6: 'Farid', 7: 'Gita', 8: 'Hugo', 9: 'Ivy', 10: 'Jun', 11: 'Kai', 12: 'Lena' }
const ID: Record<string, number> = Object.fromEntries(Object.entries(NAMES).map(([id, name]) => [name, Number(id)]))

// Friendships are mutual, so each pair is stored once here and read from both sides.
const FRIENDSHIPS: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [2, 5], [2, 6], [3, 6], [3, 7], [4, 8], [5, 9], [6, 9], [6, 10], [7, 10], [8, 11], [9, 12], [10, 12],
]
const FRIENDS = new Map<number, number[]>()
for (const [a, b] of FRIENDSHIPS) {
  FRIENDS.set(a, [...(FRIENDS.get(a) ?? []), b])
  FRIENDS.set(b, [...(FRIENDS.get(b) ?? []), a])
}

/** The Lookup Service: which Person Server holds a person (here, a fixed map by id). */
const serverOf = (id: number) => ((id - 1) % PERSON_SERVERS) + 1

const names = (ids: number[]) => ids.map((i) => NAMES[i]).join(', ')

/** Expand one whole level of a search: one batched call per Person Server, never one per friend. */
function expand(frontier: number[], parent: Map<number, number>, other?: Map<number, number>) {
  const next: number[] = []
  const calls = new Map<number, number[]>()
  for (const id of frontier) calls.set(serverOf(id), [...(calls.get(serverOf(id)) ?? []), id])
  let meeting: number | undefined
  for (const id of frontier) {
    for (const friend of FRIENDS.get(id) ?? []) {
      if (parent.has(friend)) continue
      parent.set(friend, id)
      next.push(friend)
      if (other?.has(friend) && meeting === undefined) meeting = friend
    }
  }
  return { next, calls: calls.size, meeting }
}

/** Walk parents back to the root: [root, …, id]. */
function pathTo(id: number, parent: Map<number, number>) {
  const path = [id]
  while (parent.get(path[0]) !== path[0]) path.unshift(parent.get(path[0])!)
  return path
}

const simulator: Simulator = {
  fields: [
    { id: 'from', label: 'Search from', options: ['Ana', 'Ben', 'Dev', 'Kai'] },
    { id: 'to', label: 'Search to', options: ['Lena', 'Hugo', 'Gita', 'Ivy'] },
    { id: 'method', label: 'Search method', options: ['Breadth-first from one side', 'Bidirectional (from both sides)'] },
  ],
  defaults: { from: 'Ana', to: 'Lena', method: 'Bidirectional (from both sides)' },
  run({ from, to, method }) {
    const a = ID[from] ?? 1
    const b = ID[to] ?? 12
    const both = method.startsWith('Bidirectional')
    const steps: Trace['steps'] = []

    steps.push({
      text: `${NAMES[a]} searches for ${NAMES[b]}. The Client sends the request to the Web Server, which forwards it to the Search API.`,
      nodes: ['Client', 'Web Server', 'Search API'],
      data: `GET /api/v1/path?from=${a}&to=${b}\nuser_id=${a} (${NAMES[a]})`,
    })
    steps.push({
      text: 'The Search API asks the User Graph Service to find the shortest path between them. The service does the graph search; it keeps no friend lists itself.',
      nodes: ['Search API', 'User Graph Service'],
      data: `shortest_path(${a}, ${b})\nmethod: ${both ? 'bidirectional BFS' : 'one-sided BFS'}`,
    })
    steps.push({
      text: `Friend lists live on Person Servers, and no one machine holds them all. The Lookup Service maps each person id to the Person Server that owns it (${PERSON_SERVERS} servers here).`,
      nodes: ['User Graph Service', 'Lookup Service'],
      data: `lookup(${a}) → person-server-${serverOf(a)}\nlookup(${b}) → person-server-${serverOf(b)}`,
    })

    if (a === b) {
      steps.push({ text: 'Same person on both ends: the path is just that person, so there is nothing to search.', nodes: ['User Graph Service'], data: `path: [${NAMES[a]}]  (0 hops)` })
      return { input: `${NAMES[a]} searches for ${NAMES[b]}`, steps }
    }

    // Level-by-level search, one breadth-first level (or one level from each side) per round.
    const fromA = new Map<number, number>([[a, a]])
    const fromB = new Map<number, number>([[b, b]])
    let frontA = [a]
    let frontB = [b]
    let round = 0
    let rpcs = 0
    let meeting: number | undefined

    while (meeting === undefined && frontA.length && (!both || frontB.length) && round < 12) {
      round++
      const ea = expand(frontA, fromA, both ? fromB : undefined)
      rpcs += ea.calls
      steps.push({
        text: `Round ${round}${both ? ' (from ' + NAMES[a] + ')' : ''}: fetch the friends of ${names(frontA)}. Their ids are grouped by Person Server, so this costs ${ea.calls} batched call${ea.calls === 1 ? '' : 's'}, not ${frontA.length} separate ones.`,
        nodes: ['User Graph Service', 'Person Server'],
        data: `getFriends([${frontA.join(', ')}]) → ${ea.calls} Person Server call${ea.calls === 1 ? '' : 's'}\nnew people: ${names(ea.next) || 'none'}`,
      })
      frontA = ea.next
      meeting = ea.meeting ?? (!both && fromA.has(b) ? b : undefined)
      if (meeting !== undefined) break
      if (both) {
        const eb = expand(frontB, fromB, fromA)
        rpcs += eb.calls
        steps.push({
          text: `Round ${round} (from ${NAMES[b]}): the same step from the other end, so the two searches meet in the middle instead of one search fanning out all the way.`,
          nodes: ['User Graph Service', 'Person Server'],
          data: `getFriends([${frontB.join(', ')}]) → ${eb.calls} Person Server call${eb.calls === 1 ? '' : 's'}\nnew people: ${names(eb.next) || 'none'}`,
        })
        frontB = eb.next
        meeting = eb.meeting
      }
    }

    if (meeting === undefined) {
      steps.push({ text: 'The frontier ran out without meeting: these two people are not connected.', nodes: ['User Graph Service'], data: 'path: none' })
      return { input: `${NAMES[a]} searches for ${NAMES[b]}`, steps }
    }

    const visited = new Set([...fromA.keys(), ...(both ? fromB.keys() : [])]).size
    const path = both ? [...pathTo(meeting, fromA), ...pathTo(meeting, fromB).reverse().slice(1)] : pathTo(b, fromA)
    steps.push({
      text: `${both ? `The two searches met at ${NAMES[meeting]}.` : `${NAMES[b]} was reached.`} Following the parent links back gives the shortest path: ${path.length - 1} hops. The search touched ${visited} of the ${Object.keys(NAMES).length} people.`,
      nodes: ['User Graph Service'],
      data: `path: ${path.map((i) => NAMES[i]).join(' → ')}\nhops: ${path.length - 1}\npeople visited: ${visited} / ${Object.keys(NAMES).length}\nPerson Server calls: ${rpcs}`,
    })
    steps.push({
      text: 'Recent paths and friend lists are cached in the Memory Cache (Redis), so a repeated search skips the Person Servers entirely.',
      nodes: ['User Graph Service', 'Memory Cache (Redis)'],
      data: `SET path:${Math.min(a, b)}:${Math.max(a, b)} "${path.join(',')}" EX 3600`,
    })
    steps.push({
      text: 'The Search API turns the ids into names and profile pictures with the User Info Service and returns the path.',
      nodes: ['Search API', 'User Info Service', 'Client'],
      data: json({ hops: path.length - 1, path: path.map((i) => ({ user_id: i, name: NAMES[i] })) }),
    })
    return { input: `${NAMES[a]} searches for ${NAMES[b]} (${both ? 'bidirectional' : 'one-sided'})`, steps }
  },
}

export const socialGraph: StaticTopic = {
  difficulty: 'Advanced',
  kind: 'static',
  id: 'social-graph',
  title: 'Social Network Graph',
  blurb: 'Friend lists across Person Servers, a lookup service, and shortest-path search',
  adaptedFrom: {
    title: 'Design the data structures for a social network',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/social_graph/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: [
    'primer-design-the-data-structures-for-a-social-network',
    'scale-tao-distributed-data-store-for-the-social-graph-at-facebook',
    'primer-cache',
    'scale-sharding',
  ],
  takeaways: [
    'A social network is a graph: people are nodes, friendships are edges, and the hard query is the shortest path between two people.',
    'One machine cannot hold every friend list, so spread people across Person Servers and keep a Lookup Service that says who lives where.',
    'Breadth-first search finds the shortest path, but every step may call another server, so batch the friend lookups per server.',
    'Searching from both ends and meeting in the middle visits far fewer people than searching from one end.',
    'Cache friend lists and recent paths in memory; most searches repeat.',
    'Very large graphs outgrow a plain relational database, so look at a graph store or specialised stores such as TAO.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'graph', label: 'Graph storage' }],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'search', label: 'Search API', shape: 'rectangle', color: 'violet', group: null },
      { id: 'graphsvc', label: 'User Graph Service', shape: 'rectangle', color: 'light-violet', group: null },
      { id: 'lookup', label: 'Lookup Service', shape: 'rectangle', color: 'light-violet', group: 'graph' },
      { id: 'person', label: 'Person Server', shape: 'rectangle', color: 'green', group: 'graph' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'graph' },
      { id: 'userinfo', label: 'User Info Service', shape: 'rectangle', color: 'light-violet', group: null },
      { id: 'sql', label: 'SQL Database', shape: 'rectangle', color: 'green', group: 'graph' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'search', label: 'GET /path', dashed: false },
      { from: 'search', to: 'graphsvc', label: 'shortest path', dashed: false },
      { from: 'graphsvc', to: 'lookup', label: 'which server?', dashed: false },
      { from: 'graphsvc', to: 'person', label: 'batched friend lookups', dashed: false },
      { from: 'graphsvc', to: 'cache', label: 'cached paths', dashed: true },
      { from: 'person', to: 'sql', label: 'friend lists', dashed: true },
      { from: 'search', to: 'userinfo', label: 'names, photos', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'person_server', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'friendships',
        name: 'friendships',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'friend_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id) — friend list of one person', 'Stored in both directions: (a, b) and (b, a)'],
      },
    ],
    relations: [{ from: 'friendships', to: 'users', kind: 'many-to-many', label: 'friends with' }],
  },
  explanation: {
    title: 'Social Network Graph',
    summary:
      'A social network is a graph of people and friendships. The key feature is finding the shortest path between two people. The friend lists are too big for one machine, so they are split across Person Servers, a Lookup Service says which server holds whom, and a breadth-first search walks the graph in batches.',
    sections: [
      {
        heading: 'Overview',
        body: 'People are nodes and friendships are edges. Two questions come up all the time:\n- Who are this person\'s friends? One lookup by user id.\n- How is person A connected to person B? A shortest-path search across the whole graph.\n\nA friend list is easy to find once you know which machine has it. The difficulty is that a search follows friends of friends of friends, and each hop may land on a different machine.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user searches for another user and sees the shortest path between them.\n- Service has high availability.\n\nOut of scope: how friendships are created, suggestions and ranking.\n\nAssume the graph is too large for one machine, and that paths are not weighted (every friendship counts as one hop).',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer: 100 million users, and 50 friend searches per user per month.\n\nWhich works out to:\n- 5 billion friend searches a month.\n- About 2,000 searches per second (2.5 million seconds in a month).\n\nOur own sizing: with 100 friends each on average, there are 10 billion friendships. Stored in both directions as 8-byte ids that is about 160 GB of raw friend lists, before indexes and replicas: too much to serve from one machine\'s memory, easy across many.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends a search to the Web Server, which forwards it to the Search API.\n2. The Search API asks the User Graph Service for the shortest path.\n3. The User Graph Service asks the Lookup Service which Person Server holds each person.\n4. It fetches friend lists from the Person Server, one batched call per server per level of the search.\n5. It repeats level by level, from one end or both, until the searches meet.\n6. It caches the path in the Memory Cache (Redis).\n7. The Search API fills in names and photos with the User Info Service and returns the path to the Client.',
      },
      {
        heading: 'Components',
        body: '- Client: the web or mobile app where a person searches for another person.\n- Web Server: a reverse proxy in front of the API (TLS, routing).\n- Search API: stateless server for path searches; scales by adding machines.\n- User Graph Service: runs the breadth-first search and batches friend lookups.\n- Lookup Service: maps a person id to the Person Server that owns it.\n- Person Server: holds the friend lists for its slice of the people.\n- Memory Cache (Redis): recent paths and hot friend lists, so repeat searches are cheap.\n- User Info Service: names and profile photos for the ids in a path.\n- SQL Database: the durable copy of users and friendships behind the Person Servers.',
      },
      {
        heading: 'Key decisions',
        body: '- Breadth-first search. It visits people hop by hop, so the first time it reaches the target is the shortest path. Depth-first search could find a longer path first.\n- Batch per server. Grouping a level\'s ids by Person Server turns hundreds of lookups into a handful of calls.\n- Bidirectional search. Searching from both ends stops when the two meet. With about 100 friends each, a one-sided search of depth 4 may touch 100^4 people, while two searches of depth 2 touch about 2 × 100^2.\n- Lookup Service. Needed so people can be moved between servers when the load shifts; a hash of the id alone would make moving them painful.\n- Friendships are stored in both directions so a friend list is one read.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Caching: keep the most-searched friend lists and recent paths in the Memory Cache (Redis). Most users search the same few people.\n- Lookup Service: replicate it; it is read far more than it changes.\n- Person Servers: replicate each, and rebalance when one gets too hot. Celebrity accounts with millions of friends need special handling.\n- Move heavy graph work off the request path: precompute the friends of friends for popular users, or search in the background.\n- If the graph outgrows a relational store, consider a graph database, or a purpose-built store like Facebook\'s TAO.\n- Put a limit on the search depth (say 6) so an unconnected pair does not walk the entire graph.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you find mutual friends of two people?\n- A person with 5 million friends is on one Person Server. What goes wrong?\n- How would you add friend suggestions (friends of friends)?\n- How would you keep the Lookup Service consistent when you move people?\n- When would you choose a graph database over sharded SQL?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Bidirectional breadth-first search',
        language: 'typescript',
        source: `type Friends = (ids: number[]) => Promise<Map<number, number[]>> // batched per server

export async function shortestPath(a: number, b: number, friends: Friends, maxDepth = 6) {
  const fromA = new Map([[a, a]]) // person -> who we came from
  const fromB = new Map([[b, b]])
  let frontA = [a]
  let frontB = [b]
  for (let depth = 0; depth < maxDepth && frontA.length && frontB.length; depth++) {
    // Always expand the smaller side: fewer friends to fetch.
    const [front, seen, other] = frontA.length <= frontB.length ? [frontA, fromA, fromB] : [frontB, fromB, fromA]
    const next: number[] = []
    for (const [id, list] of await friends(front)) {
      for (const f of list) {
        if (seen.has(f)) continue
        seen.set(f, id)
        if (other.has(f)) return f // the two searches met at f
        next.push(f)
      }
    }
    if (front === frontA) frontA = next
    else frontB = next
  }
  return null // not connected within maxDepth
}`,
      },
      {
        title: 'Batching lookups per Person Server',
        language: 'typescript',
        source: `// The Lookup Service says which server owns each person; group ids so each server is called once.
export async function getFriends(ids: number[], lookup: (id: number) => number, call: (server: number, ids: number[]) => Promise<Map<number, number[]>>) {
  const byServer = new Map<number, number[]>()
  for (const id of ids) byServer.set(lookup(id), [...(byServer.get(lookup(id)) ?? []), id])
  const results = await Promise.all([...byServer].map(([server, group]) => call(server, group)))
  return new Map(results.flatMap((m) => [...m]))
}`,
      },
      {
        title: 'Friend list (SQL)',
        language: 'sql',
        source: `-- Friendships are stored in both directions, so one index scan gives the whole list.
SELECT friend_id FROM friendships WHERE user_id = $1;

-- Mutual friends of two people: the overlap of their lists.
SELECT a.friend_id
FROM friendships a
JOIN friendships b ON a.friend_id = b.friend_id
WHERE a.user_id = $1 AND b.user_id = $2;`,
      },
    ],
    related: ['Breadth-first search', 'Sharding', 'Graph database', 'Batching', 'Redis', 'Bidirectional search'],
  },
  simulator,
}
