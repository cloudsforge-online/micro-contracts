/**
 * The operator audit log, fed from the bus that already exists.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DECISION: `*.audit.recorded` SHOULD NOT EXIST, AND IS NOT REGISTERED HERE.**
 *
 * `admin-api/src/server.ts:132` declares `AUDIT_MIRROR_TOPIC_SUFFIX = '.audit.recorded'` and its
 * intake at `:526` is built, signed, scoped and deduped correctly. That string appears in exactly
 * one non-test place in the whole estate — that declaration. **The mirror is a consumer with no
 * producer**, so the operator audit log holds `admin-api`'s own rows and nothing from `ledger`,
 * `wallet`, `settlement` or `custody`. `17-definition-of-done.md` §7 claim 9 — an operator answers
 * "where did this user's money go" from `admin-web` alone, by correlation id — cannot pass, and an
 * empty timeline currently *looks like an answer*.
 *
 * The obvious fix is to have each service emit an audit event beside its domain event. That is the
 * wrong fix, for a reason that is specific rather than aesthetic:
 *
 *   **A second stream can disagree with the first.** The estate's outbox writes the domain event in
 *   the SAME transaction as the state change (`withOutbox`), which is what makes a domain event a
 *   fact rather than a report. A parallel audit event is a second row, written by a second call
 *   site, with a second set of bugs — and the first time one is emitted and the other is not, the
 *   audit log disagrees with what happened. An audit log that can disagree with the system it
 *   audits is worse than no audit log, because it is believed.
 *
 * And it is unnecessary, which is the part that settles it. **Every field the mirror needs is
 * already on the wire, required, and signed:**
 *
 *   | `audit_events` column | where it already comes from |
 *   | --- | --- |
 *   | `actor`         | `EventEnvelope.actor` — required by `validateEnvelope` |
 *   | `correlationId` | `EventEnvelope.correlationId` — required, and never optional by design |
 *   | `occurredAt`    | `EventEnvelope.occurredAt` — the producer's own clock |
 *   | `source`        | `EventEnvelope.producer` |
 *   | `sourceEventId` | `EventEnvelope.id` — already the dedupe key of the inbox |
 *   | `action`        | **the topic name**. `<service>.<aggregate>.<past-tense-verb>` is the topic
 *                       naming rule here AND the `action` format `admin-api/src/audit.ts:70`
 *                       documents. They were already the same string. |
 *   | `subjectId`     | `EventEnvelope.key`, whose meaning `TopicSpec.keyedBy` already states |
 *
 * Exactly **one** fact is missing, and it is a property of the topic rather than of any consumer:
 * *is this fact one an operator must be able to find, and what kind of subject does its key name.*
 * That is what this file adds, and adding it here rather than in a consumer is what makes it total
 * — `satisfies Readonly<Record<TopicName, TopicAudit>>` means a topic cannot be registered without
 * someone deciding whether the operator audit log carries it.
 *
 * It is a separate module rather than a field on `TopicSpec` on purpose: `index.ts` is edited
 * whenever a topic is added, and a 41-entry table inside it would conflict with every such edit.
 * The totality guarantee is identical either way.
 *
 * ## What each side must change
 *
 * **`admin-api`**: `POST /v1/events` stops keying on the `.audit.recorded` suffix and calls
 * `auditRowFor(envelope)`; `null` keeps the existing accepted-and-ignored 202. Nothing else in the
 * route changes — the signature check, the scope check and the inbox dedupe are all already right.
 * **Every producing service**: subscribe `admin-api` to the audited topics at deploy time. No
 * service emits anything new, and no service changes a line of code.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Actor, EventEnvelope, ProducerService, TopicName } from './index.ts'

/** The three outcomes `admin-api/src/audit.ts` records. A refusal never becomes a domain event. */
export type AuditOutcome = 'allowed' | 'refused' | 'failed'

export type TopicAudit =
  | {
      readonly audited: true
      /** What `EventEnvelope.key` names, in the operator console's vocabulary. snake_case. */
      readonly subjectKind: string
      /**
       * A published domain event is a fact that happened, so almost every one is `allowed`. The
       * two exceptions are the topics whose whole purpose is to report that something did NOT
       * happen — and an operator filtering the log for failures must find them there.
       */
      readonly outcome: 'allowed' | 'failed'
    }
  | {
      readonly audited: false
      /**
       * Why not, at the length of a decision rather than a label. Enforced by `audit.test.ts`,
       * because `audited: false` is the answer a hurried author gives to a topic they have not
       * thought about, and a silent one is indistinguishable from a considered one.
       */
      readonly why: string
    }

/**
 * Whether the operator audit log carries each topic, and what its key names.
 *
 * The dividing line: **a fact an operator must be able to find during an incident, or must be able
 * to prove after one.** Money moving, a key leaving, an account's security changing, a customer
 * paying for something that was not delivered. Everything a game simulates is excluded — not
 * because it does not matter, but because an audit log that is 90% battle results is one nobody
 * reads, and the hash chain that makes this log evidence has to be verified over every row in it.
 */
export const TOPIC_AUDIT = Object.freeze({
  /* ---------------------------------------------------------------- identity: account security */
  'identity.user.registered': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'identity.user.deleted': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'identity.session.revoked': { audited: true, subjectKind: 'session', outcome: 'allowed' },
  'identity.mfa.added': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'identity.mfa.removed': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'identity.device.added': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'identity.session.created': {
    audited: false,
    why:
      'One row per login, per user, for ever — it would be the overwhelming majority of the log ' +
      'and would make the hash chain expensive to verify over the rows that matter. identity owns ' +
      'the session table and answers "when did they sign in" directly; the security-relevant half ' +
      'is the REVOCATION, which is audited above.',
  },

  /* ---------------------------------------------------------------- custody: the highest value */
  // A private key leaving the platform accompanied by a single log line is the defect
  // contracts-events was created to retire. These two are the reason this table exists at all.
  'custody.export.requested': { audited: true, subjectKind: 'user', outcome: 'allowed' },
  'custody.key.exported': { audited: true, subjectKind: 'user', outcome: 'allowed' },

  /* ---------------------------------------------------------------- ledger and money */
  'ledger.entry.posted': { audited: true, subjectKind: 'ledger_entry', outcome: 'allowed' },
  'ledger.reconciliation.completed': {
    audited: true,
    subjectKind: 'chain_network',
    outcome: 'allowed',
  },
  'wallet.wallet.created': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  'wallet.deposit.confirmed': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  'wallet.withdrawal.requested': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  'settlement.withdrawal.completed': {
    audited: true,
    subjectKind: 'withdrawal',
    outcome: 'allowed',
  },
  // `failed`, deliberately: a stuck withdrawal is money that a customer asked for and did not get.
  'settlement.withdrawal.stuck': { audited: true, subjectKind: 'chain_network', outcome: 'failed' },
  // `failed` for the same reason, and this one carries the refund decision. `refundable` is what
  // wallet reads to return the reservation to a user's balance (wallet/src/server.ts:872), so it is
  // the row an operator needs to prove afterwards why money did or did not go back.
  'settlement.outbound.failed': { audited: true, subjectKind: 'withdrawal', outcome: 'failed' },
  'settlement.outbound.confirmed': {
    audited: false,
    why:
      'The same fact as settlement.withdrawal.completed, which IS audited above and is the richer ' +
      'of the two — settlement emits both from one call site (settlement/src/withdrawals.ts:436) ' +
      'because wallet wants a narrow payload and the operator surfaces want the transaction. ' +
      'Mirroring both would put two rows in the log for one movement of one user\'s money, and an ' +
      'operator answering "where did this go" would see the withdrawal complete twice.',
  },
  // Money crossing INTO the blast radius of the signing credential: a deposit address emptied into
  // the pinned treasury. The key names the deposit address, not settlement's outbound row.
  // `sweep_source` rather than `deposit_address` because that is what the key literally holds — the
  // sweep source row settlement mints per deposit address — and a subject kind that names something
  // other than the key is a filter that returns the wrong rows.
  'settlement.sweep.completed': { audited: true, subjectKind: 'sweep_source', outcome: 'allowed' },
  'market.listing.sold': { audited: true, subjectKind: 'listing', outcome: 'allowed' },
  'mint.deploy.confirmed': { audited: true, subjectKind: 'token', outcome: 'allowed' },
  'billing.entitlement.granted': { audited: true, subjectKind: 'entitlement', outcome: 'allowed' },
  'billing.entitlement.revoked': { audited: true, subjectKind: 'entitlement', outcome: 'allowed' },

  /* ---------------------------------------------------------------- delivery of what was paid for */
  'worlds.provision.completed': { audited: true, subjectKind: 'entitlement', outcome: 'allowed' },
  // `failed`: a customer paid and got nothing. This is the row an operator goes looking for.
  'worlds.provision.failed': { audited: true, subjectKind: 'entitlement', outcome: 'failed' },
  'worlds.reward.granted': { audited: true, subjectKind: 'reward', outcome: 'allowed' },
  'worlds.title.registered': { audited: true, subjectKind: 'title', outcome: 'allowed' },
  'aetherholm.skerry.provisioned': {
    audited: true,
    subjectKind: 'entitlement',
    outcome: 'allowed',
  },
  'emberkin.reward.granted': { audited: true, subjectKind: 'reward', outcome: 'allowed' },

  /* ---------------------------------------------------------------- community governance */
  // The treasury spend. `community/src/migrations.ts` makes the treasury subject a generated
  // column precisely because this is money; the execution is therefore an operator-visible fact.
  'community.proposal.executed': { audited: true, subjectKind: 'community', outcome: 'allowed' },
  'community.proposal.opened': {
    audited: false,
    why:
      'A community audits its own governance and holds the record to do it — proposals, votes and ' +
      'delegations are its tables. The platform operator has no authority over a proposal and no ' +
      'action to take about one; the point at which it becomes the platform\'s business is the ' +
      'EXECUTION, which moves treasury Shards and is audited above.',
  },
  'community.vote.cast': {
    audited: false,
    why:
      'Same boundary as proposal.opened, and higher volume: one row per member per proposal. A ' +
      'vote is evidence a community needs and the platform does not, and putting it in the ' +
      'operator log would also put every member\'s voting record in front of every operator.',
  },

  /* ---------------------------------------------------------------- simulation: everything a game does */
  'aetherholm.city.founded': { audited: false, why: SIMULATION('a city being founded') },
  'aetherholm.building.completed': { audited: false, why: SIMULATION('a building finishing') },
  'aetherholm.research.completed': { audited: false, why: SIMULATION('research finishing') },
  'aetherholm.battle.resolved': { audited: false, why: SIMULATION('a battle resolving') },
  'aetherholm.spire.captured': { audited: false, why: SIMULATION('a spire changing hands') },
  'aetherholm.season.opened': { audited: false, why: SIMULATION('a season opening') },
  'aetherholm.season.sealed': { audited: false, why: SIMULATION('a season sealing') },
  'emberkin.battle.resolved': { audited: false, why: SIMULATION('a battle resolving') },
  'emberkin.achievement.unlocked': { audited: false, why: SIMULATION('a badge unlocking') },
  'emberkin.cosmetic.equipped': { audited: false, why: SIMULATION('a cosmetic being equipped') },
  'emberkin.save.started': { audited: false, why: SIMULATION('a save starting') },
  'emberkin.season.started': { audited: false, why: SIMULATION('a season starting') },
} as const satisfies Readonly<Record<TopicName, TopicAudit>>)

/**
 * The one reason, spelled once.
 *
 * A hoisted function so the table above stays readable at 41 entries. Every caller passes what the
 * topic reports, so the recorded reason names the specific fact rather than a category — which is
 * what stops "simulation" becoming the label people reach for when a money topic is added to a
 * game service.
 */
function SIMULATION(what: string): string {
  return (
    `${what} is simulation. An operator has no authority over it and no action to take about it, ` +
    'and the title service owns the record. Including it would make the operator log mostly game ' +
    'traffic, which both buries the rows that matter and makes the hash chain that turns this log ' +
    'into evidence expensive to verify over every one of them.'
  )
}

export type AuditedTopic = {
  [K in TopicName]: (typeof TOPIC_AUDIT)[K]['audited'] extends true ? K : never
}[TopicName]

export const AUDITED_TOPICS: readonly TopicName[] = Object.freeze(
  (Object.keys(TOPIC_AUDIT) as TopicName[]).filter((name) => TOPIC_AUDIT[name].audited).sort(),
)

/**
 * A row for `admin-api`'s `audit_events`, derived entirely from the envelope.
 *
 * Every field but `subjectKind` and `outcome` comes off the wire. Nothing is guessed, nothing
 * defaults, and in particular `correlationId` is never null — which is the whole property claim 9
 * hangs on, and it is free because `validateEnvelope` already refuses an envelope without one.
 */
export interface AuditMirrorRow {
  readonly actor: Actor
  /** The topic name. It is already `<service>.<aggregate>.<past-tense-verb>`. */
  readonly action: TopicName
  readonly subjectKind: string
  readonly subjectId: string
  readonly outcome: AuditOutcome
  readonly correlationId: string
  readonly source: ProducerService
  readonly occurredAt: string
  /** The envelope id. Unique, and the dedupe key an at-least-once bus requires. */
  readonly sourceEventId: string
  readonly payload: Record<string, unknown>
}

/**
 * Map an envelope onto an audit row, or `null` if this topic is not audited.
 *
 * `null` is an ANSWER, not a fault: a service subscribed to a topic the mirror does not carry is a
 * configuration choice, and the intake's existing 202 accepted-and-ignored path is the right
 * response. Answering 4xx would make a correctly-behaving relay retry for ever.
 *
 * An unregistered topic is also `null` rather than a throw, for the reason `contracts-events`
 * already gives about unknown topics: the consumer may simply be behind the producer.
 */
export function auditRowFor(event: EventEnvelope): AuditMirrorRow | null {
  const spec = (TOPIC_AUDIT as Readonly<Record<string, TopicAudit>>)[event.topic]
  if (!spec || !spec.audited) return null
  return {
    actor: event.actor,
    action: event.topic,
    subjectKind: spec.subjectKind,
    subjectId: event.key,
    outcome: spec.outcome,
    correlationId: event.correlationId,
    source: event.producer,
    occurredAt: event.occurredAt,
    sourceEventId: event.id,
    payload: (event.payload ?? {}) as Record<string, unknown>,
  }
}
