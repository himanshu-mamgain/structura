# Ticket Booking System (BookMyShow-style)

> 💡 **TL;DR**: A seat is not like a normal product: there is exactly **one** seat A-14 for each show, and two fans must never both get it, even when 600k fans arrive at 10:00 for 18k seats. The design has three ideas. A **waiting room** lets fans in at a speed the servers can handle. A **hold** reserves the chosen seats for 10 minutes while the fan pays, kept in Redis with a timer so unpaid seats return to sale by themselves. And the **database has the final say**: a seat becomes sold only through an update that checks it's still available, so even if everything else goes wrong, a double sale is impossible.

## At a glance

| Question | Answer |
|---|---|
| The one rule | Never sell the same seat twice |
| Seat states | Available → held (10 minutes) → sold; an unpaid hold returns to available |
| Where a hold lives | Redis, as a key with a 600-second timer: `SET NX EX 600` |
| Where a sale lives | Postgres, changed by a guarded `UPDATE … WHERE status = 'available'` |
| Groups of seats | All or nothing, in one Redis script or one transaction |
| The crowd | 600k fans for 18k seats: 33 fans per seat |
| The waiting room | Lets in 2k fans a minute, each with a signed pass |
| How long it lasts | About 9 minutes until sold out; 97% of fans see "sold out" |
| Paying | The order ID is the idempotency key, so a retry never charges twice |
| Tickets | Sent from a queue, so a slow email service can't block a sale |

## What makes ticket booking hard

In a normal shop, if 10 people buy the same T-shirt, the shop has many. Here every seat is unique. When thousands of requests for the best seats arrive in the same second, the system must decide **who gets each seat** correctly, quickly, and fairly.

Without care, two things go wrong:
- **Double selling**: two fans both see A-14 as free, both pay, and one arrives to find someone in their seat.
- **Meltdown**: 600k browsers at 10:00 overwhelm the servers, and nobody can buy anything.

A seat has three states:
- **Available**: anyone can pick it.
- **Held**: one fan picked it and is paying. Temporary, so it lives in **Redis** (an in-memory store whose keys can expire on their own).
- **Sold**: paid for. Permanent, so it lives in **Postgres**, the database.

## Follow one booking all the way through

Concert day. At 10:00, Asha joins the sale and wants seats A-14 and A-15.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Asha joins the waiting room and gets place 41,200 in line | Fan (Browser) → Waiting Room (Queue) |
| 2 | At 2k fans a minute, her turn comes after about 21 minutes (41,200 ÷ 2k); she gets a signed pass | Waiting Room (Queue) |
| 3 | The gateway checks her pass on every request | API Gateway |
| 4 | She sees the seat map: sold seats from the database, held ones from Redis, cached for 2 seconds | Seat Map Service |
| 5 | She taps A-14 and A-15; neither is sold | Booking Service → Seats DB (Postgres) |
| 6 | Both are held in one step for her, for 600 seconds | Booking Service → Seat Hold Store (Redis) |
| 7 | A pending order is written, with "hold ends at 10:31:40" | Seats DB (Postgres) |
| 8 | She pays; the order ID is the idempotency key | Payment Service → Payment Provider |
| 9 | Payment succeeds: the guarded update marks both seats sold, and the hold is removed | Booking Service → Seats DB (Postgres) |
| 10 | An `order.paid` event goes on the queue; her tickets arrive by email | Order Events (Queue) → Ticket & Email Worker |

If a second fan, Ravi, taps A-14 between steps 6 and 9, his hold fails at step 6 and he sees "seat held, pick another".

## The waiting room

Scaling servers helps, but the database row for one hot seat is still one row, and you'd be buying capacity for one minute a year. A **waiting room** is cheaper and fairer: every fan gets a place in line, and fans are let in at a fixed rate (here 2k a minute). Each admitted fan gets a **signed pass**, a token the gateway can check without asking anyone, so nobody skips the line.

With each fan shopping for about 5 minutes, 2k × 5 = **10k fans** are on the booking pages at once, a load the system is sized for.

## Holds in Redis: one fan per seat

A hold is a Redis key per seat, set only if nobody holds it:

```text
SET hold:event-77:A-14 order-9001 NX EX 600
```

- `NX`: only set it if it doesn't exist. If Ravi already holds A-14, Asha's command fails, and she knows at once.
- `EX 600`: Redis deletes the key after 600 seconds (10 minutes). If Asha never pays, the seat returns to sale by itself.

For several seats, they must be held **all or none**: holding A-14 but not A-15 is useless to someone buying a pair. A short Lua script runs the check and the sets as one step, because Redis runs a script without letting other commands in between:

```lua
-- KEYS: the hold keys for the seats wanted; ARGV[1]: the order ID; ARGV[2]: seconds
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return 0 end -- one is taken: hold nothing
end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'EX', ARGV[2])
end
return 1
```

## The database has the final say

Redis is fast, but in a rare failover it can lose recent writes, so two fans could both think they hold A-14. That's why the sale itself is a **guarded update** in Postgres:

```sql
UPDATE seats
SET status = 'sold', order_id = 9001
WHERE event_id = 77 AND seat IN ('A-14', 'A-15') AND status = 'available';
-- rows changed must be 2; if it's less, someone else bought one: roll back and refund
```

`AND status = 'available'` is the guard. If another order already sold A-14, that row doesn't match, the update changes fewer rows than wanted, and the transaction rolls back. Whatever else fails, one seat can be sold only once. This is **optimistic** concurrency: no long locks, and losing a race just means 0 rows changed.

## Paying once, and cleaning up

- **Idempotent payment**: the order ID is sent to the payment provider as an **idempotency key**. If the network retries the charge, the provider sees the same key and doesn't charge again.
- **Holds that run out**: the **Hold Expiry Worker** marks pending orders whose hold time has passed as expired, so the database matches Redis.
- **Crash after charging**: if the Booking Service dies after the card was charged but before the seats were marked sold, the pending order plus the provider's charge ID let a recovery job finish the order or refund it. Never leave a paid fan without seats.
- **Tickets** are made and emailed from a queue, so a slow email provider can never block a sale.

## The numbers, worked out

- **Crowd**: 600k fans ÷ 18k seats = **33 fans per seat**. Most won't get one, so "sold out" must be fast and clear.
- **Fans shopping at once**: 2k admitted a minute × 5 minutes each = **10k**.
- **Seat-map reads**: 10k fans refreshing every 5 seconds = 2k reads a second. A 2-second cache turns that into about one database read per event every 2 seconds.
- **Orders**: 18k seats ÷ 2.5 seats an order = **7,200 orders**. If 4 in 10 admitted fans buy, 7,200 ÷ 0.4 = 18k fans must be admitted: 18k ÷ 2k a minute = **9 minutes** to sell out. The other 582k fans (97%) see "sold out".
- **Payments**: 7,200 orders in 540 seconds ≈ **13 a second** on average; plan for about 40 a second at the peak.
- **Storage**: 18k seats × 64 bytes = 1.15 MB a show; 5k shows a year = 90 million rows ≈ 5.8 GB. Tiny. The hard part is **contention** (many people wanting the same row), not size.

## What it costs and where it stops

- **Hold length is a trade-off**: 10 minutes is kind to slow payers but keeps seats off sale; shorter is faster but fans lose seats mid-payment. Show a countdown.
- **A Redis failover** can let two fans hold one seat; the guarded update lets the first payer win, and the second is refunded and offered other seats. Rare, and safe.
- **Bots** buy seats to resell. The waiting room, passes, login and rate limits make it harder.
- **One huge show** can slow others; split the database by event ID, and keep one event's hold keys on one Redis server so the multi-seat script stays atomic.

## How to choose

- **Numbered seats?** Redis holds with `NX EX`, plus a guarded update in the database.
- **General admission (no seat numbers)?** Just a counter of tickets left, changed by one atomic update: `UPDATE shows SET left = left - 2 WHERE id = 77 AND left >= 2`.
- **A few hundred buyers, no rush?** Skip the waiting room and Redis: a database transaction with `SELECT … FOR UPDATE` is enough.
- **Huge on-sale events?** Waiting room first; it protects everything behind it.

## ⚠️ Critical Mistakes

- **Read "is it free?", then write "sold" in two steps.** Two fans both read free. Use a guarded update or `SET NX`.
- **Trusting Redis alone for sales.** A failover can lose a hold. The database must have the final say.
- **Holds without an expiry.** Unpaid seats are off sale for ever.
- **Holding seats one at a time.** A fan ends up with half a pair. Hold all or none.
- **Charging without an idempotency key.** A network retry charges the fan twice.
- **Sending tickets inside the payment request.** A slow email service breaks sales.

## Interview Q&As

**Q: How do you guarantee a seat is never sold twice?**

A: The sale is one guarded update in the database: `UPDATE seats SET status = 'sold' WHERE seat = 'A-14' AND status = 'available'`, and you check that the number of rows changed equals the seats wanted. Only one update can match an available seat. Redis holds make conflicts rare, but the database guarantees it.

**Q: Why keep holds in Redis instead of the database?**

A: Holds are temporary and very busy. Redis answers in microseconds, and its keys expire on their own, which is exactly what a 10-minute hold needs. The permanent sale stays in the database.

**Q: 600k fans arrive at 10:00. How do you stay up?**

A: A waiting room lets them in at 2k a minute with signed passes, so the booking system only sees about 10k active fans. The seat map is cached for 2 seconds, and sold-out is shown quickly.

**Q: The service crashes after the card is charged but before seats are marked sold. What then?**

A: The pending order and the provider's charge ID survive. A recovery job finds paid-but-unfinished orders and either completes them with the guarded update or refunds them if the seats are gone.

## Related topics

- [Locking](/?topic=locking&read): `SELECT … FOR UPDATE`, optimistic updates and deadlocks.
- [Idempotent Payments](/?topic=payment-idempotency&read): charging once when the network retries.
- [Redis Basics](/?topic=redis-basics&read): `SET NX`, expiry and Lua scripts.
- [Rate Limiter](/?topic=rate-limiter&read): slowing down bots and heavy users.
- [Message Queue](/?topic=message-queue&read): sending tickets after the sale.

## Sources

- Redis: [SET command (NX and EX options)](https://redis.io/docs/latest/commands/set/)
- Redis: [Scripting with Lua](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
- PostgreSQL: [UPDATE](https://www.postgresql.org/docs/current/sql-update.html) and [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- Cloudflare: [Waiting Room](https://developers.cloudflare.com/waiting-room/)

## Why This Matters

"Design BookMyShow" or "design Ticketmaster" is a favourite interview question because it isolates one hard problem: many people competing for one exact item at the same instant. The answers here (a waiting room, expiring holds, a guarded update with the database as the final judge, idempotent payment) apply to any scarce item: flash sales, doctor's appointments, hotel rooms and limited coupons.
