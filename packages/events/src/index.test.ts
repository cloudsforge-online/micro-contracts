import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELIVERY_TOLERANCE_MS,
  TOPICS,
  TOPIC_NAMES,
  acceptsVersion,
  eventId,
  inboxKey,
  isRegisteredTopic,
  isValidTopicName,
  makeEvent,
  parseActor,
  parseEvent,
  parseTopicName,
  parseVersion,
  relayShard,
  serialiseEvent,
  signDelivery,
  topicsProducedBy,
  validateEnvelope,
  verifyDelivery,
} from './index.ts'

const sample = () =>
  makeEvent({
    topic: 'wallet.deposit.confirmed',
    key: 'wallet-1',
    actor: 'system',
    payload: { amount: '1000' },
  })

// --- the registry ----------------------------------------------------------

test('every registered topic obeys the three-segment naming rule', () => {
  for (const name of TOPIC_NAMES) {
    assert.equal(isValidTopicName(name), true, `${name} is not a legal topic name`)
  }
})

test('a topic is owned by the service its first segment names', () => {
  for (const name of TOPIC_NAMES) {
    const parsed = parseTopicName(name)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(
      parsed.value.service,
      TOPICS[name].producer,
      `${name} is produced by ${TOPICS[name].producer}, which is not what its name says`,
    )
  }
})

test('the eight first events of 02 section 5 all exist', () => {
  for (const name of [
    'identity.user.deleted',
    'ledger.entry.posted',
    'billing.entitlement.granted',
    'wallet.deposit.confirmed',
    'settlement.withdrawal.completed',
    'mint.deploy.confirmed',
    'custody.key.exported',
    'identity.session.created',
  ]) {
    assert.equal(isRegisteredTopic(name), true, `${name} is missing from the registry`)
  }
})

test('every topic declares what its ordering key holds', () => {
  for (const name of TOPIC_NAMES) {
    assert.notEqual(TOPICS[name].keyedBy, '', `${name} does not say what it is keyed by`)
  }
})

test('the registry cannot be mutated by a consumer at runtime', () => {
  assert.throws(() => {
    // @ts-expect-error the registry is frozen and readonly; this is the runtime half
    TOPICS['wallet.deposit.confirmed'] = undefined
  })
})

test('topicsProducedBy returns only that service topics', () => {
  const identity = topicsProducedBy('identity')
  assert.ok(identity.includes('identity.user.deleted'))
  assert.ok(!identity.includes('ledger.entry.posted'))
})

// --- topic names -----------------------------------------------------------

test('a topic name with two or four segments is refused', () => {
  assert.equal(isValidTopicName('wallet.confirmed'), false)
  assert.equal(isValidTopicName('wallet.deposit.confirmed.v2'), false)
})

test('a topic name is lowercase only', () => {
  assert.equal(isValidTopicName('Wallet.deposit.confirmed'), false)
  assert.equal(isValidTopicName('wallet.deposit.Confirmed'), false)
})

test('an underscore inside a segment is allowed, a bare separator is not', () => {
  assert.equal(isValidTopicName('custody.export.requested'), true)
  assert.equal(isValidTopicName('ledger.reconciliation.drift_exceeded'), true)
  assert.equal(isValidTopicName('wallet..confirmed'), false)
  assert.equal(isValidTopicName('wallet.deposit.'), false)
})

test('parseTopicName explains the rule rather than returning null', () => {
  const parsed = parseTopicName('WALLET.DEPOSIT')
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.errors[0] ?? '', /past-tense-verb/)
})

// --- actors ----------------------------------------------------------------

test('system is an actor with no subject', () => {
  const parsed = parseActor('system')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.value, { kind: 'system', id: null })
})

test('an actor with an empty subject is refused — the undefined interpolation bug', () => {
  const parsed = parseActor('user:')
  assert.equal(parsed.ok, false)
})

test('an unknown actor kind is refused', () => {
  assert.equal(parseActor('robot:7').ok, false)
})

// --- ids -------------------------------------------------------------------

test('event ids are UUIDv7 and sort in the order they were minted', () => {
  const ids = Array.from({ length: 500 }, () => eventId())
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
  assert.deepEqual([...ids].sort(), ids, 'an outbox paged by id would skip rows')
})

test('a clock that steps backwards does not mint an id that sorts before existing rows', () => {
  const first = eventId(1_700_000_000_000)
  const second = eventId(1_600_000_000_000)
  assert.ok(second > first, 'the relay would page past the row and never deliver it')
})

// --- makeEvent -------------------------------------------------------------

test('makeEvent produces an envelope that validates', () => {
  const result = validateEnvelope(sample())
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '))
})

test('the producer is taken from the registry, not from the caller', () => {
  assert.equal(sample().producer, 'wallet')
  assert.equal(sample().version, '1.0')
})

test('an event without a correlation id becomes its own correlation root', () => {
  const event = sample()
  assert.equal(event.correlationId, event.id)
})

test('a supplied correlation id is carried through, so the trail survives the hop', () => {
  const event = makeEvent({
    topic: 'ledger.entry.posted',
    key: 'account-1',
    actor: 'service:wallet',
    payload: {},
    correlationId: 'req-abc',
  })
  assert.equal(event.correlationId, 'req-abc')
})

test('an empty key is refused at construction — ordering would be undefined', () => {
  assert.throws(
    () => makeEvent({ topic: 'ledger.entry.posted', key: '', actor: 'system', payload: {} }),
    /empty key/,
  )
})

test('a Date occurredAt is normalised to an ISO instant', () => {
  const event = makeEvent({
    topic: 'ledger.entry.posted',
    key: 'account-1',
    actor: 'system',
    payload: {},
    occurredAt: new Date(0),
  })
  assert.equal(event.occurredAt, '1970-01-01T00:00:00.000Z')
})

// --- validation ------------------------------------------------------------

test('serialise and parse round-trip an envelope unchanged', () => {
  const event = sample()
  const parsed = parseEvent(serialiseEvent(event))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.value, event)
})

test('a body that is not JSON is a validation failure, never a thrown SyntaxError', () => {
  const parsed = parseEvent('{oh dear')
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.errors[0] ?? '', /not JSON/)
})

test('validation reports every problem at once, not the first', () => {
  const result = validateEnvelope({ topic: 'nope', id: 'x', key: '', payload: null })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.length >= 4, `only got: ${result.errors.join('; ')}`)
})

test('a service may not publish under another service topic prefix', () => {
  const event = { ...sample(), producer: 'market' }
  const result = validateEnvelope(event)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('; '), /does not own topic/)
})

test('an unregistered topic says the consumer may be behind, not that the event is malformed', () => {
  const result = validateEnvelope({ ...sample(), topic: 'worlds.season.ended' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('; '), /contracts-events may be behind/)
})

test('an occurredAt without an offset is refused', () => {
  const result = validateEnvelope({ ...sample(), occurredAt: '2026-07-30 12:00:00' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('; '), /occurredAt/)
})

test('a missing correlation id is a validation failure', () => {
  const { correlationId, ...rest } = sample()
  void correlationId
  const result = validateEnvelope(rest)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('; '), /correlationId/)
})

test('a payload that is present but null is legal — absence is the error, not emptiness', () => {
  assert.equal(validateEnvelope({ ...sample(), payload: null }).ok, true)
})

test('an array is not an envelope', () => {
  assert.equal(validateEnvelope([]).ok, false)
})

// --- dedupe and sharding ---------------------------------------------------

test('the inbox key is unique on topic and event id together', () => {
  const a = sample()
  const b = { ...a, topic: 'mint.deploy.confirmed' as const }
  assert.notEqual(inboxKey(a), inboxKey(b))
  assert.equal(inboxKey(a), inboxKey({ ...a }))
})

test('a redelivery of the same event yields the same inbox key', () => {
  const event = sample()
  const redelivered = parseEvent(serialiseEvent(event))
  assert.equal(redelivered.ok, true)
  if (!redelivered.ok) return
  assert.equal(inboxKey(redelivered.value), inboxKey(event))
})

test('one topic and key always lease to one shard — this is what preserves ordering', () => {
  const first = relayShard('wallet.deposit.confirmed', 'wallet-1', 8)
  for (let i = 0; i < 50; i += 1) {
    assert.equal(relayShard('wallet.deposit.confirmed', 'wallet-1', 8), first)
  }
  assert.ok(first >= 0 && first < 8)
})

test('sharding spreads keys rather than piling them on one lease', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 200; i += 1) {
    seen.add(relayShard('wallet.deposit.confirmed', `wallet-${i}`, 8))
  }
  assert.equal(seen.size, 8)
})

test('a shard count below one is a programming error, not a modulo by zero', () => {
  assert.throws(() => relayShard('a.b.c', 'k', 0), RangeError)
})

// --- versions --------------------------------------------------------------

test('the same version is accepted', () => {
  assert.deepEqual(acceptsVersion('1.3', '1.3'), { accepted: true, reason: 'exact' })
})

test('a producer ahead by a minor is accepted — additive fields are ignorable', () => {
  const verdict = acceptsVersion('1.5', '1.3')
  assert.equal(verdict.accepted, true)
  if (!verdict.accepted) return
  assert.equal(verdict.reason, 'producer_ahead')
})

test('a consumer lagging two minors still reads the stream — AD-02 permits exactly this', () => {
  assert.equal(acceptsVersion('1.4', '1.2').accepted, true)
})

test('a producer behind by a minor is accepted; the added fields are simply absent', () => {
  const verdict = acceptsVersion('1.1', '1.4')
  assert.equal(verdict.accepted, true)
  if (!verdict.accepted) return
  assert.equal(verdict.reason, 'producer_behind')
})

test('a newer major is rejected rather than mis-read', () => {
  const verdict = acceptsVersion('2.0', '1.9')
  assert.equal(verdict.accepted, false)
  if (verdict.accepted) return
  assert.equal(verdict.reason, 'major_ahead')
})

test('an older major is rejected and named as a deploy-order fault', () => {
  const verdict = acceptsVersion('1.0', '2.0')
  assert.equal(verdict.accepted, false)
  if (verdict.accepted) return
  assert.equal(verdict.reason, 'major_behind')
  assert.match(verdict.detail, /deploy order/)
})

test('a version without a minor is not a version', () => {
  assert.equal(parseVersion('1').ok, false)
  assert.equal(parseVersion('1.2.3').ok, false)
  assert.equal(parseVersion('v1.0').ok, false)
})

// --- delivery signatures ---------------------------------------------------

const SECRET = 'sub_whsec_0123456789abcdef'

test('a signature made by the relay verifies at the subscriber', () => {
  const body = serialiseEvent(sample())
  const header = signDelivery(body, SECRET, 1_000_000_000_000)
  const result = verifyDelivery(body, header, SECRET, { now: 1_000_000_000_000 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.keyIndex, 0)
})

test('a body altered in transit fails verification', () => {
  const body = serialiseEvent(sample())
  const header = signDelivery(body, SECRET, 1_000_000_000_000)
  const tampered = body.replace('1000', '9999')
  const result = verifyDelivery(tampered, header, SECRET, { now: 1_000_000_000_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'mismatch')
})

test('the wrong secret fails — an unauthenticated POST cannot credit money', () => {
  const body = 'x'
  const header = signDelivery(body, SECRET, 1_000_000_000_000)
  const result = verifyDelivery(body, header, 'not-the-secret', { now: 1_000_000_000_000 })
  assert.equal(result.ok, false)
})

test('the timestamp cannot be moved without breaking the signature', () => {
  const body = 'x'
  const header = signDelivery(body, SECRET, 1_000_000_000_000)
  const moved = header.replace(/^t=\d+/, 't=1000000060')
  const result = verifyDelivery(body, moved, SECRET, { now: 1_000_000_060_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'mismatch')
})

test('a captured delivery replayed after the window is refused', () => {
  const body = 'x'
  const at = 1_000_000_000_000
  const header = signDelivery(body, SECRET, at)
  const result = verifyDelivery(body, header, SECRET, { now: at + DELIVERY_TOLERANCE_MS + 1_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'stale')
})

test('a delivery stamped far in the future is refused', () => {
  const body = 'x'
  const at = 1_000_000_000_000
  const header = signDelivery(body, SECRET, at + DELIVERY_TOLERANCE_MS + 1_000)
  const result = verifyDelivery(body, header, SECRET, { now: at })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'future')
})

test('a few seconds of clock skew either way still verifies', () => {
  const body = 'x'
  const at = 1_000_000_000_000
  const header = signDelivery(body, SECRET, at)
  assert.equal(verifyDelivery(body, header, SECRET, { now: at + 3_000 }).ok, true)
  assert.equal(verifyDelivery(body, header, SECRET, { now: at - 3_000 }).ok, true)
})

test('rotation: the previous secret still verifies and says which key matched', () => {
  const body = 'x'
  const at = 1_000_000_000_000
  const header = signDelivery(body, 'old-secret', at)
  const result = verifyDelivery(body, header, ['new-secret', 'old-secret'], { now: at })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.keyIndex, 1, 'a non-zero index is the signal that rotation is unfinished')
})

test('a malformed signature header is distinguished from a forged one', () => {
  const result = verifyDelivery('x', 'garbage', SECRET)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'malformed_header')
})

test('a header carrying only a future scheme reports the scheme, not a forgery', () => {
  const result = verifyDelivery('x', 't=1000000000,v2=abcdef', SECRET, { now: 1_000_000_000_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'unsupported_scheme')
})

test('a non-hex signature is malformed rather than compared', () => {
  const result = verifyDelivery('x', 't=1000000000,v1=zzzz', SECRET, { now: 1_000_000_000_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'malformed_header')
})

test('a signature of the wrong length does not throw out of timingSafeEqual', () => {
  const result = verifyDelivery('x', 't=1000000000,v1=ab', SECRET, { now: 1_000_000_000_000 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'mismatch')
})
