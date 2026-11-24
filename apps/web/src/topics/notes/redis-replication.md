# Redis Replication, Sentinel and Cluster

> 💡 **TL;DR**: **Replication** keeps copies of a Redis **primary** on other machines, called **replicas**. A replica copies the whole dataset once, then receives every write as a stream. **Sentinel** is a set of small watcher processes: when the primary stops answering, they agree it is down and promote a replica. **Redis Cluster** splits the keys into 16,384 **hash slots** spread over several primaries, each with its own replicas, and fails each shard over by itself. All three copy data **asynchronously**: the primary replies before the replicas have the write, so a failover can lose the last few writes.

## At a glance

| | Replication | Sentinel | Redis Cluster |
|---|---|---|---|
| What it does | Copies one primary to replicas | Watches the primary, promotes a replica | Splits keys across primaries by hash slot |
| Protects against | Losing the only copy; too many reads for one node | A dead primary needing a person at 3 a.m. | Data or writes too big for one primary, and dead primaries |
| You run | 1 primary + replicas | Replication + 3 or more Sentinels | 3 or more primaries, each with replicas |
| Clients | Write to the primary, may read replicas | Ask the Sentinels for the primary's address | Hash each key to a slot and go to its owner |
| Limits | Async: replicas run a little behind | Still one primary for all writes | Multi-key commands need keys in one slot |

## How replication works

A replica starts with one line: `replicaof 10.0.1.11 6379`. It connects to the primary and says how much it already has with **`PSYNC`**, sending two things:

- the **replication ID**: a random 40-character name for one history of the dataset;
- the **offset**: how many bytes of that history it has applied.

After that the primary streams every write command to the replica, in order. Every second the replica answers with `REPLCONF ACK <offset>`, so the primary knows how far each replica has got. You can see it in `INFO replication`:

```bash
role:master
connected_slaves:2
slave0:ip=10.0.2.11,port=6379,state=online,offset=4820331607,lag=0
slave1:ip=10.0.3.11,port=6379,state=online,offset=4820331007,lag=0
master_replid:8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb
master_repl_offset:4820343607
```

Replicas are read-only by default (`replica-read-only yes`). They can also have replicas of their own, which takes copying work off the primary.

## Full sync and partial resync

There are two ways for a replica to catch up:

- **Partial resync.** The primary keeps its latest writes in the **replication backlog**, a ring buffer (`repl-backlog-size`, 1 MB by default). If the replica's offset is still inside it, the primary replies `+CONTINUE` and sends only the missing bytes.
- **Full sync.** If the offset has fallen out of the backlog, or the replica knows a different replication ID, the primary replies `+FULLRESYNC`. It forks, writes a snapshot of the whole dataset, and sends it. The replica deletes its old data and loads the snapshot. Writes made meanwhile wait in the replica's output buffer on the primary, and are sent at the end.

A worked example, at 6k writes a second of about 100 bytes each, 600 KB/s:

- A replica is cut off for 30 s. It missed 30 × 600 KB = **18 MB**.
- With the default 1 MB backlog (about 1.7 s of writes), that's a full sync: a 2.4 GB snapshot takes 19.2 s to send at 1 Gbit/s and 24 s to load: **43.2 s**.
- With `repl-backlog-size 64mb` (about 107 s), it's a partial resync: 18 MB in about **0.1 s**.

> ⚠️ A full sync forks the primary and sends the whole dataset. If it takes so long that the output buffer passes `client-output-buffer-limit replica 256mb 64mb 60`, the primary drops the replica, and the sync starts again, forever.

## Asynchronous: what a failover can lose

The primary applies a write, **replies to the client, and then** sends it to the replicas. That keeps writes under a millisecond, but replicas run behind: here about 20 ms, which is 120 writes. If the primary's machine dies, those writes die with it, even though the client was told they succeeded.

Two settings narrow the window. Neither closes it:

- `WAIT 1 100` after an important write blocks for up to 100 ms until 1 replica has acknowledged it. It returns how many did. It is not a transaction: the write is not undone if no replica got it.
- `min-replicas-to-write 1` with `min-replicas-max-lag 10` makes the primary refuse writes when no replica has acknowledged for 10 s. That bounds split brain (see below).

## Reading from replicas

Replicas can serve reads, which spreads the load. The catch is **staleness**: a user adds an item, the next read goes to a replica 5 ms later, and the item isn't there yet.

- Read a user's own data, right after they write it, from the primary.
- Send reads that can be a little old to replicas: menus, leaderboards, feeds.
- Watch `lag` in `INFO replication`. A replica that falls far behind should stop serving reads.

## Sentinel: automatic failover

Sentinel is Redis in a special mode (`redis-sentinel sentinel.conf`). Run **at least three**, on different machines:

```bash
sentinel monitor carts 10.0.1.11 6379 2       # 2 = the quorum
sentinel down-after-milliseconds carts 5000
sentinel failover-timeout carts 60000
sentinel parallel-syncs carts 1
```

What happens when the primary dies:

1. Each Sentinel `PINGs` the primary every second. After `down-after-milliseconds` with no valid reply, it marks the primary **subjectively down** (`+sdown`).
2. It asks the other Sentinels. When the **quorum** (2 here) agree, the primary is **objectively down** (`+odown`).
3. The Sentinels elect a **leader** for this failover. It needs the votes of a **majority** of all Sentinels, 2 of 3. So a lone Sentinel cut off with the primary can never start a failover.
4. The leader picks a replica: the lowest `replica-priority` first (0 means never), then the highest replication offset, then the smallest run ID. It sends that replica `REPLICAOF NO ONE`.
5. It points the other replicas at the new primary and announces `+switch-master`. Clients that ask `SENTINEL get-master-addr-by-name carts` get the new address.

The other replicas don't need a full sync. The new primary keeps the old replication ID as a second ID (`master_replid2`), so they can continue with `PSYNC`. With these settings the whole failover takes about 6 s.

## Redis Cluster: sharding with failover

Redis Cluster spreads keys over several primaries:

- There are **16,384 hash slots**. A key's slot is `CRC16(key) mod 16384`. `CRC16("user:1001")` is 22096, so `user:1001` is in slot 5712.
- Each primary owns some slots. With three shards: A has 0 to 5460, B has 5461 to 10922, C has 10923 to 16383.
- The client keeps a **slot map** (from `CLUSTER SHARDS`) and sends each command straight to the slot's owner. There's no proxy in between.
- Every node also opens the **cluster bus** port (6379 + 10000 = 16379). Nodes use it to gossip, spot failures and vote.

**Hash tags** keep related keys together. If a key contains `{...}` with something inside, only that part is hashed. `cart:{user:1001}` and `profile:{user:1001}` both hash `user:1001`, so both live in slot 5712. Without braces, `cart:user:1001` is in slot 3725 and `profile:user:1001` in 12854, and `MGET` of the two fails:

```bash
> MGET cart:user:1001 profile:user:1001
(error) CROSSSLOT Keys in request don't hash to the same slot
```

**Failover works without Sentinel.** If a primary doesn't answer for `cluster-node-timeout`, other nodes mark it `PFAIL`. When a majority of primaries report it, it becomes `FAIL`. Its replica waits `500 ms + random(0-500 ms) + rank × 1000 ms` (the most up-to-date replica goes first), then asks the primaries for votes. With a majority of them, it takes over the slots. Only that shard's keys fail meanwhile.

On the minority side of a network split, a primary stops accepting writes once `cluster-node-timeout` has passed without the majority. That bounds the writes lost to split brain.

## Moving slots: MOVED and ASK

To rebalance, you move slots between shards (`redis-cli --cluster reshard`, or `rebalance`). Clients see two kinds of redirect:

- **`ASK`**, while a slot is moving. The old owner has already sent this key to the new one, so it replies `-ASK 5712 10.0.1.23:6379`. The client sends `ASKING` and the command to the new node, just this once.
- **`MOVED`**, after the move. `-MOVED 5712 10.0.1.23:6379` means the slot lives there now. The client updates its slot map.

Cluster clients (node-redis `createCluster`, Jedis `RedisClusterClient`, `redis-cli -c`) handle both for you.

## How to choose

- **One primary + a replica + Sentinel**: the data fits in one machine's memory and one primary can take the writes. Every command works and there are no slots. Most apps start here.
- **Redis Cluster**: the data or the writes outgrow one primary, and you can design keys around slots (hash tags for anything used together).
- **A managed service** (ElastiCache, Memorystore, Redis Cloud): the same two shapes, with failover, patching and backups run for you.
- **Neither**: data you can't afford to lose belongs in a database with synchronous replication. Redis replication is always asynchronous.

## ⚠️ Critical Mistakes

- **Leaving `repl-backlog-size` at 1 MB on a busy primary.** Every network blip longer than a second or two becomes a full sync. Size it as write rate × your longest normal disconnect.
- **Running two Sentinels.** If one machine dies, the remaining one is not a majority of two, so no failover can ever happen. Run three or more, on different machines.
- **Putting all Sentinels next to the primary.** If that rack fails, nothing is left to fail over. Spread them like the replicas.
- **Reading a user's own writes from a replica.** They will sometimes see old data. Read them from the primary.
- **Treating `WAIT` as a guarantee.** It narrows the window but doesn't stop a failover from losing writes.
- **Multi-key commands in Cluster without hash tags.** `MGET`, `MULTI` and Lua scripts fail with CROSSSLOT when keys are in different slots.
- **Putting a whole feature under one hash tag.** `{app}:...` puts every key in one slot on one shard, which undoes the sharding.
- **Caching a primary's IP address.** After a failover it points at a replica, or at nothing. Ask Sentinel or use a cluster client.

## Interview Q&As

**Q: How does a Redis replica catch up after a disconnect?**

A: It sends `PSYNC` with the replication ID and the offset it reached. If that offset is still in the primary's replication backlog, the primary replies +CONTINUE and sends just the missing bytes. If not, or if the replica knows a different history, the primary replies +FULLRESYNC: it forks, sends a snapshot of the whole dataset, then streams the writes it buffered meanwhile. Size the backlog so normal disconnects stay partial.

**Q: Why can Redis lose a write it acknowledged?**

A: Replication is asynchronous. The primary replies before the replicas have the write, so if the primary dies, the writes in that gap (a few milliseconds' worth) are gone after the failover. A network split can lose more: the old primary keeps accepting writes until min-replicas-to-write or cluster-node-timeout stops it. `WAIT` shrinks the window, but Redis never gives a hard guarantee.

**Q: What are Sentinel's quorum and majority?**

A: The quorum is how many Sentinels must agree the primary is unreachable before it is marked objectively down. The majority is what any failover then needs: a Sentinel must be elected leader by more than half of all Sentinels. So with three Sentinels and quorum 2, two can detect and fail over, and one stuck alone with the primary can do neither.

**Q: How does a client find the right node in Redis Cluster?**

A: It computes `CRC16(key) mod 16384` to get the slot (CRC16 is a 16-bit checksum), using only the hash tag inside {} if there is one. It looks the slot up in its slot map and sends the command to that primary. If the map is out of date, the node replies `MOVED` with the right address and the client refreshes. During a slot migration it may get `ASK`, which means "send `ASKING` and the command there, this once".

**Q: Sentinel or Cluster for 10 GB of sessions? For 500 GB?**

A: 10 GB fits in one machine's memory, so one primary with replicas and Sentinel is simpler, and every command works. 500 GB doesn't fit, and one primary may not take the writes either, so Cluster: about 10 shards of 50 GB, each with a replica, and keys designed with hash tags for anything read together.

**Q: What happens to a Redis Cluster when one shard loses both its primary and replica?**

A: That shard's slots have no owner. With the default cluster-require-full-coverage yes, the whole cluster stops serving, so that no client gets a partial answer. With it set to no, the other shards keep working, and only keys in the missing slots fail.

## Related topics

- [Redis Persistence and Replication](/?topic=redis-persistence&read): RDB (Redis's snapshot file), the AOF (Redis's append-only file), and what each failure loses from the disk.
- [Distributed Cache](/?topic=distributed-cache&read): cache-aside on a Redis cluster, with eviction and stampedes.
- [Consistent Hashing](/?topic=consistent-hashing&read): the other way to spread keys, with a hash ring.
- [Leader Election (Raft)](/?topic=leader-election&read): elections with terms and majorities, like Sentinel's and Cluster's.
- [Locking: Redis & Database](/?topic=locking&read): why a lock in one Redis can break during a failover.

## Sources

- Redis docs: [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- Redis docs: [High availability with Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- Redis docs: [Redis cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- Redis docs: [Scale with Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/)

## Why This Matters

Almost every system design answer has a box labelled "Redis". The next question is always what happens when it dies. Knowing that a replica resumes from an offset, that Sentinel needs a majority, and that a cluster key lives in one of 16,384 slots lets you answer with numbers: how many writes you might lose, how many seconds writes fail, and which keys can be read together.
