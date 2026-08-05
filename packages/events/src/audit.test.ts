import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOPICS, TOPIC_NAMES, makeEvent, validateEnvelope, type TopicName } from './index.ts'
import { AUDITED_TOPICS, TOPIC_AUDIT, auditRowFor } from './audit.ts'

/**
 * The totality claim, at runtime.
 *
 * `satisfies Readonly<Record<TopicName, TopicAudit>>` is the compile half and it is the one that
 * actually blocks a topic being registered without a decision. This is the runtime half, and it
 * exists because the two can drift: a `TOPIC_AUDIT` entry for a topic that was later REMOVED from
 * the registry still satisfies the type, and would sit here as a decision about nothing.
 */
test('every registered topic has an audit decision, and every decision names a real topic', () => {
  const decided = Object.keys(TOPIC_AUDIT).sort()
  assert.deepEqual(decided, [...TOPIC_NAMES].sort())
  assert.equal(decided.length, 61, 'the topic registry changed; every addition needs a decision')
})

/**
 * `audited: false` is the answer a hurried author gives to a topic they have not thought about,
 * and a silent one is indistinguishable from a considered one. The same rule `contracts-auth`
 * applies to a deprecated scope: say why, at the length of a decision rather than a label.
 */
test('a topic that is not audited says why, at the length of a decision', () => {
  const excluded = TOPIC_NAMES.filter((name) => !TOPIC_AUDIT[name].audited)
  assert.ok(excluded.length > 0, 'nothing is excluded; this test is no longer checking anything')
  for (const name of excluded) {
    const spec = TOPIC_AUDIT[name]
    assert.equal(spec.audited, false)
    const why = spec.audited ? '' : spec.why
    assert.ok(
      why.length > 120,
      `${name} is excluded from the operator audit log without saying what carries it instead`,
    )
  }
})

test('the inventory of audited topics is pinned — a widening is deliberate', () => {
  assert.deepEqual([...AUDITED_TOPICS], [
    'aetherholm.skerry.provisioned',
    'billing.entitlement.granted',
    'billing.entitlement.revoked',
    'community.proposal.executed',
    'custody.export.requested',
    'custody.key.exported',
    'devplatform.key.issued',
    'devplatform.key.revoked',
    'emberkin.reward.granted',
    'identity.device.added',
    'identity.email.verification_requested',
    'identity.mfa.added',
    'identity.mfa.removed',
    'identity.session.revoked',
    'identity.user.deleted',
    'identity.user.registered',
    'ledger.entry.posted',
    'ledger.reconciliation.completed',
    'market.listing.sold',
    'mint.deploy.confirmed',
    'settlement.outbound.failed',
    'settlement.sweep.completed',
    'settlement.withdrawal.completed',
    'settlement.withdrawal.stuck',
    // The only one of Tessera's seven that is audited, and the widening IS deliberate: anchoring
    // writes an irreversible authorship claim to a public chain from a PLATFORM key on a user's
    // behalf, because a player cannot sign through custody today (23-tessera.md §9.3;
    // custody/src/gates.ts:31 excludes `user` from the signing purposes). That is the platform
    // acting with authority over a user's property, which is exactly what this log holds. The
    // other six are simulation and say so at the length of a decision.
    'tessera.object.anchored',
    'wallet.deposit.confirmed',
    'wallet.deposit_address.assigned',
    'wallet.link.revoked',
    'wallet.link.verified',
    'wallet.wallet.created',
    'wallet.withdrawal.refunded',
    'wallet.withdrawal.requested',
    'wallet.withdrawal.stuck',
    'worlds.provision.completed',
    'worlds.provision.failed',
    'worlds.reward.granted',
    'worlds.title.registered',
  ])
})

/**
 * The claim the whole design rests on: **the topic name IS the audit action.**
 *
 * `admin-api/src/audit.ts:70` documents `action` as `<service>.<aggregate>.<past-tense-verb>`, and
 * that is the topic naming rule here. If it were not — if a topic were two segments, or its first
 * segment were not its producer — then `auditRowFor` would be inventing an action rather than
 * reading one, and a second parallel `*.audit.recorded` stream would have been necessary after all.
 */
test('every audited topic name is already a valid audit action', () => {
  for (const name of AUDITED_TOPICS) {
    const parts = name.split('.')
    assert.equal(parts.length, 3, `${name} is not <service>.<aggregate>.<verb>`)
    assert.equal(parts[0], TOPICS[name].producer, `${name} does not start with its producer`)
    assert.ok(/^[a-z][a-z_]*$/.test(parts[2]!), `${name} does not end in a past-tense verb`)
  }
})

test('every audited topic names a subject kind in the console vocabulary', () => {
  for (const name of AUDITED_TOPICS) {
    const spec = TOPIC_AUDIT[name]
    assert.equal(spec.audited, true)
    const kind = spec.audited ? spec.subjectKind : ''
    // snake_case singular, as `admin-api/src/actions.ts` spells `ledger_entry` and
    // `moderation_case`. A plural or a camelCase here becomes a filter nobody can guess.
    assert.match(kind, /^[a-z][a-z_]*[a-z]$/, `${name} has subjectKind "${kind}"`)
    // A trailing `s` is the plural check, and `-ss` is the exception it needs rather than a hole
    // in it: `deposit_address` is a singular kind that ends in one, and so would `business` or
    // `status`. English has no plural ending in `ss`, so this rejects every collection and admits
    // every singular noun that happens to look like one.
    assert.ok(
      !kind.endsWith('s') || kind.endsWith('ss'),
      `${name}: subjectKind is a kind, not a collection`,
    )
  }
})

/**
 * The three failures. An operator filtering the log for what went wrong must find exactly these,
 * and finding them is the point: each is a customer who asked for something and did not get it.
 *
 * `settlement.outbound.failed` joined them with the settlement registration wave. It is the one
 * that carries a REMEDY as well as a fact — `refundable` is what wallet reads to decide whether the
 * reservation goes back to the user's balance (`wallet/src/server.ts:872`) — so it is the row an
 * operator needs to prove, afterwards, why money did or did not return.
 */
test('the only failed outcomes are the topics that report a non-event', () => {
  const failed = AUDITED_TOPICS.filter((name) => {
    const spec = TOPIC_AUDIT[name]
    return spec.audited && spec.outcome === 'failed'
  })
  assert.deepEqual(failed, [
    'settlement.outbound.failed',
    'settlement.withdrawal.stuck',
    // wallet's two, added with the five topics it emitted against a registry that knew three. Both
    // are money a customer asked for and did not get: a refund is the reservation coming back, and
    // `stuck` is it not coming back yet. An operator filtering the log for failures must find them.
    'wallet.withdrawal.refunded',
    'wallet.withdrawal.stuck',
    'worlds.provision.failed',
  ])
})

/* ------------------------------------------------------------------ the mapping */

const sample = (topic: TopicName, key: string) =>
  makeEvent({
    topic,
    key,
    // `producer` and `version` are NOT passed: `makeEvent` takes them from the registry, because
    // a producer that can name itself is a producer that can name itself wrongly. That is exactly
    // why the audit row's `source` needs no trust — it was never the sender's to claim.
    actor: 'user:11111111-2222-3333-4444-555555555555',
    correlationId: 'req-9f2c',
    payload: { amount: '1000' },
  })

/**
 * THE GUARD. Every column `admin-api`'s `appendAudit` demands is present and non-empty, taken from
 * an envelope built by this package's own `makeEvent` and checked by its own `validateEnvelope`.
 *
 * This is the assertion that would have caught the design being wrong. If any of these had to be
 * defaulted, guessed or left null, then the envelope does not carry what an audit row needs and a
 * separate audit stream would have been justified after all.
 */
test('an ordinary domain event carries every field an audit row needs', () => {
  const event = sample('ledger.entry.posted', 'acct-77')
  assert.ok(validateEnvelope(JSON.parse(JSON.stringify(event))).ok)

  const row = auditRowFor(event)
  assert.ok(row, 'ledger.entry.posted is audited and produced no row')
  assert.equal(row.action, 'ledger.entry.posted')
  assert.equal(row.subjectKind, 'ledger_entry')
  assert.equal(row.subjectId, 'acct-77')
  assert.equal(row.actor, 'user:11111111-2222-3333-4444-555555555555')
  assert.equal(row.source, 'ledger')
  assert.equal(row.outcome, 'allowed')
  assert.equal(row.sourceEventId, event.id)
  assert.equal(row.occurredAt, event.occurredAt)
  assert.deepEqual(row.payload, { amount: '1000' })

  // The one that claim 9 hangs on. It is free, because `validateEnvelope` already refuses an
  // envelope without a correlation id — "a cross-service investigation stops here".
  assert.equal(row.correlationId, 'req-9f2c')
})

test('every audited topic produces a complete row — none of them, not just the sample', () => {
  for (const name of AUDITED_TOPICS) {
    const row = auditRowFor(sample(name, `key-for-${name}`))
    assert.ok(row, `${name} is audited and produced no row`)
    for (const [field, value] of Object.entries(row)) {
      if (field === 'payload') continue
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `${name}: ${field} is empty, so the row would be unsearchable by it`,
      )
    }
  }
})

test('a topic that is not audited produces null, which the intake answers 202 to', () => {
  assert.equal(auditRowFor(sample('emberkin.battle.resolved', 'battle-1')), null)
  assert.equal(auditRowFor(sample('community.vote.cast', 'proposal-1')), null)
})

/**
 * An unregistered topic is `null`, not a throw.
 *
 * The same reasoning the registry already applies to an unknown topic: the consumer may simply be
 * behind the producer. A throw here would turn a lagging mirror into a 500 and make the producer's
 * relay retry for ever.
 */
test('an unregistered topic is ignored rather than fatal', () => {
  const stranger = { ...sample('ledger.entry.posted', 'k'), topic: 'ledger.audit.recorded' as TopicName }
  assert.equal(auditRowFor(stranger), null)
})

/**
 * The decision, pinned where it binds.
 *
 * `*.audit.recorded` is not a topic and must not become one. A parallel audit stream is a second
 * row, written by a second call site, that can disagree with the domain event it accompanies —
 * and an audit log that can disagree with the system it audits is worse than none, because it is
 * believed. The day someone registers one, this goes red and sends them to `audit.ts`'s header.
 */
test('there is no audit topic, and adding one is a decision this test forces', () => {
  for (const name of TOPIC_NAMES) {
    assert.ok(
      !name.includes('.audit.'),
      `${name} is a parallel audit stream; the argument against one is in audit.ts`,
    )
  }
})
