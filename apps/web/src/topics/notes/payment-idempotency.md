# Idempotent Payments

> 💡 **TL;DR**: An action is **idempotent** when doing it twice has the same effect as doing it once. "Set my name to Asha" is idempotent; "debit ₹499" is not. On a phone network, a payment request sometimes gets **no answer**: maybe it never arrived, maybe it worked and only the reply was lost. The only safe move is to ask again, and that's only safe if asking again can't charge twice. So the app makes an **idempotency key** (a random ID) once per checkout and sends it with every attempt. The server saves the key **together with** the new payment in one database step, guarded by a unique constraint, and saves the reply it sent. A repeat with the same key gets the saved reply, and the bank is never called again. A timeout means **unknown**, never "failed": the payment stays `PENDING` until the bank's webhook or a reconciliation job settles it.

## At a glance

| Question | Answer |
|---|---|
| Idempotent | Doing it twice has the same effect as doing it once |
| The danger | "No answer": you can't tell "never happened" from "happened, reply lost" |
| Idempotency key | A random ID the app makes once per checkout and sends with every attempt |
| Duplicate check | A unique key in the database, not "check, then insert" |
| A repeat gets | The exact reply the first attempt got; the bank isn't called again |
| Same key, different amount | Rejected with 422: it's a bug, not a retry |
| Bank doesn't answer | The payment stays `PENDING`; the app shows "processing" |
| Settling `PENDING` | The bank's webhook, then a reconciliation job that asks the bank |
| Key lifetime | 24 hours, per user |
| Every hop | Our payment ID is the bank's idempotency key; webhooks are de-duplicated by event ID |

## What idempotent means, and why payments need it

Every network call ends one of three ways: **success**, **failure**, or **no answer**. No answer is the dangerous one. The request may never have reached the server, or the server may have charged the card and only the reply got lost on a weak 4G signal. From the phone, both look the same.

If the app doesn't retry, a customer who wasn't charged sees nothing happen. If it retries naively, a customer who *was* charged pays twice. Neither is acceptable.

HTTP's `GET`, `PUT` and `DELETE` are idempotent by design; `POST`, which creates a payment, is not. An **idempotency key** makes it so: the app labels the request, and the server promises that any number of requests with the same label have the effect of one.

## Follow one payment all the way through

At 22:41:07, Asha pays ₹499 to Sharma General Store. The app made the key `bb33e666-32f9-4974-b792-19a7a397bf7e` when the checkout opened. The reply to her first attempt is lost.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The app sends `POST /v1/payments` with `Idempotency-Key: bb33e666…` | Mobile App → Internet (4G / Wi-Fi) → API Gateway |
| 2 | The key and a new `PENDING` payment `pay_Q7mX2kd9aLr4` are inserted in one transaction: the key is new | Payment Service → Key Seen Before? → Payments DB (Postgres) |
| 3 | The bank is asked to debit ₹499, with `pay_Q7mX2kd9aLr4` as the bank's own idempotency key | Bank / Payment Network |
| 4 | The bank says success; the payment and the saved reply (`200`, succeeded) are stored | Payments DB (Postgres) |
| 5 | The reply is lost on the way back; after 15 seconds the app gives up waiting | Internet (4G / Wi-Fi) |
| 6 | The app retries after a short wait, with the **same** key | Mobile App → API Gateway |
| 7 | The insert fails on the unique key: seen before. The request matches, so the saved reply is sent back. The bank is not called | Key Seen Before? → Payments DB (Postgres) |
| 8 | The bank's webhook confirms the payment; repeats of it are ignored by event ID | Webhook Handler |
| 9 | "Paid ₹499" goes to Asha | Payment Events Queue → Notification Service |

Asha was charged once. Without the key, step 6 would have created a second payment and a second debit.

## The key: who makes it, and when

- **The app makes it**, because only the app knows two requests are the same intent. It's a **UUID** (universally unique identifier: a random 128-bit ID), so two checkouts never clash.
- **One per checkout**, not per tap and not per attempt. A double tap or a retry must send the same key.
- **Kept across app restarts**: save it with the checkout, so if the app is killed mid-payment, the reopened app sends the same key.
- **Scoped per user, kept 24 hours**: long enough to outlive any retry, short enough to keep the table small.

## The server: insert first, then decide

The tempting code is "look the key up; if it's not there, create the payment". Two requests arriving together (a double tap) can both look, both find nothing and both charge. The safe way is to **insert** the key, with the database's unique constraint as the judge: only one insert can win.

This JavaScript handler (Node.js with the `pg` Postgres library) saves the key and the payment in one statement, so they exist together or not at all:

```javascript
export async function createPayment(bank, userId, key, body) {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest()
  const paymentId = 'pay_' + randomBytes(9).toString('base64url')
  try {
    await db.query(
      `WITH p AS (INSERT INTO payments (payment_id, user_id, merchant_id, amount_paise, status)
                  VALUES ($3, $1, $5, $6, 'PENDING'))
       INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, payment_id) VALUES ($1, $2, $4, $3)`,
      [userId, key, paymentId, hash, body.merchant_id, body.amount_paise],
    )
  } catch (err) {
    if (err.code !== '23505') throw err // 23505 = unique_violation: key seen before
    const { rows: [seen] } = await db.query(
      'SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
      [userId, key],
    )
    if (!hash.equals(seen.request_hash)) return { status: 422, body: { error: 'Key reused for a different payment' } }
    if (seen.response_code === null) return { status: 409, body: { error: 'Still processing, retry shortly' } }
    return { status: seen.response_code, body: seen.response_body } // replay: the bank is not called again
  }
  const status = await bank.debit(paymentId, body.amount_paise).catch(() => 'PENDING') // timeout ≠ failed
  const response = { status: status === 'PENDING' ? 202 : 200, body: { payment_id: paymentId, status } }
  await saveResult(userId, key, paymentId, status, response)
  return response
}
```

What the less obvious parts mean:

- `sha256` makes a fingerprint of the request body. The **same key with a different amount** is a bug in the app; replaying the old payment would be wrong, so the server answers **422** (unprocessable).
- `23505` is Postgres's error code for "this unique key already exists".
- `response_code === null` means the first attempt is still running; the server answers **409** (conflict), and the app tries again shortly.
- Amounts are stored in **paise** (1 rupee = 100 paise): ₹499 is `49900`, so there are no rounding errors with decimals.
- A bank timeout becomes `PENDING` and the app gets **202** (accepted, still processing), never a failure.

## The app: retry safely

The app retries with the same key, waiting longer each time, with some randomness (**jitter**) so thousands of phones that lost signal together don't all retry at the same instant:

```javascript
export async function pay(key, order) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) // 1 s, 2 s, 4 s, 8 s
      await new Promise((resolve) => setTimeout(resolve, backoff / 2 + (Math.random() * backoff) / 2))
    }
    try {
      const res = await fetch('/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(order),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status !== 409 && res.status < 500) return { status: res.status, body: await res.json() }
    } catch {
      // Timeout or dropped connection: the payment may have happened. Never show "failed" here.
    }
  }
  return { status: 0, body: { status: 'UNKNOWN' } } // show "checking status"
}
```

Each wait is between half and all of 1, 2, 4 and 8 seconds. `AbortSignal.timeout(15_000)` gives up on an attempt after 15 seconds. Status 409 and the 500s (server errors) are worth asking again; any other answer is final. After 5 attempts the app shows "checking status", and calling `pay()` later with the same key is the status check.

## When the bank doesn't answer

If the bank gives no answer within 10 seconds, the money may or may not have moved. Marking the payment failed would be a guess, and if the money did move, Asha would pay again. So:

1. The payment stays `PENDING`; the app shows "processing".
2. The bank's **webhook** (a request the bank sends us with the final status) arrives later. It can arrive more than once and out of order, so the Webhook Handler ignores event IDs it has seen and only moves a payment forward from `PENDING`.
3. The **Reconciliation Job** asks the bank about any payment still `PENDING` after 2 minutes, and once a day compares every payment with the bank's settlement file.

Because our payment ID is the bank's idempotency key, our own retries to the bank are safe too: idempotency at **every hop**.

## The numbers, worked out

Example assumptions: 10 million payments a day, peak 5 times the average, 1% of requests retried by phones, 0.5% of bank calls timing out, keys kept 24 hours.

- **Payments a second**: 10 million ÷ 86,400 s ≈ **116**; peak 5 × 116 ≈ **580**.
- **Key storage**: 10 million live keys × about 300 bytes = **3 GB (gigabytes)**: one Postgres server holds it easily.
- **Retries**: 1% of 10 million = **100k a day**. Without keys, if half of them had already gone through, that's 50k double debits; at ₹500 each, **₹2.5 crore** (25 million rupees) charged twice every day.
- **Pending payments**: 0.5% × 10 million = 50k a day ÷ 1,440 minutes ≈ **35 a minute** for webhooks and reconciliation to settle.

## What it costs and where it stops

- **One extra row and one extra write per payment**, plus the stored reply. Small next to a double charge.
- **A crash between saving the key and saving the reply** leaves the key "in progress" for ever. Give in-progress keys a lease (say 60 seconds); after it, the next retry carries on with the same payment ID, which the bank also de-duplicates.
- **Keys expire**: a retry after 24 hours is treated as new. Apps don't retry that late.
- **Sharding**: the key's primary key starts with `user_id`; shard by user so the key and its payment live on the same server and the insert stays one local transaction.
- **Keys only in Redis** are faster, but Redis and the payments table can disagree after a crash. Use Redis as a lock at most; the database is the record.
- **Reconciliation is still required.** In India, the RBI (Reserve Bank of India) 2019 rules on failed transactions say a UPI (Unified Payments Interface) merchant payment that debited the customer but was never confirmed must be reversed within T+5 days (T is the payment day), with ₹100 a day in compensation after that.

## How to choose

- **Any `POST` that moves money or creates something once?** Idempotency keys, saved with the record in one transaction.
- **An update that's naturally idempotent** ("set status to shipped")? A plain `PUT`; no key needed.
- **Consuming events** that may arrive twice (webhooks, Kafka)? De-duplicate by the event's own ID.
- **Calling a provider** (Stripe, Razorpay, a bank)? Pass your own ID as their idempotency key, so your retries are safe.
- **Timeout from anything that moves money?** `PENDING`, then webhooks and reconciliation; never "failed".

## ⚠️ Critical Mistakes

- **Check, then insert.** Two simultaneous requests both pass the check. Let a unique constraint decide.
- **A new key per attempt or per tap.** Then every retry looks new. One key per checkout.
- **Saving only "seen", not the reply.** The retry can't tell the app what happened. Store and replay the reply.
- **Treating a timeout as failure.** The customer pays again, and both payments go through.
- **Ignoring a different body under the same key.** Replaying would confirm the wrong payment; answer 422.
- **Retrying the bank without its own idempotency key.** The server's own retry charges twice.
- **Processing webhooks without de-duplication.** A repeated "succeeded" sends two receipts or ships twice.

## Interview Q&As

**Q: Why must the client make the idempotency key?**

A: Only the client knows that two requests are the same intent. The server sees two identical requests and can't tell a retry from a customer buying twice. A key made once per checkout says "these are the same".

**Q: How do you stop two simultaneous requests with the same key from both charging?**

A: Insert the key with a unique constraint in the same transaction as the payment. Only one insert can succeed; the other gets a unique-violation error and either replays the saved reply or, if the first is still running, answers 409 so the client retries shortly.

**Q: The bank times out. What do you tell the customer?**

A: "Processing", with status 202. The payment stays `PENDING`. The bank's webhook or the reconciliation job decides the outcome, and the app shows it then. Saying "failed" would make the customer pay again.

**Q: How is "exactly once" different from "at least once plus idempotency"?**

A: Over an unreliable network you can't guarantee a message is delivered exactly once. What you can do is deliver it at least once (retry until you get an answer) and make the receiver idempotent, so repeats have no effect. The result looks like exactly once.

## Related topics

- [Retry with Backoff](/?topic=retry-backoff&read): waiting longer between tries, with jitter.
- [Ticket Booking System](/?topic=ticket-booking&read): the order ID as the payment key.
- [Kafka: Event Streaming](/?topic=kafka&read): at-least-once events and idempotent consumers.
- [Locking](/?topic=locking&read): unique constraints and concurrent writes.

## Sources

- IETF draft: [The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- Stripe: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- PostgreSQL: [Error codes (23505 unique_violation)](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- Reserve Bank of India: [Harmonisation of turn around time and customer compensation for failed transactions](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11693) (September 2019)

## Why This Matters

"How do you make sure a customer is never charged twice?" comes up in every payment, booking and checkout design. The answer is always the same pattern: a key from the client, a unique constraint on the server, a saved reply, `PENDING` for the unknown, and idempotency at every hop. It's also the pattern behind safe retries anywhere: queues, webhooks and any API that creates things.
