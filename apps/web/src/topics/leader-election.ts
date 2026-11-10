import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Leader election the Raft way: a small cluster where one node leads and the rest
// follow. The simulator uses fixed per-node election timeouts (inside the Raft
// paper's suggested 150 to 300 ms range) so the winner is computed, not canned.

const HEARTBEAT_MS = 50 // leader heartbeat interval
const RTT_MS = 8 // round trip inside one data centre
const LAST_INDEX = 1042 // last committed log index before the story starts

// First election timeout per follower, then the timeouts they draw when a vote splits.
const FIRST: Record<number, number> = { 2: 187, 3: 243, 4: 156, 5: 291 }
const RETRY: Record<number, number> = { 2: 214, 3: 262, 4: 171, 5: 288 }

const quorum = (n: number) => Math.floor(n / 2) + 1
const lowest = (nodes: number[], table: Record<number, number>) => nodes.reduce((a, b) => (table[b] < table[a] ? b : a))
const node = (i: number) => `Node ${i}`

interface Election {
  winner: number
  term: number
  votes: number
  ms: number
  split: boolean
  /** The node timers, listed as "Node 2: 187 ms". */
  timers: string
}

/** Who wins among `voters` (nodes that can reach each other) when the leader of term `oldTerm` is gone. */
function elect(voters: number[], oldTerm: number, identical: boolean): Election {
  const split = identical && voters.length > 1
  const first = (i: number) => (identical ? 200 : FIRST[i])
  const timers = voters.map((i) => `${node(i)}: ${first(i)} ms`).join(', ')
  if (!split) {
    const winner = lowest(voters, FIRST)
    // Every other reachable voter grants its vote; the winner also votes for itself.
    return { winner, term: oldTerm + 1, votes: voters.length, ms: FIRST[winner] + RTT_MS, split: false, timers }
  }
  // Everyone times out together, votes for itself and gets one vote: no majority.
  const winner = lowest(voters, RETRY)
  return { winner, term: oldTerm + 2, votes: voters.length, ms: 200 + RETRY[winner] + RTT_MS, split: true, timers }
}

const simulator: Simulator = {
  fields: [
    { id: 'cluster', label: 'Cluster size', options: ['5 nodes', '3 nodes'] },
    {
      id: 'scenario',
      label: 'What happens',
      options: ['The leader crashes', 'A partition cuts the leader off', 'A quiet day (heartbeats only)'],
    },
    { id: 'timeouts', label: 'Election timeouts', options: ['Randomised 150–300 ms', 'Identical 200 ms'] },
  ],
  defaults: { cluster: '5 nodes', scenario: 'The leader crashes', timeouts: 'Randomised 150–300 ms' },
  run({ cluster, scenario, timeouts }) {
    const n = cluster.startsWith('3') ? 3 : 5
    const need = quorum(n)
    const identical = timeouts.startsWith('Identical')
    const crash = scenario.startsWith('The leader')
    const partition = scenario.startsWith('A partition')
    const all = Array.from({ length: n }, (_, i) => i + 1)
    const followers = all.slice(1)
    const entry = { index: LAST_INDEX + 1, term: 4, command: 'PUT balance:acct42 = 1500' }

    const steps: Trace['steps'] = [
      {
        text: `The Client sends a write to the leader, Node 1, which is leading term 4 of a ${n}-node cluster. Node 1 appends it to its log at index ${entry.index}.`,
        nodes: ['Client', 'Node 1'],
        data: `${entry.command}\n→ Node 1 log: … ${LAST_INDEX}: {term 4}  ${entry.index}: ${json(entry).replace(/\s+/g, ' ')}   ← new, not yet committed`,
      },
      {
        text: `Node 1 sends AppendEntries to the followers. The entry is committed once ${need} of ${n} nodes (a majority, counting the leader) have it on disk. Then the Client gets its answer.`,
        nodes: ['Node 1', ...followers.slice(0, need - 1).map(node)],
        data: `quorum = floor(${n}/2) + 1 = ${need}\nacks: Node 1 + ${need - 1} follower${need - 1 > 1 ? 's' : ''} = ${need} of ${n} → commitIndex = ${entry.index}`,
      },
      {
        text: `The leader keeps sending empty AppendEntries as a heartbeat every ${HEARTBEAT_MS} ms. Each heartbeat resets every follower's Election Timeout, so as long as they keep arriving, nobody starts an election.`,
        nodes: ['Node 1', 'Election Timeout'],
        data: `t=0 ms   heartbeat(term 4, commit ${entry.index})\nt=${HEARTBEAT_MS} ms  heartbeat(term 4, commit ${entry.index})\nfollower timers reset to a random 150–300 ms each time`,
      },
    ]

    if (!crash && !partition) {
      steps.push({
        text: `Nothing fails, so the term stays 4. Reads can go to the leader too: it first confirms with a heartbeat round that a majority still follows it, so it never answers from a stale reign.`,
        nodes: ['Client', 'Node 1'],
        data: `GET balance:acct42 → 1500\nleader checks: ${need} of ${n} acked the latest heartbeat ✓\nterm 4, ${n - 1} followers, 0 elections`,
      })
      return { input: `${n} nodes, heartbeats only`, steps }
    }

    // Who can still talk to each other?
    const majoritySide = partition ? all.slice(n === 5 ? 2 : 1) : followers // 5 nodes: {1,2} | {3,4,5}; 3 nodes: {1} | {2,3}
    const minoritySide = all.filter((i) => !majoritySide.includes(i))
    const el = elect(majoritySide, 4, identical)
    const winner = node(el.winner)

    if (crash) {
      steps.push({
        text: 'Node 1 crashes just after a heartbeat. The heartbeats stop, and the followers\' Election Timeouts start running down with nothing to reset them.',
        nodes: ['Node 1', 'Election Timeout'],
        data: `Node 1: down (term 4, last log index ${entry.index})\nelection timers: ${el.timers}`,
      })
    } else {
      steps.push({
        text: `A network partition splits the cluster: ${minoritySide.map(node).join(' and ')} on one side, ${majoritySide.map(node).join(', ')} on the other. Node 1 is still alive and still thinks it leads, but it is on the small side.`,
        nodes: ['Node 1', 'Election Timeout'],
        data: `side A (${minoritySide.length}): ${minoritySide.map(node).join(', ')}   ← Node 1\nside B (${majoritySide.length}): ${majoritySide.map(node).join(', ')}\nside B election timers: ${el.timers}`,
      })
      steps.push({
        text: `A second client write reaches Node 1 and is appended at index ${entry.index + 1}. But Node 1 can only reach ${minoritySide.length} of ${n} nodes, short of the ${need} it needs, so the write never commits and the Client waits.`,
        nodes: ['Client', 'Node 1'],
        data: `append index ${entry.index + 1}, term 4: PUT balance:acct42 = 1400\nacks: ${minoritySide.length} of ${n} (need ${need}) ✗ stays uncommitted`,
      })
    }

    if (el.split) {
      steps.push({
        text: `All ${majoritySide.length} reachable followers have the same 200 ms timeout, so they all fire at once, become candidates for term 5 and vote for themselves. Each has 1 vote, which is short of ${need}: a split vote, and nobody wins.`,
        nodes: [...majoritySide.map(node), 'Term + Vote Store'],
        data: majoritySide.map((i) => `${node(i)}: term 5, votedFor = ${node(i)} (1 vote)`).join('\n') + `\nneeded ${need} → no leader, term 5 is wasted`,
      })
      steps.push({
        text: `Each candidate waits a new random timeout (${majoritySide.map((i) => `${node(i)} ${RETRY[i]} ms`).join(', ')}). ${winner} draws the shortest, so it starts term ${el.term} first, and the others, seeing a higher term, vote for it.`,
        nodes: [winner, 'Election Timeout'],
        data: `retry timers: ${majoritySide.map((i) => `${node(i)}=${RETRY[i]} ms`).join(', ')}\nlowest: ${winner} → RequestVote(term ${el.term})`,
      })
    } else {
      steps.push({
        text: `${winner} has the shortest timeout (${FIRST[el.winner]} ms), so it fires first. It becomes a candidate: it adds 1 to the term (4 → 5), votes for itself and saves that to disk before asking anyone, so a restart cannot make it vote twice.`,
        nodes: [winner, 'Term + Vote Store'],
        data: `${winner}: state=candidate, currentTerm=5, votedFor=${winner}  (fsync)\nRequestVote(term=5, candidateId=${el.winner}, lastLogIndex=${entry.index}, lastLogTerm=4)`,
      })
    }

    const granted = majoritySide.filter((i) => i !== el.winner).slice(0, Math.max(need - 1, 1))
    steps.push({
      text: `Voters grant a vote if they have not voted in that term and the candidate's log is at least as up to date as theirs. ${winner} collects ${granted.length + 1} votes (its own plus ${granted.map(node).join(', ')}); it needs ${need} of ${n}, so it wins.`,
      nodes: [winner, ...granted.map(node), 'Term + Vote Store'],
      data: `votes for ${winner} in term ${el.term}: ${[el.winner, ...granted].map(node).join(', ')} = ${granted.length + 1}\nquorum ${need} of ${n} ✓ → state=leader`,
    })
    steps.push({
      text: `${winner} immediately sends a heartbeat for term ${el.term}, which resets the followers' timers and stops any further election. The cluster had no leader for about ${el.ms} ms (${el.split ? `a 200 ms wasted round, then ${RETRY[el.winner]} ms` : `${FIRST[el.winner]} ms timeout`} + ${RTT_MS} ms to collect votes).`,
      nodes: [winner, 'Election Timeout'],
      data: `${winner}: AppendEntries(term ${el.term}, entries=[]) → all reachable followers\nleaderless window ≈ ${el.ms} ms\nclients retry and are redirected to ${winner}`,
    })

    if (crash) {
      steps.push({
        text: `The Client retries and reaches ${winner}, which commits the write at index ${entry.index + 1} in term ${el.term}. When Node 1 restarts it sees the higher term, steps down to follower and catches up. There is still exactly one leader.`,
        nodes: ['Client', winner, 'Node 1'],
        data: `Node 1 restarts: term 4, hears term ${el.term} → becomes follower, replays log from index ${entry.index}\n${winner} log: … ${entry.index}  ${entry.index + 1}: {term ${el.term}, PUT balance:acct42 = 1400}  committed`,
      })
    } else {
      steps.push({
        text: `Node 1 still believes it leads term 4 and tries to write to the shared store. The store has already accepted fencing token ${el.term} from ${winner}, so it rejects the stale token 4. Leadership alone is not enough; the resource must check the term too.`,
        nodes: ['Node 1', 'Fenced Storage'],
        data: `Node 1 → storage: write(token=4)   ✗ rejected: highest token seen is ${el.term}\n${winner} → storage: write(token=${el.term})   ✓`,
      })
      steps.push({
        text: `The partition heals. Node 1 hears a heartbeat with term ${el.term}, steps down, and deletes its uncommitted entry at index ${entry.index + 1}. That write was never acknowledged, so no promise is broken; the Client must retry it.`,
        nodes: ['Node 1', winner],
        data: `Node 1: sees term ${el.term} > 4 → follower\ntruncate log from index ${entry.index + 1} (term 4, never committed)\ncopy ${winner}'s log from index ${entry.index + 1}`,
      })
    }
    return {
      input: `${n} nodes, ${crash ? 'leader crash' : 'partition'}, ${identical ? 'identical' : 'random'} timeouts → ${winner} wins term ${el.term} in ~${el.ms} ms`,
      steps,
    }
  },
}

export const leaderElection: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'leader-election',
  title: 'Leader Election (Raft)',
  blurb: 'How a cluster agrees on one leader: terms, votes, heartbeats and fencing',
  guides: [
    'scale-paxos-made-live--an-engineering-perspective',
    'scale-chubby-lock-service-for-loosely-coupled-distributed-systems-at-google',
    'scale-zookeeper-at-twitter',
    'scale-building-and-deploying-mysql-raft-at-meta',
    'scale-how-to-do-distributed-locking',
    'why-do-we-need-to-use-a-distributed-lock',
    'primer-availability-vs-consistency',
    'scale-cap-theorem-and-trade-offs',
  ],
  takeaways: [
    'A leader needs votes from a majority (quorum), so two leaders can never be elected in the same term.',
    'Followers start an election only when heartbeats stop; each heartbeat resets their timer.',
    'Randomised election timeouts make a split vote rare, and a retry fixes it.',
    'Terms are a logical clock: a node that sees a higher term always steps down.',
    'A deposed leader may not know it yet, so shared resources should check a fencing token (the term).',
    'A cluster of 2f+1 nodes survives f failures; the minority side of a partition simply stops committing.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'cluster', label: 'Raft cluster (5 nodes)' }],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'n1', label: 'Node 1', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'n2', label: 'Node 2', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'n3', label: 'Node 3', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'n4', label: 'Node 4', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'n5', label: 'Node 5', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'timeout', label: 'Election Timeout', shape: 'diamond', color: 'orange', group: 'cluster' },
      { id: 'store', label: 'Term + Vote Store', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'fenced', label: 'Fenced Storage', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'client', to: 'n1', label: 'write (to the leader)', dashed: false },
      { from: 'n1', to: 'n2', label: 'AppendEntries / heartbeat', dashed: false },
      { from: 'n1', to: 'n3', label: 'AppendEntries / heartbeat', dashed: false },
      { from: 'n1', to: 'n4', label: 'AppendEntries / heartbeat', dashed: false },
      { from: 'n1', to: 'n5', label: 'AppendEntries / heartbeat', dashed: false },
      { from: 'n2', to: 'timeout', label: 'resets on heartbeat', dashed: true },
      { from: 'timeout', to: 'n4', label: 'fires: start election', dashed: true },
      { from: 'n4', to: 'n3', label: 'RequestVote', dashed: true },
      { from: 'n4', to: 'n5', label: 'RequestVote', dashed: true },
      { from: 'n4', to: 'n2', label: 'RequestVote', dashed: true },
      { from: 'n4', to: 'store', label: 'save term + vote', dashed: true },
      { from: 'n1', to: 'fenced', label: 'write + fencing token', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'raft_state',
        name: 'raft_state',
        columns: [
          { name: 'node_id', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'current_term', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'voted_for', type: 'int', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'log_entries',
        name: 'log_entries',
        columns: [
          { name: 'node_id', type: 'int', pk: true, fk: 'raft_state.node_id', nullable: false, unique: false },
          { name: 'log_index', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'term', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'command', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'leases',
        name: 'leases',
        columns: [
          { name: 'resource', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'holder', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'fencing_token', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'expires_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'raft_state', to: 'log_entries', kind: 'one-to-many', label: 'holds' }],
  },
  explanation: {
    title: 'Leader Election (Raft)',
    summary:
      'Many systems need exactly one node in charge: the primary of a database, the owner of a shard, the holder of a lock. Leader election lets a group of nodes agree on that one node, and agree again quickly when it fails. Raft does it with terms, votes from a majority, and heartbeats.',
    sections: [
      {
        heading: 'Overview',
        body: 'One leader is simpler than many writers: it decides the order of changes and the others copy them. The hard part is failure. If the leader dies, someone must take over. If the leader is only cut off from the network, it may still think it is in charge while a new one is elected. Two leaders at once is called split brain, and it corrupts data.\n\nRaft prevents it with a majority rule. A node becomes leader only with votes from more than half the cluster, and any two majorities overlap in at least one node, so two leaders can never both win the same term. A term is a number that counts elections; it works like a logical clock, and the highest term always wins.',
      },
      {
        heading: 'Requirements',
        body: '- At most one leader per term, always (safety).\n- A new leader after a crash within a second or so (liveness).\n- Committed writes are never lost when the leader changes.\n- A minority of nodes failing or cut off must not stop the majority.\n- Stale leaders must be unable to do damage.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example with 5 nodes, a 50 ms heartbeat and a 150 to 300 ms election timeout.\n- Heartbeat traffic: 4 followers × (1000 ÷ 50) = 80 messages per second; at about 100 bytes each, 8 KB/s. Tiny.\n- Failover time: shortest timeout plus one round trip, so about 150 + 8 = 158 ms at best and 300 + 8 = 308 ms at worst. Production systems often choose longer timeouts: etcd defaults to a 100 ms heartbeat and 1000 ms election timeout, trading slower failover for fewer false alarms on busy networks.\n- Split votes: with two followers timing out at random in a 150 ms window, the chance they land within one 8 ms round trip is 1 − (142 ÷ 150)² ≈ 10%. That is why a retry exists, and why a wider timeout range helps.\n- Availability: if each node is up 99.9% of the time, a majority of 3 nodes is up 99.9997% of the time (about 1.6 minutes down a year), and of 5 nodes 99.99999% (about 0.3 seconds a year), assuming independent failures.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends a write to the leader, Node 1.\n2. Node 1 appends it to its log and sends AppendEntries to the followers (Node 2, Node 3, Node 4, Node 5).\n3. Once a majority has it on disk, the entry is committed and the Client is answered.\n4. Node 1 sends empty AppendEntries as heartbeats; each one resets the Election Timeout on every follower.\n5. If the leader crashes, the heartbeats stop and the first Election Timeout to fire, say on Node 4, starts an election.\n6. Node 4 adds 1 to its term, votes for itself and saves that to the Term + Vote Store.\n7. Node 4 sends RequestVote to the other nodes; each grants at most one vote per term, and only if the candidate\'s log is up to date.\n8. With votes from a majority, Node 4 becomes leader and sends a heartbeat, so the others accept it and reset their timers.\n9. If the old leader was only partitioned, it writes to Fenced Storage with its old token, and the store rejects it.',
      },
      {
        heading: 'Components',
        body: '- Client: sends writes to the leader, and retries elsewhere when told who the leader is.\n- Node 1: the leader of term 4 in the story; it orders writes and sends heartbeats.\n- Node 2: a follower; it copies the leader\'s log and votes in elections.\n- Node 3: a follower; with two others it forms a majority of five.\n- Node 4: a follower with the shortest timeout, so it usually becomes the next leader.\n- Node 5: a follower; it is slower to time out, so it mostly votes for others.\n- Election Timeout: a random 150 to 300 ms timer on each follower, reset by every heartbeat; when it fires, an election starts.\n- Term + Vote Store: the disk record of the current term and whom the node voted for; it must survive restarts, or a node could vote twice.\n- Fenced Storage: a resource that remembers the highest fencing token (the term) it has seen and rejects anything lower.',
      },
      {
        heading: 'Key decisions',
        body: '- Odd cluster sizes: 3 nodes tolerate 1 failure and 5 tolerate 2; a 4th node adds cost but not tolerance, because a majority of 4 is still 3.\n- Timeout range: it must be much larger than the network round trip and much larger than the heartbeat interval, or healthy leaders get replaced. A wider random range makes split votes rarer.\n- Persist before replying: the term and vote go to disk first. Otherwise a crash and restart could vote twice in one term.\n- Log up-to-date check: voters refuse candidates with a shorter or older log, so a new leader always has every committed entry.\n- Leases: some systems give the leader a time-limited lease so it can serve reads locally. That relies on clocks, so fencing tokens still matter.\n- Do not roll your own: use etcd, ZooKeeper or Consul for coordination, and run your service\'s leader election on top of them.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Raft does not scale writes: every write goes through one leader and a majority. To scale, split data into many groups (shards), each with its own leader, as in CockroachDB and TiKV.\n- Leader crash: followers time out, one wins, writes resume in roughly a timeout plus one round trip.\n- Partition: the side with a majority elects a leader and carries on; the minority cannot commit anything, so it stays consistent but unavailable (the C in CAP).\n- Split vote: no one reaches a majority, the term is wasted, and the random retry timeouts resolve it in the next round.\n- Slow disk or a long garbage-collection pause: a leader that pauses past the election timeout is replaced, and wakes up as a stale leader; fencing tokens protect shared resources.\n- Clocks: Raft elections use local timers only and never compare clocks between nodes.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why are the election timeouts random?\n- Why does a leader need a majority, and why can two never be elected in the same term?\n- A leader is partitioned from the rest. What does it do, and what happens to its writes?\n- How would you stop an old leader from corrupting a shared database or file?\n- Why choose 5 nodes instead of 4, and what do you give up with 5 instead of 3?\n- When would you use a lock service like ZooKeeper instead of building election into your service?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Follower: election timeout and candidacy (TypeScript)',
        language: 'typescript',
        source: `type Role = 'follower' | 'candidate' | 'leader'

class RaftNode {
  role: Role = 'follower'
  term = 0
  votedFor: number | null = null
  timer?: ReturnType<typeof setTimeout>

  constructor(private id: number, private peers: Peer[], private disk: Disk) {}

  // A fresh random timeout each time makes simultaneous candidates unlikely.
  resetTimer() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.startElection(), 150 + Math.random() * 150)
  }

  async startElection() {
    this.role = 'candidate'
    this.term += 1
    this.votedFor = this.id
    await this.disk.save({ term: this.term, votedFor: this.id }) // persist before asking
    this.resetTimer() // if this round splits, try again
    let votes = 1
    await Promise.all(this.peers.map(async (p) => {
      const r = await p.requestVote({ term: this.term, candidateId: this.id, ...this.lastLog() })
      if (r.term > this.term) return this.stepDown(r.term)
      if (r.granted && this.role === 'candidate' && ++votes > (this.peers.length + 1) / 2) this.becomeLeader()
    }))
  }
}`,
      },
      {
        title: 'Voter: one vote per term (TypeScript)',
        language: 'typescript',
        source: `async requestVote(req: { term: number; candidateId: number; lastLogIndex: number; lastLogTerm: number }) {
  if (req.term < this.term) return { term: this.term, granted: false } // stale candidate
  if (req.term > this.term) await this.stepDown(req.term) // newer term: become follower, clear the vote

  const mine = this.lastLog()
  // Candidate's log must be at least as up to date as ours.
  const upToDate =
    req.lastLogTerm > mine.lastLogTerm ||
    (req.lastLogTerm === mine.lastLogTerm && req.lastLogIndex >= mine.lastLogIndex)

  if ((this.votedFor === null || this.votedFor === req.candidateId) && upToDate) {
    this.votedFor = req.candidateId
    await this.disk.save({ term: this.term, votedFor: this.votedFor }) // fsync before replying
    this.resetTimer()
    return { term: this.term, granted: true }
  }
  return { term: this.term, granted: false }
}`,
      },
      {
        title: 'Fencing token check on the resource (SQL)',
        language: 'sql',
        source: `-- The resource remembers the highest token (the leader's term) it has accepted.
-- A paused or partitioned old leader carries a lower token and is rejected.
UPDATE leases
SET holder = 4, fencing_token = 5, expires_at = now() + interval '10 seconds'
WHERE resource = 'orders-shard-7'
  AND fencing_token < 5;          -- 0 rows updated means someone newer already won

-- Every write checks the token it was given:
UPDATE accounts SET balance = 1500
WHERE id = 'acct42'
  AND (SELECT fencing_token FROM leases WHERE resource = 'orders-shard-7') <= 5;`,
      },
    ],
    related: ['Raft', 'Paxos', 'Consensus', 'Distributed locks', 'Fencing tokens', 'Split brain', 'etcd and ZooKeeper'],
  },
  simulator,
}
