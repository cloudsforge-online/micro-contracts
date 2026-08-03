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
  classifyEnvelope,
  envelopeDefects,
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

/**
 * The five topics live producers were emitting while this registry did not name them.
 *
 * Each line cites the emit site that decided it. This is the direction that fails silently in
 * production: the producer writes, signs and delivers the event, and every consumer refuses it
 * with "not in this registry" — `activity` cannot even reference the topic, because its classifier
 * table is `satisfies Record<TopicName, _>`. Nothing logs a defect; the fact simply never lands.
 */
test('the topics a producer already emits are named here', () => {
  for (const [name, emitSite] of [
    ['identity.session.revoked', 'identity/src/sessions.ts:395'],
    ['identity.mfa.added', 'identity/src/mfa.ts:563'],
    ['wallet.wallet.created', 'wallet/src/wallets.ts:214'],
    ['community.proposal.opened', 'community/src/jobs.ts:221'],
    ['community.vote.cast', 'community/src/votes.ts:227'],
  ] as const) {
    assert.equal(isRegisteredTopic(name), true, `${name} is emitted at ${emitSite} and unregistered`)
  }
})

/**
 * The three adopted from producer quarantines, pinned field for field.
 *
 * `isRegisteredTopic` returning true is NOT enough for these, and the reason is `custody`: both of
 * its ceremony topics were registered — a name check passed for the whole life of the service —
 * while `keyedBy` said `user_id` and the emit sites passed the ADDRESS. `activity` reads the
 * envelope key as the user id, so every export event was filed against a user that does not exist,
 * and nothing failed. A test that only asks "is it in the list" cannot see that class of defect.
 *
 * So this asserts the WHOLE spec, and the expected values here were read off the producer's emit
 * site rather than copied out of the registry a second time. Change any field of any of the three
 * and this goes red naming the emit site that disagrees.
 */
test('the three adopted proposals match the emit site they were read from', () => {
  assert.deepEqual(
    TOPICS['trade.bot.paused'],
    {
      producer: 'trade',
      payloadType: 'BotPaused',
      version: '1.0',
      // trade/src/bots.ts:614 — `key: bot.id`, payload `{ botId: bot.id }`, the only emit site.
      keyedBy: 'bot_id',
      description: 'A bot stopped trading.',
    },
    'trade/src/bots.ts:614 disagrees with the registered spec',
  )
  assert.deepEqual(
    TOPICS['devplatform.key.issued'],
    {
      producer: 'devplatform',
      payloadType: 'ApiKeyIssued',
      version: '1.0',
      // devplatform/src/apikeys.ts:272-274 — `key: key.id`, one payload builder.
      keyedBy: 'key_id',
      description: 'An API key was issued for a project, with its scopes and prefix.',
    },
    'devplatform/src/apikeys.ts:272 disagrees with the registered spec',
  )
  assert.deepEqual(
    TOPICS['devplatform.key.revoked'],
    {
      producer: 'devplatform',
      payloadType: 'ApiKeyRevoked',
      version: '1.0',
      // devplatform/src/apikeys.ts:357-359 — `key: key.id` from both callers (server.ts:965 and
      // server.ts:1527); only `actor` differs between them, and an actor is not a discriminator.
      keyedBy: 'key_id',
      description:
        'An API key was revoked. Every cache holding a verification result for it must drop it.',
    },
    'devplatform/src/apikeys.ts:357 disagrees with the registered spec',
  )
})

/**
 * The inventory, pinned.
 *
 * The same property the scope registry buys in `packages/auth`: a topic can be added or removed
 * only by editing this list in the same commit, so no wave of registrations lands without a reader
 * seeing the whole set change. It is also the one place that states, in one screen, what the bus
 * carries — the question every producer/consumer audit in this estate has started by asking.
 */
test('the registry is an enumerated inventory — every addition is deliberate', () => {
  assert.deepEqual([...TOPIC_NAMES].sort(), [
    'aetherholm.battle.resolved',
    'aetherholm.building.completed',
    'aetherholm.city.founded',
    'aetherholm.research.completed',
    'aetherholm.season.opened',
    'aetherholm.season.sealed',
    'aetherholm.skerry.provisioned',
    'aetherholm.spire.captured',
    'billing.entitlement.granted',
    'billing.entitlement.revoked',
    'community.proposal.executed',
    'community.proposal.opened',
    'community.vote.cast',
    'custody.export.requested',
    'custody.key.exported',
    'devplatform.key.issued',
    'devplatform.key.revoked',
    'emberkin.achievement.unlocked',
    'emberkin.battle.resolved',
    'emberkin.cosmetic.equipped',
    'emberkin.reward.granted',
    'emberkin.save.started',
    'emberkin.season.started',
    'identity.device.added',
    'identity.mfa.added',
    'identity.mfa.removed',
    'identity.session.created',
    'identity.session.revoked',
    'identity.user.deleted',
    'identity.user.registered',
    'ledger.entry.posted',
    'ledger.reconciliation.completed',
    'market.listing.sold',
    'mint.deploy.confirmed',
    'settlement.outbound.confirmed',
    'settlement.outbound.failed',
    'settlement.sweep.completed',
    'settlement.withdrawal.completed',
    'settlement.withdrawal.stuck',
    'trade.bot.paused',
    'wallet.deposit.confirmed',
    'wallet.wallet.created',
    'wallet.withdrawal.requested',
    'worlds.provision.completed',
    'worlds.provision.failed',
    'worlds.reward.granted',
    'worlds.title.registered',
  ])
})

/**
 * The keying decisions that were argued, pinned so they cannot be quietly reverted.
 *
 * Each of these three is a topic where the obvious key is the WRONG key, and the argument is in
 * the comment above the entry. Prose alone was not enough: the `settlement.sweep.completed` note
 * spent its life as an instruction naming a line in `micro-settlement`, stayed on the page after
 * settlement made the change, and read as outstanding work to everyone who found it afterwards.
 *
 * This asserts only the half a checkout of THIS repository can answer — that the registry still
 * says what was decided. Whether the producer still PASSES it is a question no test here can ask,
 * and `micro-org`'s `tools/estate-topics.mjs` asks it from a checkout that holds both halves.
 */
test('the keying decisions that were argued are still the ones registered', () => {
  // Not the outbound-row surrogate: that is unique per event, so it would give this topic no
  // ordering at all, while successive sweeps of ONE deposit address are the sequence that exists.
  assert.equal(TOPICS['settlement.sweep.completed'].keyedBy, 'sweep_source_id')
  // Not `user_id`, even though its siblings are: a session is the aggregate being revoked.
  assert.equal(TOPICS['identity.session.revoked'].keyedBy, 'session_id')
  // Not `community_id`, even though `community.proposal.executed` is: the family is split on
  // purpose, and a consumer assuming one keying for all three would mis-order two of them.
  assert.equal(TOPICS['community.vote.cast'].keyedBy, 'proposal_id')
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

/* ------------------------------------------------------------------ the envelope verdict */

/**
 * `market`, `trade`, `community` and `devplatform` each carried a byte-identical `envelopeDefects`
 * that told the two facts apart by comparing against the exact error SENTENCE. A prose message is
 * not an interface: reword it by one character and all four silently stop excusing anything.
 *
 * These tests are structural on purpose — not one of them asserts the wording of a message.
 */
const goodEnvelope = () =>
  JSON.parse(
    JSON.stringify(
      makeEvent({
        topic: 'ledger.entry.posted',
        key: 'acct-1',
        actor: 'service:ledger',
        correlationId: 'req-1',
        payload: {},
      }),
    ),
  ) as Record<string, unknown>

test('a well-formed envelope is valid, and carries the envelope back', () => {
  const verdict = classifyEnvelope(goodEnvelope())
  assert.equal(verdict.reason, 'valid')
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.defects, [])
  assert.equal(verdict.unregisteredTopic, null)
  assert.ok(verdict.ok && verdict.value.topic === 'ledger.entry.posted')
})

test('an unregistered topic and NOTHING ELSE is its own verdict, with no defects', () => {
  // A consumer behind its producer. This package is additive-only, so a topic it lacks is one
  // added after this build — quarantine it, do not drop it, and do not page anybody.
  const verdict = classifyEnvelope({ ...goodEnvelope(), topic: 'ledger.widget.frobnicated' })
  assert.equal(verdict.reason, 'unregistered_topic')
  assert.deepEqual(verdict.defects, [])
  assert.equal(verdict.unregisteredTopic, 'ledger.widget.frobnicated')
})

/**
 * THE DEFECT THAT TOOK FOUR SERVICES OFF THE BUS.
 *
 * `EventVersion` is `` `${number}.${number}` `` and several producers stamped the wire `version` as
 * the integer 1. Every consumer refuses at the envelope, so the event is never delivered at all —
 * and no per-service suite sees it, because each tests against its own fake.
 */
test('an integer version is malformed, not a lagging registry', () => {
  const verdict = classifyEnvelope({ ...goodEnvelope(), version: 1 })
  assert.equal(verdict.reason, 'malformed')
  assert.equal(verdict.unregisteredTopic, null)
  assert.ok(verdict.defects.some((d) => d.startsWith('version:')), verdict.defects.join('; '))
})

test('both at once reports both — a producer fixing this needs one round, not two', () => {
  const verdict = classifyEnvelope({
    ...goodEnvelope(),
    topic: 'ledger.widget.frobnicated',
    version: 1,
    correlationId: '',
  })
  assert.equal(verdict.reason, 'malformed')
  // The registration is still named, so the author is not sent to fix one thing twice.
  assert.equal(verdict.unregisteredTopic, 'ledger.widget.frobnicated')
  // Every problem, and the missing registration is NOT among them — it has its own field.
  assert.equal(verdict.defects.length, 2)
  assert.ok(verdict.defects.some((d) => d.startsWith('version:')))
  assert.ok(verdict.defects.some((d) => d.startsWith('correlationId:')))
  assert.ok(!verdict.defects.some((d) => d.includes('not in this registry')))
})

test('every verdict reason is reachable — none of the three is dead', () => {
  const reasons = new Set([
    classifyEnvelope(goodEnvelope()).reason,
    classifyEnvelope({ ...goodEnvelope(), topic: 'ledger.widget.frobnicated' }).reason,
    classifyEnvelope({ ...goodEnvelope(), version: 1 }).reason,
  ])
  assert.deepEqual([...reasons].sort(), ['malformed', 'unregistered_topic', 'valid'])
})

/**
 * `validateEnvelope` is unchanged by the split, including the ORDER and the WORDING of its errors.
 *
 * Four services and two consumers read that list today. The refactor that separated the registry
 * defect from the rest had to be invisible to them, and "invisible" is a claim worth checking
 * rather than asserting.
 */
test('validateEnvelope still reports the registry defect, first and worded as before', () => {
  const result = validateEnvelope({ ...goodEnvelope(), topic: 'ledger.widget.frobnicated', version: 1 })
  assert.equal(result.ok, false)
  assert.equal(
    (result as { errors: readonly string[] }).errors[0],
    'topic: "ledger.widget.frobnicated" is not in this registry; contracts-events may be behind',
  )
})

/**
 * The four copies, once.
 *
 * The producer names the topics it is waiting on registration for; nothing else is forgiven, and
 * the default forgives nothing. That last part is the half the duplicated version got right and
 * that a shared helper could easily get wrong.
 */
test('envelopeDefects excuses only the registrations the producer names', () => {
  const pending = { ...goodEnvelope(), topic: 'ledger.widget.frobnicated' }
  assert.deepEqual(envelopeDefects(pending, ['ledger.widget.frobnicated']), [])
  // Unexplained: a topic nobody proposed is a defect, not a lag.
  assert.equal(envelopeDefects(pending, ['ledger.other.thing']).length, 1)
  assert.equal(envelopeDefects(pending).length, 1, 'the default must forgive nothing')
  // And a real defect is never excused, even on a topic that IS awaiting registration.
  assert.ok(
    envelopeDefects({ ...pending, version: 1 }, ['ledger.widget.frobnicated']).some((d) =>
      d.startsWith('version:'),
    ),
  )
  assert.deepEqual(envelopeDefects(goodEnvelope()), [])
})

/**
 * THE CASE WHOSE ABSENCE LET THE WRAPPER SHIP LOSSY.
 *
 * `classifyEnvelope` has had "both at once reports both" since the day it landed, and it passes.
 * The flattening wrapper beside it branched on `verdict.reason` and returned only `verdict.defects`
 * for `malformed`, so the missing registration vanished the moment anything else was wrong — and
 * every assertion in this file stayed green, because not one of them ran the both-at-once envelope
 * THROUGH the wrapper. The four services adopting the primitive found it instead.
 *
 * The proof case is theirs verbatim: a topic that is neither registered nor proposed, on an
 * envelope that also stamps the wire `version` as the integer 1.
 */
test('envelopeDefects reports an unproposed topic AND a broken version together', () => {
  const both = { ...goodEnvelope(), topic: 'ledger.widget.frobnicated', version: 1 }
  const defects = envelopeDefects(both)
  assert.ok(
    defects.some((d) => d.startsWith('version:')),
    `the producer bug must be named: ${defects.join('; ')}`,
  )
  assert.ok(
    defects.some((d) => d.includes('ledger.widget.frobnicated')),
    `the missing registration must be named too: ${defects.join('; ')}`,
  )
  // The registry question comes first, as it does in validateEnvelope.
  assert.ok(defects[0]?.includes('ledger.widget.frobnicated'))

  // And the excusal still applies when the envelope is ALSO malformed: a producer that has proposed
  // the topic is told about its version bug and nothing else.
  // `version: missing` and not a parse error, because the integer is not a string at all — which
  // is exactly how this defect reads in a production rejection log.
  assert.deepEqual(envelopeDefects(both, ['ledger.widget.frobnicated']), ['version: missing'])
})

/**
 * The invariant that makes the wrapper worth keeping at all, stated so a future branch cannot
 * quietly swallow a fact again.
 *
 * With nothing excused, `envelopeDefects` is `validateEnvelope`'s error list — same messages, same
 * order. That is the whole of its contract: `validateEnvelope` plus one excusal list. Anything it
 * drops is a fact `validateEnvelope` reports and it does not, which is by definition the defect
 * this table exists to catch, whatever shape the next one takes.
 */
test('envelopeDefects is exactly validateEnvelope plus the excusal', () => {
  const cases: Record<string, unknown> = {
    'well formed': goodEnvelope(),
    'unregistered only': { ...goodEnvelope(), topic: 'ledger.widget.frobnicated' },
    'malformed only': { ...goodEnvelope(), version: 1 },
    'unregistered AND malformed': { ...goodEnvelope(), topic: 'ledger.widget.frobnicated', version: 1 },
    'unregistered AND several defects': {
      ...goodEnvelope(),
      topic: 'ledger.widget.frobnicated',
      version: 1,
      correlationId: '',
      key: '',
    },
    'topic name not even well formed': { ...goodEnvelope(), topic: 'Ledger.Widget', actor: 'nobody' },
    'not an object': 'a string',
  }
  for (const [name, value] of Object.entries(cases)) {
    const validated = validateEnvelope(value)
    const expected = validated.ok ? [] : validated.errors
    assert.deepEqual(
      envelopeDefects(value),
      expected,
      `${name}: the wrapper must report every error validateEnvelope does, in the same order`,
    )
  }
})
