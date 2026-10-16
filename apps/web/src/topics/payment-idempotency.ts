import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura, not adapted from a source. Amounts are in paise, as
// payment APIs keep them, so money never passes through a float. Ids, times
// and hashes are fixed so the walkthrough reads the same every time.

type Step = Trace['steps'][number]

const N = {
  app: 'Mobile App',
  net: 'Internet (4G / Wi-Fi)',
  gateway: 'API Gateway',
  service: 'Payment Service',
  seen: 'Key Seen Before?',
  db: 'Payments DB (Postgres)',
  bank: 'Bank / Payment Network',
  webhook: 'Webhook Handler',
  queue: 'Payment Events Queue',
  notify: 'Notification Service',
  recon: 'Reconciliation Job',
} as const

const USER = 'u_8812'
const MERCHANT = { id: 'm_4471', name: 'Sharma General Store' }
/** Made once when the checkout opened, so every retry of this checkout carries it. */
const KEY = 'bb33e666-32f9-4974-b792-19a7a397bf7e'
const SHORT_KEY = `${KEY.slice(0, 8)}…`
const PAY_1 = 'pay_Q7mX2kd9aLr4'
const PAY_2 = 'pay_Q7mY8tLc0bWe'
// UPI reference numbers (RRNs) are 12 digits.
const RRN_1 = '428915736201'
const RRN_2 = '428915736488'
const APP_TIMEOUT_S = 15
const BANK_TIMEOUT_S = 10

const AMOUNTS: Record<string, number> = { '₹100': 10_000, '₹499': 49_900, '₹2,500': 250_000 }
/** sha256 of JSON.stringify(body(paise)), precomputed because run() must stay synchronous. */
const HASHES: Record<number, string> = {
  10_000: 'ea794073bbef14c2273ae878054b20e63330ac95f9c0d37116fa2a42260b839c',
  49_900: '24ff96d27bbf8f55c90e45acae7b7b0a34e8cefc1a8cc1e4cc46955e92c48f03',
  250_000: '9d79604aee4870f2edae11f1551ba6e13895a5a5d77adce7aa0c4b784ca2e99e',
}

const body = (paise: number) => ({ merchant_id: MERCHANT.id, amount_paise: paise, currency: 'INR', method: 'upi' })
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`

const START = 22 * 3600 + 41 * 60 + 7 // the customer taps Pay at 22:41:07 IST
const clock = (afterSeconds: number) => {
  const t = START + afterSeconds
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

const SCENARIOS = [
  'Nothing (happy path)',
  'Response lost on the way back',
  'Customer double-taps Pay',
  'Bank takes too long to answer',
]
const DESIGNS = ['With idempotency keys', 'Naive (no keys)']

const simulator: Simulator = {
  fields: [
    { id: 'scenario', label: 'What goes wrong', options: SCENARIOS },
    { id: 'design', label: 'Backend design', options: DESIGNS },
    { id: 'amount', label: 'Amount', options: Object.keys(AMOUNTS) },
  ],
  defaults: { scenario: 'Response lost on the way back', design: 'With idempotency keys', amount: '₹100' },
  run({ scenario, design, amount }) {
    const paise = AMOUNTS[amount] ?? AMOUNTS['₹100']
    const r = rupees(paise)
    const hash = HASHES[paise]
    const safe = design !== 'Naive (no keys)'
    const input = `${scenario}: ${r} to ${MERCHANT.name}, ${safe ? 'with idempotency keys' : 'naive design'}`

    const request = () => `POST /v1/payments\n${safe ? `Idempotency-Key: ${KEY}\n` : ''}${json(body(paise))}`
    const statement = (debits: [number, string][]) =>
      `Bank statement (to ${MERCHANT.name})\n${debits.map(([t, rrn]) => `${clock(t)}  UPI ${rrn}  −${r}`).join('\n')}\n\n` +
      `total debited: ${rupees(paise * debits.length)} (${debits.length} × ${r})`

    const tap = (): Step => ({
      text: safe
        ? `The customer taps Pay ${r}. The Mobile App made an idempotency key (a random UUID) when the checkout opened, and sends it in a header through the Internet (4G / Wi-Fi) to the API Gateway.`
        : `The customer taps Pay ${r}. The Mobile App sends the request through the Internet (4G / Wi-Fi) to the API Gateway. Nothing in it says which checkout or which attempt it is.`,
      nodes: [N.app, N.net, N.gateway],
      data: `${clock(0)}\n${request()}`,
    })

    const create = (id: string): Step =>
      safe
        ? {
            text: 'Key Seen Before? The Payment Service inserts the key and a new PENDING payment in one transaction. The idempotency_keys primary key is (user_id, idempotency_key), and this key is new, so the insert succeeds.',
            nodes: [N.service, N.seen, N.db],
            data:
              `request_hash = sha256(body) = ${hash.slice(0, 16)}…\n\n` +
              `BEGIN;\nINSERT INTO payments (payment_id, user_id, merchant_id, amount_paise, status)\nVALUES ('${id}', '${USER}', '${MERCHANT.id}', ${paise}, 'PENDING');\n` +
              `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, payment_id)\nVALUES ('${USER}', '${SHORT_KEY}', '\\x${hash.slice(0, 16)}…', '${id}');\nCOMMIT;  → 1 row each: a new key`,
          }
        : {
            text: 'The Payment Service creates a payment. With no key, it has no way to tell a first attempt from a retry, so every request becomes a new payment.',
            nodes: [N.service, N.db],
            data: `INSERT INTO payments (payment_id, user_id, merchant_id, amount_paise, status)\nVALUES ('${id}', '${USER}', '${MERCHANT.id}', ${paise}, 'PENDING');`,
          }

    const debit = (id: string, rrn: string, t: number): Step => ({
      text: safe
        ? `The Payment Service asks the Bank / Payment Network to debit ${r}, passing its payment id as the bank's own idempotency key, so retrying this call can't debit twice either. The bank debits the customer's account.`
        : `The Payment Service asks the Bank / Payment Network to debit ${r}, with its payment id as the reference. The bank debits the customer's account.`,
      nodes: [N.service, N.bank],
      data: `${clock(t)}  POST /bank/v1/debits\n${json({ reference: id, amount_paise: paise })}\n→ 200 ${json({ status: 'SUCCESS', rrn })}`,
    })

    const save = (id: string): Step => ({
      text: safe
        ? 'The Payment Service records SUCCEEDED and, in the same transaction, saves the exact response it is about to send against the key.'
        : 'The Payment Service records SUCCEEDED.',
      nodes: [N.service, N.db],
      data: safe
        ? `UPDATE payments SET status = 'SUCCEEDED' WHERE payment_id = '${id}';\nUPDATE idempotency_keys\nSET response_code = 200, response_body = '${JSON.stringify({ payment_id: id, status: 'SUCCEEDED' })}'\nWHERE user_id = '${USER}' AND idempotency_key = '${SHORT_KEY}';`
        : `UPDATE payments SET status = 'SUCCEEDED' WHERE payment_id = '${id}';`,
    })

    const paid = (id: string, text: string, data = ''): Step => ({
      text,
      nodes: [N.service, N.net, N.app],
      data: `HTTP/1.1 200 OK\n${json({ payment_id: id, status: 'SUCCEEDED', amount_paise: paise })}${data ? `\n\n${data}` : ''}`,
    })

    const refundDuplicate = (apart: string): Step => ({
      text: `The extra ${r} comes back only if the Reconciliation Job spots two payments with the same user, merchant and amount ${apart} apart and refunds one, usually the next day. If it doesn't, the customer has to complain.`,
      nodes: [N.recon, N.db, N.bank],
      data:
        `SELECT user_id, merchant_id, amount_paise, count(*)\nFROM payments WHERE status = 'SUCCEEDED' AND created_at > now() - interval '1 day'\n` +
        `GROUP BY user_id, merchant_id, amount_paise, date_trunc('minute', created_at)\nHAVING count(*) > 1;\n→ ${USER} | ${MERCHANT.id} | ${paise} | 2\n\n` +
        `POST /bank/v1/refunds ${JSON.stringify({ reference: PAY_2, amount_paise: paise })}`,
    })

    const steps: Step[] = []

    if (scenario === 'Response lost on the way back') {
      steps.push(tap(), create(PAY_1), debit(PAY_1, RRN_1, 2), save(PAY_1), {
        text: `The response leaves the server, but the phone loses signal (say, in a lift) and it never arrives. After ${APP_TIMEOUT_S} seconds the Mobile App gives up. The money has moved; the app just doesn't know.`,
        nodes: [N.net, N.app],
        data: `HTTP/1.1 200 OK  ✗ dropped on the way\n\n${clock(APP_TIMEOUT_S)}  app: timeout after ${APP_TIMEOUT_S} s\nserver: SUCCEEDED, ${r} debited\napp:    UNKNOWN`,
      })
      if (safe) {
        steps.push(
          {
            text: 'The Mobile App shows "Checking payment status…", not "failed", and retries after a 1-second backoff with the same key and the same body.',
            nodes: [N.app, N.net, N.gateway, N.service],
            data: `${clock(APP_TIMEOUT_S + 1)}  attempt 2\n${request()}`,
          },
          {
            text: 'Key Seen Before? Yes: the insert hits the primary key. The saved request hash matches, so this is the same request, and a response is already stored. The Payment Service replays it without calling the bank.',
            nodes: [N.service, N.seen, N.db],
            data:
              `INSERT INTO idempotency_keys … → ERROR 23505 unique_violation\n\nSELECT request_hash, response_code, response_body FROM idempotency_keys\nWHERE user_id = '${USER}' AND idempotency_key = '${SHORT_KEY}';\n\n` +
              `request_hash  ${hash.slice(0, 16)}… = ${hash.slice(0, 16)}…  ✓ same request\nresponse_code 200 → replay it, no bank call`,
          },
          {
            text: `The replayed response reaches the Mobile App: paid ${r}. Two requests, one debit.`,
            nodes: [N.service, N.net, N.app],
            data: `HTTP/1.1 200 OK\nIdempotent-Replayed: true\n${json({ payment_id: PAY_1, status: 'SUCCEEDED', amount_paise: paise })}\n\n${statement([[2, RRN_1]])}`,
          },
        )
      } else {
        steps.push(
          {
            text: 'The Mobile App can\'t tell a lost response from a failed payment, so it shows "Payment failed". The customer taps Pay again.',
            nodes: [N.app],
            data: `screen: ✗ Payment failed   [Try again]\nbank:   −${r} already debited (RRN ${RRN_1})`,
          },
          {
            text: 'The retry is a brand-new request, so the Payment Service creates a second payment and sends it to the Bank / Payment Network with a new reference. The bank has no reason to think it is a duplicate, and debits again.',
            nodes: [N.app, N.service, N.db, N.bank],
            data:
              `${clock(22)}  INSERT INTO payments … VALUES ('${PAY_2}', '${USER}', '${MERCHANT.id}', ${paise}, 'PENDING');\n` +
              `${clock(24)}  POST /bank/v1/debits ${JSON.stringify({ reference: PAY_2, amount_paise: paise })}\n→ 200 ${JSON.stringify({ status: 'SUCCESS', rrn: RRN_2 })}`,
          },
          paid(PAY_2, `This time the response arrives: paid ${r}. But the account has been debited twice.`, statement([[2, RRN_1], [24, RRN_2]])),
          refundDuplicate('22 seconds'),
        )
      }
      return { input, steps }
    }

    if (scenario === 'Customer double-taps Pay') {
      if (safe) {
        steps.push(
          {
            text: 'The customer taps Pay twice, 300 ms apart. Both requests carry the same idempotency key: the key belongs to the checkout, not to the tap.',
            nodes: [N.app, N.net, N.gateway],
            data: `${clock(0)}.000  request A\n${clock(0)}.300  request B\nboth carry Idempotency-Key: ${KEY}\n\n${json(body(paise))}`,
          },
          {
            text: 'Key Seen Before? Request A inserts the key and a PENDING payment. Request B\'s insert of the same key waits for A\'s transaction to commit, then fails on the primary key. The database, not a read-then-write check, decides who wins.',
            nodes: [N.service, N.seen, N.db],
            data: `A: INSERT payments ('${PAY_1}') + idempotency_keys ('${SHORT_KEY}')  → 1 row each\nB: INSERT idempotency_keys ('${SHORT_KEY}')  → waits for A, then ERROR 23505`,
          },
          {
            text: 'The key has no saved response yet, because A is still at the bank. So B gets 409 Conflict, and the Mobile App ignores it and waits for A\'s answer.',
            nodes: [N.seen, N.service, N.app],
            data: `SELECT response_code FROM idempotency_keys WHERE … → NULL (still in progress)\n\nHTTP/1.1 409 Conflict\n${json({ error: 'A request with this Idempotency-Key is still processing' })}`,
          },
          debit(PAY_1, RRN_1, 2),
          save(PAY_1),
          paid(
            PAY_1,
            `Request A's response reaches the Mobile App: paid ${r}. Two taps, one debit. Disabling the button after the first tap helps too, but it can't stop the app's own automatic retries; the key covers both.`,
            statement([[2, RRN_1]]),
          ),
        )
      } else {
        steps.push(
          {
            text: 'The customer taps Pay twice, 300 ms apart. The Mobile App sends two identical requests, and nothing links them.',
            nodes: [N.app, N.net, N.gateway],
            data: `${clock(0)}.000  request A: POST /v1/payments\n${clock(0)}.300  request B: POST /v1/payments\n\n${json(body(paise))}`,
          },
          {
            text: 'The Payment Service creates two payments, one per request.',
            nodes: [N.service, N.db],
            data: `INSERT INTO payments … VALUES ('${PAY_1}', '${USER}', '${MERCHANT.id}', ${paise}, 'PENDING');\nINSERT INTO payments … VALUES ('${PAY_2}', '${USER}', '${MERCHANT.id}', ${paise}, 'PENDING');`,
          },
          {
            text: 'Both go to the Bank / Payment Network with different references, so the bank debits both.',
            nodes: [N.service, N.bank],
            data: `POST /bank/v1/debits ${JSON.stringify({ reference: PAY_1, amount_paise: paise })} → SUCCESS, RRN ${RRN_1}\nPOST /bank/v1/debits ${JSON.stringify({ reference: PAY_2, amount_paise: paise })} → SUCCESS, RRN ${RRN_2}`,
          },
          paid(PAY_1, `The Mobile App shows paid ${r}, but the customer's account shows two debits.`, statement([[2, RRN_1], [2, RRN_2]])),
          refundDuplicate('0.3 seconds'),
        )
      }
      return { input, steps }
    }

    if (scenario === 'Bank takes too long to answer') {
      steps.push(tap(), create(PAY_1))
      if (safe) {
        steps.push(
          {
            text: `The Payment Service asks the Bank / Payment Network to debit ${r} but gets no answer within its ${BANK_TIMEOUT_S}-second timeout. It can't know whether the money moved, so the payment stays PENDING. A timeout is not a failure.`,
            nodes: [N.service, N.bank, N.db],
            data: `${clock(0)}  POST /bank/v1/debits\n${json({ reference: PAY_1, amount_paise: paise })}\n${clock(BANK_TIMEOUT_S)}  … no response after ${BANK_TIMEOUT_S} s\n\npayments.status stays 'PENDING'`,
          },
          {
            text: 'The Payment Service saves and sends 202 Accepted. The Mobile App shows "Payment processing. Don\'t pay again." and checks back every few seconds.',
            nodes: [N.service, N.db, N.net, N.app],
            data: `UPDATE idempotency_keys SET response_code = 202, … WHERE idempotency_key = '${SHORT_KEY}';\n\nHTTP/1.1 202 Accepted\n${json({ payment_id: PAY_1, status: 'PENDING' })}\n\nGET /v1/payments/${PAY_1}  (every 3 s)`,
          },
          {
            text: `At ${clock(12)} the bank finishes the debit, and its webhook arrives at ${clock(19)}. The Webhook Handler stores the event under the bank's event id (so a repeat delivery is ignored) and moves the payment from PENDING to SUCCEEDED.`,
            nodes: [N.bank, N.webhook, N.db],
            data:
              `POST /webhooks/bank\n${json({ event_id: 'evt_5521907', reference: PAY_1, status: 'SUCCESS', rrn: RRN_1 })}\n\n` +
              `INSERT INTO payment_events … ON CONFLICT (event_id) DO NOTHING;  → 1 row\nUPDATE payments SET status = 'SUCCEEDED', bank_ref = '${RRN_1}'\nWHERE payment_id = '${PAY_1}' AND status = 'PENDING';  → 1 row`,
          },
          {
            text: `The Webhook Handler publishes the change on the Payment Events Queue. The Notification Service sends "Paid ${r} to ${MERCHANT.name}", and the app's next status check shows paid.`,
            nodes: [N.webhook, N.queue, N.notify, N.app],
            data: `payment.succeeded ${JSON.stringify({ payment_id: PAY_1, amount_paise: paise, rrn: RRN_1 })}\npush → "Paid ${r} to ${MERCHANT.name}"\n\n${statement([[12, RRN_1]])}`,
          },
          {
            text: 'If the webhook had never come, the Reconciliation Job would find this payment still PENDING after 2 minutes and ask the bank\'s status API, using the same payment id. Either way, the payment ends in a final state.',
            nodes: [N.recon, N.db, N.bank],
            data: `SELECT payment_id FROM payments\nWHERE status = 'PENDING' AND created_at < now() - interval '2 minutes';\n\nGET /bank/v1/debits/${PAY_1}\n→ ${JSON.stringify({ status: 'SUCCESS', rrn: RRN_1 })}`,
          },
        )
      } else {
        steps.push(
          {
            text: `The bank doesn't answer within ${BANK_TIMEOUT_S} seconds. The naive Payment Service treats the timeout as a failure and marks the payment FAILED.`,
            nodes: [N.service, N.bank, N.db],
            data: `${clock(0)}  POST /bank/v1/debits ${JSON.stringify({ reference: PAY_1, amount_paise: paise })}\n${clock(BANK_TIMEOUT_S)}  … no response after ${BANK_TIMEOUT_S} s\n\nUPDATE payments SET status = 'FAILED' WHERE payment_id = '${PAY_1}';`,
          },
          {
            text: 'The Mobile App shows "Payment failed".',
            nodes: [N.service, N.net, N.app],
            data: `HTTP/1.1 502 Bad Gateway\n${json({ payment_id: PAY_1, status: 'FAILED' })}\n\nscreen: ✗ Payment failed   [Try again]`,
          },
          {
            text: `At ${clock(12)} the bank completes the debit anyway, and its webhook says SUCCESS. The customer has already been told it failed. Payment failed, money debited.`,
            nodes: [N.bank, N.webhook, N.db],
            data: `POST /webhooks/bank\n${json({ event_id: 'evt_5521907', reference: PAY_1, status: 'SUCCESS', rrn: RRN_1 })}\n\npayments.${PAY_1}: FAILED   bank: −${r}`,
          },
          {
            text: 'The customer pays again: a new payment with a new reference, and this time the bank answers in time.',
            nodes: [N.app, N.service, N.bank],
            data: `${clock(25)}  INSERT INTO payments … VALUES ('${PAY_2}', …, 'PENDING');\n${clock(27)}  POST /bank/v1/debits ${JSON.stringify({ reference: PAY_2, amount_paise: paise })}\n→ 200 ${JSON.stringify({ status: 'SUCCESS', rrn: RRN_2 })}`,
          },
          {
            text: `Two debits for one purchase. The first ${r} comes back only when the Reconciliation Job matches the day's bank settlement file against payments, finds a debit whose payment says FAILED, and refunds it, usually the next day.`,
            nodes: [N.recon, N.db, N.bank],
            data: `${statement([[12, RRN_1], [27, RRN_2]])}\n\nsettlement RRN ${RRN_1} SUCCESS ↔ payments.${PAY_1} FAILED → mismatch → refund ${r}`,
          },
        )
      }
      return { input, steps }
    }

    // Nothing goes wrong.
    steps.push(
      tap(),
      create(PAY_1),
      debit(PAY_1, RRN_1, 2),
      save(PAY_1),
      paid(
        PAY_1,
        `The response reaches the Mobile App: paid ${r}. When nothing goes wrong, both designs behave the same: one request, one debit. Change "What goes wrong" to see where they differ.`,
        statement([[2, RRN_1]]),
      ),
      {
        text: safe
          ? 'Seconds later the bank\'s webhook confirms the same payment. The Webhook Handler stores the event under the bank\'s event id, so a repeat delivery is ignored. Updates only move a payment forward from PENDING, and it is already SUCCEEDED, so nothing changes.'
          : 'Seconds later the bank\'s webhook confirms the same payment, and the Webhook Handler marks it SUCCEEDED again. Harmless here, but this handler applies every delivery, including late and repeated ones.',
        nodes: [N.bank, N.webhook, N.db],
        data: safe
          ? `POST /webhooks/bank\n${json({ event_id: 'evt_5521907', reference: PAY_1, status: 'SUCCESS', rrn: RRN_1 })}\n\nINSERT INTO payment_events … ON CONFLICT (event_id) DO NOTHING;  → 1 row\nUPDATE payments … WHERE payment_id = '${PAY_1}' AND status = 'PENDING';  → 0 rows`
          : `POST /webhooks/bank\n${json({ event_id: 'evt_5521907', reference: PAY_1, status: 'SUCCESS', rrn: RRN_1 })}\n\nUPDATE payments SET status = 'SUCCEEDED' WHERE payment_id = '${PAY_1}';  → 1 row`,
      },
    )
    return { input, steps }
  },
}

export const paymentIdempotency: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'payment-idempotency',
  title: 'Idempotent Payments',
  blurb: '"Payment failed" but money debited: lost responses, retries and idempotency keys',
  guides: [
    'how-to-avoid-double-payment',
    'top-6-cases-to-apply-idempotency',
    'payment-system',
    'reconciliation-in-payment',
    'how-do-we-retry-on-failures',
    'polling-vs-webhooks',
    'unified-payments-interface-upi-in-india',
  ],
  takeaways: [
    'A timeout is not a failure: the payment may have gone through, so the honest state is "unknown".',
    'Retrying an unknown outcome is only safe when the operation is idempotent: doing it twice has the same effect as doing it once.',
    'The client makes one idempotency key per checkout and sends it on every retry; the server stores the first response and replays it.',
    'Let the database enforce uniqueness with a primary key on the idempotency key, not a check followed by an insert.',
    'Make every hop idempotent: your payment id is the bank\'s key, and webhooks are deduplicated by event id.',
    'Webhooks and reconciliation drive every PENDING payment to a final state, and refund debits that should not have happened.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'backend', label: 'Payments backend' },
      { id: 'data', label: 'Storage' },
      { id: 'async', label: 'Async follow-up' },
    ],
    nodes: [
      { id: 'app', label: N.app, shape: 'ellipse', color: 'blue', group: null },
      { id: 'net', label: N.net, shape: 'cloud', color: 'light-blue', group: null },
      { id: 'gateway', label: N.gateway, shape: 'rectangle', color: 'violet', group: 'backend' },
      { id: 'service', label: N.service, shape: 'rectangle', color: 'violet', group: 'backend' },
      { id: 'seen', label: N.seen, shape: 'diamond', color: 'violet', group: 'backend' },
      { id: 'webhook', label: N.webhook, shape: 'rectangle', color: 'violet', group: 'backend' },
      { id: 'db', label: N.db, shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'bank', label: N.bank, shape: 'hexagon', color: 'grey', group: null },
      { id: 'queue', label: N.queue, shape: 'rectangle', color: 'yellow', group: 'async' },
      { id: 'notify', label: N.notify, shape: 'rectangle', color: 'light-violet', group: 'async' },
      { id: 'recon', label: N.recon, shape: 'rectangle', color: 'orange', group: 'async' },
    ],
    edges: [
      { from: 'app', to: 'net', label: 'POST /v1/payments', dashed: false },
      { from: 'net', to: 'gateway', label: 'Idempotency-Key header', dashed: false },
      { from: 'gateway', to: 'service', label: 'create payment', dashed: false },
      { from: 'service', to: 'seen', label: 'check key (seen: replay)', dashed: false },
      { from: 'seen', to: 'db', label: 'new: insert key + payment', dashed: false },
      { from: 'service', to: 'bank', label: 'debit (payment id as key)', dashed: false },
      { from: 'service', to: 'db', label: 'save result + response', dashed: false },
      { from: 'bank', to: 'webhook', label: 'webhook: final status', dashed: true },
      { from: 'webhook', to: 'db', label: 'dedupe by event id', dashed: false },
      { from: 'webhook', to: 'queue', label: 'payment.succeeded', dashed: false },
      { from: 'queue', to: 'notify', label: 'status changes', dashed: false },
      { from: 'recon', to: 'db', label: 'find stuck PENDING', dashed: false },
      { from: 'recon', to: 'bank', label: 'status check', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'payments',
        name: 'payments',
        columns: [
          { name: 'payment_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'merchant_id', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'amount_paise', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'bank_ref', type: 'text', pk: false, fk: null, nullable: true, unique: true },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(status, created_at) — stuck PENDING payments', '(user_id, created_at DESC) — payment history'],
      },
      {
        id: 'idempotency_keys',
        name: 'idempotency_keys',
        columns: [
          { name: 'user_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'idempotency_key', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'request_hash', type: 'bytea', pk: false, fk: null, nullable: false, unique: false },
          { name: 'payment_id', type: 'text', pk: false, fk: 'payments.payment_id', nullable: false, unique: true },
          { name: 'response_code', type: 'smallint', pk: false, fk: null, nullable: true, unique: false },
          { name: 'response_body', type: 'jsonb', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(created_at) — delete after 24 hours'],
      },
      {
        id: 'payment_events',
        name: 'payment_events',
        columns: [
          { name: 'event_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'payment_id', type: 'text', pk: false, fk: 'payments.payment_id', nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'source', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'received_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(payment_id, received_at) — status history'],
      },
    ],
    relations: [
      { from: 'idempotency_keys', to: 'payments', kind: 'one-to-one', label: 'created' },
      { from: 'payment_events', to: 'payments', kind: 'one-to-many', label: 'status updates' },
    ],
  },
  explanation: {
    title: 'Idempotent Payments',
    summary:
      'A payment can succeed at the bank while its response is lost on the way back, so the app cannot tell success from failure. If it retries as a new request, the customer pays twice. The fix: the app sends an idempotency key, the server remembers the first result for that key and replays it, and a timeout is treated as "pending" and settled later by webhooks and reconciliation.',
    sections: [
      {
        heading: 'Overview',
        body: 'An operation is idempotent when doing it twice has the same effect as doing it once. Setting your name is idempotent; "debit ₹100" is not.\n\nEvery network call ends in one of three ways: success, failure, or no answer. No answer is the dangerous one. The request may never have arrived, or it may have done its work and only the response got lost. From the phone, these look identical.\n\nThe only safe move with "no answer" is to ask again. That is only safe if asking again cannot do the work twice. HTTP GET, PUT and DELETE are idempotent by design; POST, which creates a payment, is not. An idempotency key makes it so: the client labels the request, and the server promises that any number of requests with the same label have the effect of one.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A customer pays a merchant from a mobile app (UPI or card).\n- One checkout is never debited twice, however many times the app or the customer retries.\n- The app never says "failed" when the outcome is unknown.\n- Every payment reaches a final state (succeeded, failed or refunded) within minutes.\n\nOut of scope: fraud checks, settlement to merchants, currency conversion, the refunds screen.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Illustrative assumptions:\n- 10 million payments a day; peak traffic 5 times the average.\n- 1% of requests time out on the phone and get retried.\n- 0.5% of bank calls time out on the server.\n- Keys are kept for 24 hours.\n\nWhich works out to:\n- About 116 payments a second on average, 580 at peak.\n- 10 million live keys at about 300 bytes each (key, hash, saved response, index): about 3 GB. One Postgres primary holds that easily.\n- 100,000 retries a day. Without keys, each retry whose first attempt had gone through is a second debit. If half had, that is 50,000 double debits: ₹2.5 crore a day at an average of ₹500.\n- 50,000 PENDING payments a day for webhooks and the Reconciliation Job to settle, about 35 a minute.',
      },
      {
        heading: 'Step by step',
        body: '1. The Mobile App makes an idempotency key (a random UUID) when the checkout opens, and sends it with POST /v1/payments through the Internet (4G / Wi-Fi) to the API Gateway.\n2. The Payment Service asks Key Seen Before? by inserting the key, together with a new PENDING payment, into the Payments DB (Postgres) in one transaction.\n3. For a new key, the Payment Service asks the Bank / Payment Network to debit, passing its payment id as the bank\'s own idempotency key.\n4. It saves the result on the payment, and stores the response it is about to send against the key.\n5. If that response is lost, the Mobile App retries with the same key. Key Seen Before? says yes, and the saved response is replayed without calling the bank.\n6. If the bank does not answer in time, the payment stays PENDING and the app is told "processing", never "failed".\n7. The bank\'s webhook reaches the Webhook Handler, which ignores repeats by event id, settles the payment and publishes to the Payment Events Queue.\n8. The Notification Service tells the customer, and the Reconciliation Job asks the bank about any payment still PENDING after two minutes.',
      },
      {
        heading: 'Components',
        body: '- Mobile App: makes one idempotency key per checkout, retries with backoff, and shows "checking status" when it cannot tell what happened.\n- Internet (4G / Wi-Fi): the unreliable link where requests and responses get dropped.\n- API Gateway: TLS, authentication and rate limits; passes the Idempotency-Key header through untouched.\n- Payment Service: creates payments, calls the bank, and stores the response for each key.\n- Key Seen Before?: the duplicate check, done by the database\'s primary key rather than by reading first and writing after.\n- Payments DB (Postgres): payments, idempotency keys and status events; the source of truth.\n- Bank / Payment Network: moves the money over UPI or card rails, deduplicating on our payment id.\n- Webhook Handler: receives the bank\'s final status, at least once, and drops repeats by event id.\n- Payment Events Queue: carries status changes to everything that reacts to them.\n- Notification Service: sends the "paid" or "refunded" push and SMS.\n- Reconciliation Job: chases payments stuck in PENDING and, daily, matches every payment against the bank\'s settlement file.',
      },
      {
        heading: 'Key decisions',
        body: '- The client makes the key, because only the client knows two requests are the same intent. One key per checkout, not per tap or per attempt, and kept across app restarts.\n- A unique constraint, not "check, then insert". Two simultaneous requests can both pass a check; only one can win an insert on a primary key.\n- Store the response, not just "seen". A retry gets exactly the first answer, status code included, so the client logic stays simple.\n- Hash the request body. The same key with a different amount is a client bug: reject it with 422 instead of replaying the wrong payment.\n- A timeout means unknown. Mark the payment PENDING, answer 202, and let webhooks and reconciliation decide. Never fail it on a guess.\n- Idempotency at every hop. The payment id is the bank\'s key, so the server\'s own retries to the bank are safe, and webhooks are deduplicated by event id.\n- Scope keys per user and keep them 24 hours: long enough to outlive any retry, short enough to keep the table small.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A crash after the key is saved but before a response is stored leaves the key "in progress" forever. Give in-progress keys a lease (say 60 seconds); after it expires, the next retry takes over and continues the same payment. That is safe because the bank call reuses the payment id.\n- Webhooks are delivered at least once and can arrive out of order. Deduplicate by event id, and only move a payment forward from PENDING.\n- Shard by user_id. The key\'s primary key starts with user_id, so a key and its payment live on the same shard and the insert stays one local transaction.\n- Keys in Redis are faster, but Redis and the payments table can disagree after a crash. If you use it, use it as a lock and keep the database as the record.\n- Reconciliation is the safety net. Every day, compare each payment with the bank\'s settlement file and fix every mismatch. In India, RBI rules (2019) require a UPI merchant payment that debited the customer but was never confirmed to the merchant to be reversed within T+5 days, where T is the day of the payment, with ₹100 a day in compensation after that.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- The app is killed mid-payment and reopened. How does it find the key it used?\n- The client reuses a key with a different amount. What do you return, and why not just replay?\n- A retry arrives after the key has expired. What happens, and how long should keys live?\n- The webhook says SUCCESS but the status API says FAILED. Which do you trust?\n- How is "exactly once" different from "at least once, plus idempotency"?\n- Two devices of the same user pay the same order at once. What stops a double debit?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Idempotent POST /v1/payments',
        language: 'typescript',
        source: `import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'

const db = new pg.Pool()
type Bank = { debit(reference: string, paise: number): Promise<'SUCCEEDED' | 'FAILED'> }
type Body = { merchant_id: string; amount_paise: number; currency: string; method: string }

/** Repeating this with the same Idempotency-Key never debits twice. */
export async function createPayment(bank: Bank, userId: string, key: string, body: Body) {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest()
  const paymentId = 'pay_' + randomBytes(9).toString('base64url')
  try {
    // One statement: the payment and its key are saved together or not at all.
    await db.query(
      \`WITH p AS (INSERT INTO payments (payment_id, user_id, merchant_id, amount_paise, status)
                  VALUES ($3, $1, $5, $6, 'PENDING'))
       INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, payment_id) VALUES ($1, $2, $4, $3)\`,
      [userId, key, paymentId, hash, body.merchant_id, body.amount_paise],
    )
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err // 23505 = unique_violation: key seen before
    const { rows: [seen] } = await db.query(
      'SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
      [userId, key],
    )
    if (!hash.equals(seen.request_hash)) return { status: 422, body: { error: 'Key reused for a different payment' } }
    if (seen.response_code === null) return { status: 409, body: { error: 'Still processing, retry shortly' } }
    return { status: seen.response_code, body: seen.response_body } // replay: the bank is not called again
  }
  // Our payment id is the bank's idempotency key, so retrying this call is safe too.
  const status = await bank.debit(paymentId, body.amount_paise).catch(() => 'PENDING' as const) // timeout ≠ failed
  const response = { status: status === 'PENDING' ? 202 : 200, body: { payment_id: paymentId, status } }
  await db.query(
    \`WITH p AS (UPDATE payments SET status = $4, updated_at = now() WHERE payment_id = $3 AND status = 'PENDING')
     UPDATE idempotency_keys SET response_code = $5, response_body = $6 WHERE user_id = $1 AND idempotency_key = $2\`,
    [userId, key, paymentId, status, response.status, response.body],
  )
  return response
}`,
      },
      {
        title: 'Client: one key, safe retries',
        language: 'typescript',
        source: `/**
 * Make the key when the checkout opens and keep it, even across app restarts:
 * every attempt for this checkout must send the same one.
 */
export async function pay(key: string, order: { merchant_id: string; amount_paise: number }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) // 1 s, 2 s, 4 s, 8 s
      // Jitter: thousands of phones that lost signal together shouldn't retry together.
      await new Promise((resolve) => setTimeout(resolve, backoff / 2 + (Math.random() * backoff) / 2))
    }
    try {
      const res = await fetch('/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ ...order, currency: 'INR', method: 'upi' }),
        signal: AbortSignal.timeout(15_000),
      })
      // 200 paid, 202 processing, other 4xx a definite no. 409 and 5xx: ask again.
      if (res.status !== 409 && res.status < 500) return { status: res.status, body: await res.json() }
    } catch {
      // Timeout or dropped connection: the payment may have happened. Never show "failed" here.
    }
  }
  // Show "checking status". Calling pay() again later with the same key is the status check.
  return { status: 0, body: { status: 'UNKNOWN' } }
}`,
      },
      {
        title: 'The idempotency_keys table',
        language: 'sql',
        source: `CREATE TABLE idempotency_keys (
  user_id          text        NOT NULL,
  idempotency_key  uuid        NOT NULL,
  request_hash     bytea       NOT NULL,  -- same key, different body → 422
  payment_id       text        NOT NULL UNIQUE REFERENCES payments (payment_id),
  response_code    smallint,              -- NULL while the first request is running
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Scoped per user, so one user's key can never collide with another's.
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX ON idempotency_keys (created_at);

-- Keys only need to outlive any retry: a nightly job removes them after 24 hours.
DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';`,
      },
      {
        title: 'Webhook dedupe and reconciliation',
        language: 'sql',
        source: `-- Webhooks arrive at least once: the bank's event id makes a repeat a no-op.
-- $1 event_id, $2 payment_id, $3 status
INSERT INTO payment_events (event_id, payment_id, status, source, received_at)
VALUES ($1, $2, $3, 'webhook', now())
ON CONFLICT (event_id) DO NOTHING;

-- Only move forward from PENDING, so a late or repeated event can't undo a final state.
-- $1 payment_id, $2 status, $3 bank_ref
UPDATE payments
SET status = $2, bank_ref = $3, updated_at = now()
WHERE payment_id = $1 AND status = 'PENDING';

-- Reconciliation job, every minute: payments the bank hasn't confirmed in 2 minutes.
-- For each, it asks the bank's status API with the same payment id, then applies
-- the answer with the two statements above (source = 'recon').
SELECT payment_id, amount_paise, created_at
FROM payments
WHERE status = 'PENDING' AND created_at < now() - interval '2 minutes'
ORDER BY created_at
LIMIT 500;`,
      },
    ],
    related: ['Idempotency', 'Exponential backoff and jitter', 'Webhooks', 'Exactly-once delivery', 'Payment reconciliation', 'Sagas'],
  },
  simulator,
}
