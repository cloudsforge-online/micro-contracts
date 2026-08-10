/**
 * The event envelope, the topic registry, and the delivery signature.
 *
 * There is no event bus in the estate today, and every consequence of that absence is visible.
 * ForgeMint's client polls for a deployment result every four seconds because nothing tells it.
 * A user learns a deposit landed by refreshing. An entitlement is granted and the world it paid
 * for is never provisioned, because the service that would provision it is never told. A private
 * key leaves the platform accompanied by a single log line.
 *
 * `identity.user.deleted` HAD no subscriber anywhere — this header said so for the whole life of
 * the estate, and it was why there was no GDPR erasure path at all. That sentence is now false:
 * `activity` erases the subject on receipt (its inbox row is the acknowledgement), and the
 * composed slice DRIVES the path — account deleted, tombstone event written in the same
 * transaction, delivered over the signed bus, records gone — as a standing check in
 * `deploy/scripts/slice-verify.sh`. Subscriptions are deploy configuration; the remaining work is
 * wiring the other holders of user data (notify above all) into the same topic at deploy time.
 *
 * The transport is deliberately unremarkable — a Postgres `outbox` written in the same
 * transaction as the state change, a leased relay job, an HTTP POST, a consumer `inbox` unique on
 * `(topic, event_id)`. See 02-target-architecture AD-10. What must be shared, exactly, between
 * twenty-two services is what this package holds: the envelope, the names of the topics, the
 * signature that makes a POST from an unauthenticated origin trustworthy, and the rule for
 * deciding whether a received version is one the consumer can read.
 *
 * ## The only ordering guarantee
 *
 * Events are ordered **per `(topic, key)`, and by nothing else.** Two events on the same topic
 * with different keys may arrive in either order. Two events on different topics have no relation
 * at all. There is no global sequence and there will not be one: 04-domain-model §11 rules it out
 * because a global order is a property that Postgres-per-service cannot provide, and pretending
 * otherwise produces consumers that are correct only under test.
 *
 * Delivery is at-least-once. A consumer that is not idempotent is a consumer that is wrong; the
 * `inbox` unique constraint, reproduced here by `inboxKey`, is what makes it right.
 *
 * Zero runtime dependencies. `node:crypto` only.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface Invalid {
  readonly ok: false
  /** Every problem found, not just the first. A caller fixing a payload should need one round. */
  readonly errors: readonly string[]
}

export type Validated<T> = { readonly ok: true; readonly value: T } | Invalid

function invalid(errors: readonly string[]): Invalid {
  return { ok: false, errors }
}

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * Who caused this to happen.
 *
 * The same vocabulary as `journal_entry.actor` in 04-domain-model §2.2, and deliberately so: an
 * event and the ledger entry it accompanies must attribute a change identically, or reconciling
 * "who moved this money" means reconciling two spellings first.
 */
export type Actor = `user:${string}` | `service:${string}` | `operator:${string}` | 'system'

export type ActorKind = 'user' | 'service' | 'operator' | 'system'

export interface ParsedActor {
  readonly kind: ActorKind
  /** Absent for `system`, which has no subject. */
  readonly id: string | null
}

export function parseActor(actor: string): Validated<ParsedActor> {
  if (actor === 'system') return { ok: true, value: { kind: 'system', id: null } }
  const separator = actor.indexOf(':')
  if (separator < 0) return invalid([`actor: expected "system" or "<kind>:<id>", got "${actor}"`])
  const kind = actor.slice(0, separator)
  const id = actor.slice(separator + 1)
  if (kind !== 'user' && kind !== 'service' && kind !== 'operator') {
    return invalid([`actor: unknown kind "${kind}"`])
  }
  // An empty subject is the shape a bug takes: a template literal whose interpolation was
  // undefined. It types as a valid Actor, so only a runtime check catches it.
  if (id === '') return invalid([`actor: "${kind}:" carries no subject`])
  return { ok: true, value: { kind, id } }
}

export function userActor(userId: string): Actor {
  return `user:${userId}`
}

export function serviceActor(service: ProducerService): Actor {
  return `service:${service}`
}

export function operatorActor(operatorId: string): Actor {
  return `operator:${operatorId}`
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** `major.minor`. Patch is not modelled: a payload change that is not additive is a major. */
export type EventVersion = `${number}.${number}`

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
}

const VERSION_PATTERN = /^(\d+)\.(\d+)$/

export function parseVersion(version: string): Validated<ParsedVersion> {
  const match = VERSION_PATTERN.exec(version)
  if (!match) return invalid([`version: expected "<major>.<minor>", got "${version}"`])
  return { ok: true, value: { major: Number(match[1]), minor: Number(match[2]) } }
}

export type VersionVerdict =
  | { readonly accepted: true; readonly reason: 'exact' | 'producer_ahead' | 'producer_behind' }
  | { readonly accepted: false; readonly reason: 'major_ahead' | 'major_behind'; readonly detail: string }

/**
 * May a consumer built against `expected` read an event stamped `received`?
 *
 * **Any minor within the same major is accepted, in both directions.** That is not laxity, it is
 * the whole point of the additive-only rule in AD-02: a minor may only add fields, so a producer
 * ahead of the consumer sends fields the consumer ignores, and a producer behind it omits fields
 * the consumer must already treat as optional. AD-02 explicitly permits a service to lag a
 * contract by two minors, and a consumer that rejected a newer minor would halt its inbox the
 * moment any producer shipped an added field — turning the safest possible change into an
 * estate-wide outage.
 *
 * A **major mismatch is rejected in both directions**, and the two directions are named
 * separately because they mean different things operationally. `major_ahead` is the dangerous
 * one: the producer has removed or reshaped something and the consumer's reader is now wrong, so
 * the event goes to the dead-letter view rather than through a handler that would silently
 * mis-read it. `major_behind` means the deployment ran in the wrong order — the consumer was
 * cut over before its producer — and the fix is a deploy, not a code change.
 */
export function acceptsVersion(received: string, expected: string): VersionVerdict {
  const r = parseVersion(received)
  const e = parseVersion(expected)
  if (!r.ok) return { accepted: false, reason: 'major_ahead', detail: r.errors.join('; ') }
  if (!e.ok) return { accepted: false, reason: 'major_ahead', detail: e.errors.join('; ') }
  if (r.value.major > e.value.major) {
    return {
      accepted: false,
      reason: 'major_ahead',
      detail: `producer is at v${received}, this consumer reads v${expected}`,
    }
  }
  if (r.value.major < e.value.major) {
    return {
      accepted: false,
      reason: 'major_behind',
      detail: `producer is at v${received}, this consumer reads v${expected}; deploy order`,
    }
  }
  if (r.value.minor === e.value.minor) return { accepted: true, reason: 'exact' }
  return {
    accepted: true,
    reason: r.value.minor > e.value.minor ? 'producer_ahead' : 'producer_behind',
  }
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/**
 * Services permitted to produce. The catalogue in 02-target-architecture §3.
 *
 * A service that is only ever a consumer — `analytics`, `hub-api` — is absent, because a topic
 * owned by a pure consumer is a design mistake worth failing to compile.
 */
export type ProducerService =
  | 'identity'
  | 'policy'
  | 'ledger'
  | 'wallet'
  | 'settlement'
  | 'pricing'
  | 'billing'
  | 'custody'
  | 'indexer'
  | 'activity'
  | 'notify'
  | 'studio'
  | 'mint'
  | 'market'
  | 'trade'
  | 'worlds'
  | 'aetherholm'
  | 'emberkin'
  | 'nda'
  | 'community'
  | 'devplatform'
  | 'admin-api'
  | 'tessera'

export interface TopicSpec {
  /** The service that owns the topic. The first segment of the name must equal it. */
  readonly producer: ProducerService
  /** Name of the payload interface, owned and versioned by the producer's own contract package. */
  readonly payloadType: string
  readonly version: EventVersion
  /**
   * What the envelope `key` holds for this topic. This is the ordering partition, so it is part
   * of the contract rather than a producer's private choice — a producer that switched from
   * `user_id` to `wallet_id` would silently change what "in order" means for every consumer.
   */
  readonly keyedBy: string
  readonly description: string
}

/**
 * Every topic that exists. Frozen, and the only place a topic name is spelled.
 *
 * The eight marked FIRST are the initial set from 02-target-architecture §5, each chosen because
 * it retires a named defect rather than because it was easy to emit. The rest are here because
 * 04-domain-model states an invariant that cannot hold without them — an entitlement that cannot
 * be revoked, a last-MFA-factor removal that notifies nobody, a reconciliation drift that freezes
 * withdrawals in a service that never hears about it.
 */
export const TOPICS = Object.freeze({
  'identity.user.registered': Object.freeze({
    producer: 'identity',
    payloadType: 'UserRegistered',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'An account exists, with its personal organisation already created.',
  }),
  /**
   * THE TOPIC WITHOUT WHICH NOBODY CAN CREATE A WORKING ACCOUNT.
   *
   * Registered from the verbatim spec identity left in `identity/src/topics.ts`
   * (`AWAITING_REGISTRATION`), which it could not land itself — the same route the
   * `identity.session.revoked` entry above took.
   *
   * ── What its absence cost, measured on the live estate ────────────────────────────────────
   *
   * `micro-identity` 1.1.0 stopped minting a session at registration and emits this instead;
   * `notify` renders `account.verify_email` from it (`notify/src/catalogue.ts`). Neither
   * could work, because `validateEnvelope` refuses a topic this registry does not carry and
   * `notify` therefore answered `POST /ingest` with 400 for every one:
   *
   *     topic: "identity.email.verification_requested" is not in this registry;
   *     contracts-events may be behind
   *
   * So registration returned 202 "check your email", the mail was never rendered, and sign-in
   * refused the account with `email_unverified` — an account nobody could finish making. The
   * fix for #30 was merged in two repositories and the third, which had to agree, was never
   * told. That is the whole failure: a contract is the one thing that cannot be changed in one
   * repository at a time.
   *
   * ── Why the link is in the payload ────────────────────────────────────────────────────────
   *
   * identity does not speak SMTP by design (`identity/src/passwordReset.ts` rejects a
   * second mail transport by name), so the absolute link travels here and lands in notify's
   * database. That is the same trade every notification's template parameters already make, and
   * it is why the token is single-use and expires in 24 hours.
   */
  'identity.email.verification_requested': Object.freeze({
    producer: 'identity',
    payloadType: 'EmailVerificationRequested',
    version: '1.0',
    keyedBy: 'user_id',
    description:
      'An account asked for its email address to be verified, carrying the single-use link to send.',
  }),
  /**
   * The sibling of the topic above, and registered for the same reason.
   *
   * It was emitted and consumed for its whole life without being registered: identity emits it at
   * `identity/src/passwordReset.ts:362` and notify holds a rule for it at
   * `notify/src/catalogue.ts:764`, and the two agreed only because two repositories independently
   * guessed the same string. `org/tools/estate-topics.mjs` reported exactly that, and it is not a
   * documentation complaint — `index.test.ts` pins that an unregistered topic fails
   * `validateEnvelope`, and `activity/src/ingest.ts` files one as `unclassified` / `internal` with
   * 90-day quarantine retention instead of the 730 days a security record gets. So the estate's
   * account-recovery trail was being deleted early. micro-org#263.
   *
   * `keyedBy` is read off the emit site, not chosen here: identity keys it by the user, because
   * ordering is per key and a later reset supersedes an earlier one.
   */
  'identity.password.reset_requested': Object.freeze({
    producer: 'identity',
    payloadType: 'PasswordResetRequested',
    version: '1.0',
    keyedBy: 'user_id',
    description:
      'A single-use password reset link has been minted for an account. Carries the address, and the link when one could be built — it expires in thirty minutes, works once, and is stripped back out of the outbox row once it has expired.',
  }),
  'identity.user.deleted': Object.freeze({
    producer: 'identity',
    payloadType: 'UserDeleted',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'FIRST. Erasure. Every service holding user_id must acknowledge within the SLA.',
  }),
  'identity.session.created': Object.freeze({
    producer: 'identity',
    payloadType: 'SessionCreated',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'FIRST. A sign-in, with device and truncated IP prefix. Feeds new-device alerts.',
  }),
  /**
   * The other half of `identity.session.created`, and the topic that carries a password change.
   *
   * Registered from the verbatim spec identity left in `identity/src/topics.ts`
   * (`AWAITING_REGISTRATION`), which it could not land itself. `reason` is a FIELD, not a
   * discriminator: `signed_out`, `signed_out_everywhere`, `password_changed`, `password_reset` and
   * the stolen-token family burn all carry the same three payload fields. That is what makes this
   * registerable at all, and it is the exact distinction `identity.mfa.changed` failed — one name
   * over four different shapes, which a registry giving each topic one `payloadType` cannot hold.
   */
  'identity.session.revoked': Object.freeze({
    producer: 'identity',
    payloadType: 'SessionRevoked',
    version: '1.0',
    keyedBy: 'session_id',
    description:
      'A session was ended, carrying the reason. The other half of identity.session.created.',
  }),
  'identity.device.added': Object.freeze({
    producer: 'identity',
    payloadType: 'DeviceAdded',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'A device seen for the first time on this account.',
  }),
  'identity.mfa.removed': Object.freeze({
    producer: 'identity',
    payloadType: 'MfaFactorRemoved',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'A second factor was revoked, flagging whether it was the last active one.',
  }),
  /**
   * Emitted at `identity/src/mfa.ts` (activation, and recovery-code regeneration) since the
   * `identity.mfa.changed` split, and mapped by `notify` since its catalogue was written — so the
   * consumer existed for the whole life of the service and could never fire, because no registry
   * named the topic. One payload shape, `MfaFactorAdded`, exactly as `MfaFactorRemoved` is.
   */
  'identity.mfa.added': Object.freeze({
    producer: 'identity',
    payloadType: 'MfaFactorAdded',
    version: '1.0',
    keyedBy: 'user_id',
    description:
      'A second factor was activated, flagging whether it replaced an existing factor of the same kind.',
  }),
  'ledger.entry.posted': Object.freeze({
    producer: 'ledger',
    payloadType: 'EntryPosted',
    version: '1.0',
    keyedBy: 'account_id of the first posting',
    description: 'FIRST. A balanced journal entry. The only source of per-product revenue.',
  }),
  'ledger.reconciliation.completed': Object.freeze({
    producer: 'ledger',
    payloadType: 'ReconciliationCompleted',
    version: '1.0',
    keyedBy: 'chain:network',
    description: 'Ledger custody total against indexer-observed total. Drift freezes withdrawals.',
  }),
  /**
   * A live producer emitted this unregistered for the life of the service.
   *
   * `wallet/src/wallets.ts` writes it in the same transaction as the row, keyed by the wallet
   * id (`wallet/src/outbox.ts`), and `notify` has held a rule for it since its catalogue was
   * written. Same finding as the worlds and emberkin waves above: consumers validate envelopes
   * against this list, so an unregistered topic from a live producer is quarantined as
   * unclassifiable however correct the delivery is.
   */
  'wallet.wallet.created': Object.freeze({
    producer: 'wallet',
    payloadType: 'WalletCreated',
    version: '1.0',
    keyedBy: 'wallet_id',
    description:
      'A wallet was registered for a user — custodial or external — with its chain, network and address.',
  }),
  'wallet.deposit.confirmed': Object.freeze({
    producer: 'wallet',
    payloadType: 'DepositConfirmed',
    version: '1.0',
    keyedBy: 'wallet_id',
    description: 'FIRST. A deposit reached its confirmation depth and was credited.',
  }),
  /**
   * **The opposite fact to the one above, and it is registered because silence was the defect.**
   *
   * micro-org#200. A token transfer — USDT and USDC are the ones anybody will actually send —
   * reaches a custodial deposit address, and `micro-wallet` will not credit it. That refusal is
   * right and stays: crediting a `TOKEN:` asset needs a decimals value nothing in this estate is a
   * source for (`contracts-money.assetDecimals` throws for a `TOKEN:` code rather than return 18,
   * because Tether is six decimals on Ethereum and eighteen on BSC and a wrong exponent on a
   * stablecoin is a balance wrong by 10^12), a `chain_assets` row only `micro-ledger` may write, a
   * `micro-pricing` route that answers for the urn — it answers `404 not_found` — and a token
   * withdrawal path that does not exist in any form.
   *
   * What was wrong was that the refusal was SILENT: the movement was consumed and discarded, and
   * nothing anywhere held the fact that a user's money was sitting at an address only
   * `micro-custody` can sign for. The producer now records the sighting and emits this.
   *
   * **A separate name rather than a field on `wallet.deposit.confirmed`, and that is the whole
   * point of registering it.** One deposit topic carrying a `credited` boolean makes "your money is
   * spendable" and "your money is here and cannot be moved" the same event to every subscriber that
   * forgets to read one field. Two names make the wrong reading unavailable rather than discouraged.
   *
   * `keyedBy: wallet_id` is read off the producer's emit rather than chosen here, and it matches
   * `wallet.deposit.confirmed` deliberately: the two opposite facts about one wallet stay ordered
   * against each other instead of racing across partitions.
   *
   * The payload carries the amount in the token's own smallest units and **no formatted figure and
   * no decimals**, because the producer has no source for them — that absence is the reason the
   * deposit is not credited in the first place. A consumer renders the integer or says nothing.
   * The token is named by its contract address, never by a symbol: a symbol is mutable, spoofable
   * and off-chain, and `USDT` as a code is one brand over three deployments with two different
   * exponents (`contracts-money.chainTokenAssetCode` throws on a brand name).
   */
  'wallet.deposit.token_uncredited': Object.freeze({
    producer: 'wallet',
    payloadType: 'DepositTokenUncredited',
    version: '1.0',
    keyedBy: 'wallet_id',
    description:
      'A token transfer reached its confirmation depth at a deposit address and was NOT credited: ' +
      'no ledger entry exists for it and it cannot be withdrawn.',
  }),
  'wallet.withdrawal.requested': Object.freeze({
    producer: 'wallet',
    payloadType: 'WithdrawalRequested',
    version: '1.0',
    keyedBy: 'wallet_id',
    description: 'A user asked for money to leave. Policy and activity both need the moment.',
  }),

  /* ── wallet — the five names it emitted against a registry that knew three ─────────────────────
   *
   * `micro-wallet` produces eight topics. Three were registered. `validateEnvelope` refuses an
   * unregistered name, so the relay could not build an envelope for the other five and — after
   * `micro-wallet`'s quarantine landed — set them aside instead: **244 rows on the mainnet estate,
   * 243 `deposit_address.assigned` and one `link.verified`, every one with the same reason,
   * "is not in this registry; contracts-events may be behind".** The registry was behind.
   *
   * None of the five is a money INSTRUCTION — the one topic that moves money,
   * `wallet.withdrawal.requested`, was registered and is why it alone had a live subscriber. What
   * was lost is the record: an operator investigating "which address did we give this person, and
   * when" had nothing to read, and `notify` could not tell anybody their withdrawal had been
   * refunded. Both are facts about somebody's money even where no coin moves on them.
   *
   * `keyedBy` is stated from what wallet ACTUALLY sends rather than from what would be tidy,
   * because the key is the ordering partition and changing it silently reorders every consumer's
   * view. `wallet.deposit_address.assigned` is keyed `chain:network:address_key`
   * (`wallet/src/deposits.ts`) and that is right for it: assignments for one address must stay
   * ordered against each other through a rotation, and they are the only ones that must.
   * ────────────────────────────────────────────────────────────────────────────────────────────── */
  'wallet.deposit_address.assigned': Object.freeze({
    producer: 'wallet',
    payloadType: 'DepositAddressAssigned',
    version: '1.0',
    keyedBy: 'chain:network:address',
    description:
      'A custodial deposit address was assigned to a user for one asset, or rotated to a new one.',
  }),
  'wallet.link.verified': Object.freeze({
    producer: 'wallet',
    payloadType: 'WalletLinkVerified',
    version: '1.0',
    keyedBy: 'wallet_id',
    description:
      'A user proved they hold the key to an external wallet, which is what authorises it as a ' +
      'withdrawal destination.',
  }),
  'wallet.link.revoked': Object.freeze({
    producer: 'wallet',
    payloadType: 'WalletLinkRevoked',
    version: '1.0',
    keyedBy: 'wallet_id',
    description: 'An external wallet stopped being an authorised withdrawal destination.',
  }),
  'wallet.withdrawal.refunded': Object.freeze({
    producer: 'wallet',
    payloadType: 'WithdrawalRefunded',
    version: '1.0',
    keyedBy: 'withdrawal_id',
    description:
      'A withdrawal failed and the reservation went back to the balance. The user is owed this one.',
  }),
  'wallet.withdrawal.stuck': Object.freeze({
    producer: 'wallet',
    payloadType: 'WithdrawalStuck',
    version: '1.0',
    keyedBy: 'withdrawal_id',
    description:
      'A withdrawal passed its deadline with no word from settlement. Funds are still reserved.',
  }),
  'settlement.withdrawal.completed': Object.freeze({
    producer: 'settlement',
    payloadType: 'WithdrawalCompleted',
    version: '1.0',
    keyedBy: 'withdrawal_id',
    description: 'FIRST. Broadcast and confirmed on chain, with the transaction hash.',
  }),
  'settlement.withdrawal.stuck': Object.freeze({
    producer: 'settlement',
    payloadType: 'WithdrawalStuck',
    version: '1.0',
    keyedBy: 'chain:network',
    description: 'An outbound transaction passed its deadline unconfirmed. Pages on one.',
  }),

  /* ── settlement — three of the four names it emits unregistered, and the one that is refused ──
   *
   * `settlement` emitted six topic names against two registered ones. Three of the four missing
   * names are real facts and are registered below. The fourth is refused, and the refusal is the
   * point of the exercise: registering all four would have made a reconciliation check quiet
   * without making anything true.
   *
   * **REFUSED: `settlement.outbound.stuck`.** It is not a second fact. `settlement/src/
   * withdrawals.ts` builds ONE `payload` object and emits it twice — once as
   * `settlement.withdrawal.stuck` keyed `chain:network`, once as `settlement.outbound.stuck` keyed
   * `row.id` — so the two differ in nothing but their partition. Nothing in the estate subscribes
   * to the second name (the only mentions outside settlement are `notify/src/topics.ts` and
   * `org/tools/estate-topic-gaps.json`, both describing it as the defect), and the registered
   * event already carries the row: `base(row)` puts `outboundId: row.id` on the payload
   * (`withdrawals.ts`), so an operator queue can order by a field it is already sent.
   * Registering it would put a second official name on one fact — which is `wallet.deposit.credited`
   * against `wallet.deposit.confirmed` run deliberately instead of by accident, and it would make
   * "which name does a stuck withdrawal have" a question with two right answers forever. A topic is
   * cheap to add and impossible to remove; this one buys a partition that a `group by` gives free.
   *
   * None of the three below has the shape that made `identity.mfa.changed` unregisterable — one
   * name over four payload shapes chosen by a discriminator. Each carries exactly one shape:
   * `confirmedEvents`, `failedEvents` and `sweepCompletedEvents`
   * (`sweeps.ts`) each build a single object literal with fixed keys. `refundable` on
   * `.failed` is a boolean FIELD every instance carries, not a selector between payloads — the same
   * distinction `identity.session.revoked`'s `reason` passes.
   * ------------------------------------------------------------------------------------------ */
  /**
   * **Wallet's name, and the most load-bearing topic this service emits.**
   *
   * `wallet/src/settlement.ts` declares this exact string and `wallet/src/server.ts`
   * branches on it to release the user's reservation — spelled there before `settlement` existed, so
   * the registry follows the live contract rather than renaming it for tidiness. Deliberately
   * narrower than `settlement.withdrawal.completed`, which carries the same fact with the whole
   * outbound transaction on it for notify and the operator surfaces; a subscription is per topic, so
   * no consumer sees both.
   *
   * Keyed by the WITHDRAWAL, not settlement's outbound row: `withdrawals.ts` passes
   * `row.sourceRef`, and the withdrawal id is the only one of the two identifiers wallet holds.
   */
  'settlement.outbound.confirmed': Object.freeze({
    producer: 'settlement',
    payloadType: 'OutboundConfirmed',
    version: '1.0',
    keyedBy: 'withdrawal_id',
    description:
      "A withdrawal reached its chain's confirmation depth. Releases wallet's reservation.",
  }),
  /**
   * The other terminal outcome, and `refundable` is why it cannot be folded into the one above.
   *
   * `wallet/src/server.ts` returns the reservation to the user's balance only when
   * `refundable === true`, and defaults it to false, because refunding a payment that actually
   * landed pays the user twice. `notify/src/topics.ts` has recorded a notification for this
   * exact string with "no producer" for the life of that service — the producer existed all along
   * and no registry named it.
   */
  'settlement.outbound.failed': Object.freeze({
    producer: 'settlement',
    payloadType: 'OutboundFailed',
    version: '1.0',
    keyedBy: 'withdrawal_id',
    description:
      'A withdrawal ended without reaching the chain. `refundable` says whether the money may go back.',
  }),
  /**
   * Customer funds moved INTO the treasury, which is the one movement no other topic reports.
   *
   * A sweep empties a per-user deposit address into the pinned treasury address
   * (`settlement/src/sweeps.ts`). No reservation waits on it, so it is not a `withdrawal.*` topic —
   * but it is the only event saying that customer money crossed into the blast radius of the signing
   * credential, and `ledger.reconciliation.completed` compares totals without anything telling it
   * which movements produced them. Registered before a subscriber exists, on the same rule as the
   * aetherholm block above: an unregistered topic from a live producer is quarantined as
   * unclassifiable however correct the delivery is.
   *
   * **Keyed by the sweep source, and WHY is the part worth keeping.** `key` is the ordering
   * partition: two sweeps of one deposit address must be ordered against each other, each
   * decrementing that address's observed balance, while two sweeps of different addresses have no
   * ordering relationship at all. Keyed by settlement's outbound-row surrogate — which is unique
   * per event — every sweep would be its own partition and the ordering guarantee would say
   * nothing. That is the `identity.session.revoked` mistake in its ordering form: keyed by the
   * mechanism rather than the subject.
   *
   * This paragraph used to end with an INSTRUCTION — "the emit site passes `row.id`; the change is
   * `key: row.sourceRef`" — naming a line in another repository. Settlement made that change when
   * this spec was registered and the instruction became a lie that read like a task, which is the
   * exact shape of stale documentation this estate keeps being bitten by. So it is stated as a
   * property instead, and the property is asserted: `index.test.ts` pins this `keyedBy` against
   * being quietly reverted here, and the half no checkout of THIS repository can answer — does the
   * producer still pass what the spec says? — is answered where both halves exist, by `micro-org`'s
   * `tools/estate-topics.mjs`, which clones every producer and reconciles emit sites against this
   * registry. A line number in a sibling repo is not evidence; a check that runs is.
   */
  'settlement.sweep.completed': Object.freeze({
    producer: 'settlement',
    payloadType: 'SweepCompleted',
    version: '1.0',
    keyedBy: 'sweep_source_id',
    description:
      'A deposit address was emptied into the pinned treasury and confirmed at depth. The only event that says customer funds moved into custody proper.',
  }),

  'billing.entitlement.granted': Object.freeze({
    producer: 'billing',
    payloadType: 'EntitlementGranted',
    version: '1.0',
    keyedBy: 'subject',
    description: 'FIRST. Someone bought something. The service that delivers it subscribes.',
  }),
  'billing.entitlement.revoked': Object.freeze({
    producer: 'billing',
    payloadType: 'EntitlementRevoked',
    version: '1.0',
    keyedBy: 'subject',
    description: 'A refund or expiry. Without it a refund leaves the thing it paid for in place.',
  }),
  'custody.export.requested': Object.freeze({
    producer: 'custody',
    payloadType: 'KeyExportRequested',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'The 24-hour cooling-off began. Notify must reach every channel before it ends.',
  }),
  'custody.key.exported': Object.freeze({
    producer: 'custody',
    payloadType: 'KeyExported',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'FIRST. A private key left the platform. The wallet is self-custodied from here.',
  }),
  'mint.deploy.confirmed': Object.freeze({
    producer: 'mint',
    payloadType: 'DeployConfirmed',
    version: '1.0',
    keyedBy: 'token_id',
    description: 'FIRST. A contract is live at an address. Retires the four-second client poll.',
  }),
  'market.listing.sold': Object.freeze({
    producer: 'market',
    payloadType: 'ListingSold',
    version: '1.0',
    keyedBy: 'listing_id',
    description: 'A listing settled, against a ledger entry or an on-chain transaction.',
  }),
  /**
   * Adopted from `market/src/topics.ts`'s `AWAITING_REGISTRATION` and `notify/src/topics.ts`'s,
   * which hold byte-identical specs for it. This is a COPY of that spec, not a fresh one — the
   * quarantine's whole purpose is that the producer and its first consumer cannot end up proposing
   * two different contracts for one topic, and a registration that reworded the description would
   * throw that away for nothing.
   *
   * `keyedBy: 'listing_id'` was re-read off the emit site before pasting rather than trusted:
   * `market/src/bids.ts` emits `topic: OFFER_MADE_TOPIC` and passes `key: listing.id`,
   * where `listing` is `toListing` of the `listings` row that transaction is holding `for update`.
   * It is the LISTING, not the offer and not either party — which is right, because ordering must
   * be per listing: two offers on one listing are the same contention, and keying by offer id
   * would make every offer its own partition. The same key `market.listing.sold` already uses.
   *
   * That re-read is not ceremony. `custody`'s two ceremony topics were registered `keyedBy:
   * 'user_id'` while their emit sites passed the ADDRESS, `activity` reads the envelope key AS the
   * user id, and every key-export event was filed against a user who does not exist. A spec copied
   * from a proposal nobody checked against the producer is exactly how that happened.
   *
   * The payload's `sellerSubject` is the point of the topic and is why a rule for it is writable
   * at all: everything else on the envelope — the actor, `offererSubject`, the key — names the
   * person who ACTED, so before that field existed the only notification this event could produce
   * would have told the offerer their own offer had arrived. `micro-notify` refused to write the
   * rule for exactly that reason and recorded the refusal (`blockedBy: 'no-subject'`); market added
   * the field (`bids.ts`, read off the same `for update` row) and the refusal ended.
   */
  'market.offer.made': Object.freeze({
    producer: 'market',
    payloadType: 'OfferMade',
    version: '1.0',
    keyedBy: 'listing_id',
    description:
      'A buyer made an offer on a listing. Carries the seller as well as the offerer: the notification this event exists for goes to the person who did not act.',
  }),
  'community.proposal.executed': Object.freeze({
    producer: 'community',
    payloadType: 'ProposalExecuted',
    version: '1.0',
    keyedBy: 'community_id',
    description: 'A passed proposal cleared its timelock and executed. Treasury spends land here.',
  }),
  /**
   * Two more topics a live producer was already emitting unregistered — the same finding as worlds
   * and wallet above, found by reconciling `notify`'s rule table against this registry.
   *
   * Both are keyed by the PROPOSAL, not the community: `community/src/jobs.ts` and
   * `community/src/votes.ts` both pass the proposal id as the key, and the key is the ordering
   * partition, so it is contract rather than a producer's private choice. Note that
   * `community.proposal.executed` above is keyed by `community_id` and that difference is real —
   * a consumer that assumed one keying for the family would mis-order the other two.
   */
  'community.proposal.opened': Object.freeze({
    producer: 'community',
    payloadType: 'ProposalOpened',
    version: '1.0',
    keyedBy: 'proposal_id',
    description: 'A proposal left discussion and its voting window is open. A vote nobody saw is a vote nobody could cast.',
  }),
  'community.vote.cast': Object.freeze({
    producer: 'community',
    payloadType: 'VoteCast',
    version: '1.0',
    keyedBy: 'proposal_id',
    description:
      'A vote was recorded, with the choice and how many subjects it counted for. Carries no individual weights: a per-delegator weight on the bus is a wallet-size disclosure.',
  }),
  // Aetherholm, the third Forge Worlds title (docs/ecosystem/20-aetherholm.md). Registered
  // BEFORE anything subscribes, because an unregistered topic is the devplatform lesson:
  // `makeEvent` refuses it and a consumer's validateEnvelope flags it as "contracts-events may
  // be behind" — acknowledged and ignored is the failure mode being avoided.
  'aetherholm.season.opened': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'SeasonOpened',
    version: '1.0',
    keyedBy: 'season_id',
    description: 'A season opened with its seed and public archipelago. The seed is public data.',
  }),
  'aetherholm.city.founded': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'CityFounded',
    version: '1.0',
    keyedBy: 'city_id',
    description: 'A player founded a city on an island plot, with its free 7-day aegis.',
  }),
  'aetherholm.building.completed': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'BuildingCompleted',
    version: '1.0',
    keyedBy: 'city_id',
    description: 'A queued building level finished and the city economy was recomputed.',
  }),
  'aetherholm.research.completed': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'ResearchCompleted',
    version: '1.0',
    keyedBy: 'city_id',
    description: 'A queued research node completed for a player on an archipelago.',
  }),
  'aetherholm.skerry.provisioned': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'SkerryProvisioned',
    version: '1.0',
    keyedBy: 'entitlement_id',
    description: 'The title contract delivered a Private Skerry for a billing entitlement.',
  }),
  // Aetherholm phase 2: the moving parts. Same registered-before-anything-subscribes rule as
  // the five above. NOTE the keying: none of these is keyed by user_id, and battle.resolved
  // carries TWO users — the payload names attacker_user_id and defender_user_id separately, and
  // a consumer that guesses "the user" from key or actor attributes the raid to the raider.
  'aetherholm.battle.resolved': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'BattleResolved',
    version: '1.0',
    keyedBy: 'battle_id',
    description:
      'A raid or siege resolved deterministically; the payload carries the report digest, both parties and the loot.',
  }),
  'aetherholm.spire.captured': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'SpireCaptured',
    version: '1.0',
    keyedBy: 'island_id',
    description:
      'At season seal, who held one Aether Spire — an alliance or a lone player, with every member user id aboard the payload.',
  }),
  'aetherholm.season.sealed': Object.freeze({
    producer: 'aetherholm',
    payloadType: 'SeasonSealed',
    version: '1.0',
    keyedBy: 'season_id',
    description:
      'Day 120: the archipelago froze into the chronicle. Carries the chronicle digest and the victors; heraldry consumers subscribe here.',
  }),

  /* ── worlds — four topics a LIVE producer was already emitting unregistered ─────────────────
   * The registry contained zero worlds.* topics while worlds/src emitted all four below, which is
   * the devplatform failure mode this registry's own note warns about: consumers validate
   * envelopes against this list, so an unregistered topic from a live producer is quarantined as
   * unclassifiable no matter how correct the delivery is. Found when Aetherholm's phase-2 wave
   * re-audited producers against the registry.
   * ------------------------------------------------------------------------------------------ */
  'worlds.title.registered': Object.freeze({
    producer: 'worlds',
    payloadType: 'TitleRegistered',
    version: '1.0',
    keyedBy: 'title_id',
    description: 'An operator registered a game title with the platform, with its capability set.',
  }),
  'worlds.reward.granted': Object.freeze({
    producer: 'worlds',
    payloadType: 'RewardGranted',
    version: '1.0',
    keyedBy: 'reward_id',
    // 'in Shards' until 2026-08-10. micro-worlds moved this programme onto EMBER (micro-org#226):
    // a season is funded from `engagement:worlds`, docs/ecosystem/21 §2 denominates that treasury
    // in EMBER, and SHARD has been retired since 2026-08-04 — so the old description named an
    // asset the payload could no longer be carrying. The payload now names the asset itself,
    // which is what `activity` refuses to quantify a reward without. The topic `version` is
    // unchanged: the payload's own rename is the producer's break and it travels in micro-worlds.
    //
    // `TOPICS` is `as const`, so every description is a string LITERAL in the exported surface and
    // editing one reads to `tools/compat.ts` as `type-changed` — the additive form it asks for
    // does not exist for a field a topic has exactly one of. Taken as a recorded break instead,
    // in `compat-breaks.json` against 1.1.0 — which is why this package is 1.1.0 and not 1.0.0.
    // That waiver expired the moment it merged, by design, and has been pruned; the record of it
    // is micro-contracts#6, its run log, and the commit that carried it.
    description:
      'A season reward paid a player in EMBER wei, with the asset code, the journal entry and the remaining budget on the event so a nearly-spent alert can be a subscriber rather than a remembered query.',
  }),
  'worlds.provision.completed': Object.freeze({
    producer: 'worlds',
    payloadType: 'ProvisionCompleted',
    version: '1.0',
    keyedBy: 'entitlement_id',
    description: 'A private-world entitlement was delivered by its title, with the urn.',
  }),
  'worlds.provision.failed': Object.freeze({
    producer: 'worlds',
    payloadType: 'ProvisionFailed',
    version: '1.0',
    keyedBy: 'entitlement_id',
    description:
      'A private-world provision ended undeliverable. Carries the entitlement id so a refund can name what it reverses.',
  }),

  /* ── emberkin — six topics, same finding, and the producer itself was missing from the union ─ */
  'emberkin.achievement.unlocked': Object.freeze({
    producer: 'emberkin',
    payloadType: 'AchievementUnlocked',
    version: '1.0',
    keyedBy: 'user_id_and_code',
    description: 'A player unlocked an achievement, keyed user:code so a replay cannot double it.',
  }),
  'emberkin.battle.resolved': Object.freeze({
    producer: 'emberkin',
    payloadType: 'BattleResolved',
    version: '1.0',
    keyedBy: 'battle_id',
    description: 'A battle resolved, with outcome and turn count. The player fought it themselves.',
  }),
  'emberkin.cosmetic.equipped': Object.freeze({
    producer: 'emberkin',
    payloadType: 'CosmeticEquipped',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'A player equipped a cosmetic entitlement into a slot.',
  }),
  'emberkin.save.started': Object.freeze({
    producer: 'emberkin',
    payloadType: 'SaveStarted',
    version: '1.0',
    keyedBy: 'user_id',
    description: 'A player began a campaign, with starter and region.',
  }),
  'emberkin.season.started': Object.freeze({
    producer: 'emberkin',
    payloadType: 'SeasonStarted',
    version: '1.0',
    keyedBy: 'season_id',
    description: 'A season opened for the title. A world event with no individual subject.',
  }),
  'emberkin.reward.granted': Object.freeze({
    producer: 'emberkin',
    payloadType: 'RewardGranted',
    version: '1.0',
    keyedBy: 'idempotency_key',
    description:
      'A season reward paid a player in Shards, keyed by its idempotency key, with the journal entry on the event.',
  }),

  /* ── three adopted from producer quarantines, VERBATIM ─────────────────────────────────────
   * Each of the three below existed twice before this commit: once in the producing service's own
   * `AWAITING_REGISTRATION` and once in `notify/src/topics.ts`, where notify copied the producer's
   * spec rather than writing a second one. Both copies agree field for field with what is
   * registered here, so this is a paste and not a fresh design, and there was never a moment at
   * which two repositories proposed two different contracts for one topic.
   *
   * Two properties were checked against the PRODUCER'S SOURCE before adopting, because the spec is
   * the thing being adopted and a spec cannot vouch for itself:
   *
   *   - **One payload shape each.** This is the `identity.mfa.changed` test: that name carried a
   *     four-value discriminator over four different shapes and was unregisterable by
   *     construction, because a `TopicSpec` gives a topic exactly one `payloadType`. Each of these
   *     three has exactly one emit site with exactly one shape —
   *     `trade/src/bots.ts` (`{ botId }`), `devplatform/src/apikeys.ts` (`emitKeyIssued`,
   *     the only caller path being `devplatform/src/server.ts`) and
   *     `devplatform/src/apikeys.ts` (`emitKeyRevoked`, called from `server.ts` and
   *     `server.ts` with the SAME payload builder and only the actor differing, which is a
   *     field and not a discriminator).
   *
   *   - **`keyedBy` is what the producer really passes**, read off the emit site rather than taken
   *     from the spec. This is the `custody` lesson: both ceremony topics were registered
   *     `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, and `activity` reads the
   *     envelope key AS the user id, so every export event was filed against a user that does not
   *     exist. Verified here: `bots.ts` passes `bot.id`, and both `apikeys.ts` emitters pass
   *     `key.id` — matching `bot_id`, `key_id` and `key_id` below.
   *
   * Landing these makes `adoptedProposals()` non-empty in `micro-trade`, `micro-devplatform` and
   * `micro-notify`, whose suites now fail until the matching quarantine entries are deleted. That
   * is the self-emptying quarantine working, not a regression this commit introduced.
   * ------------------------------------------------------------------------------------------ */
  'trade.bot.paused': Object.freeze({
    producer: 'trade',
    payloadType: 'BotPaused',
    version: '1.0',
    keyedBy: 'bot_id',
    description: 'A bot stopped trading.',
  }),
  'devplatform.key.issued': Object.freeze({
    producer: 'devplatform',
    payloadType: 'ApiKeyIssued',
    version: '1.0',
    keyedBy: 'key_id',
    description: 'An API key was issued for a project, with its scopes and prefix.',
  }),
  'devplatform.key.revoked': Object.freeze({
    producer: 'devplatform',
    payloadType: 'ApiKeyRevoked',
    version: '1.0',
    keyedBy: 'key_id',
    description:
      'An API key was revoked. Every cache holding a verification result for it must drop it.',
  }),

  /* ---------------------------------------------------------------------------------------------
   * TRADE — the OTHER SIX. micro-org#345, and the completion of the block above.
   *
   * `trade.bot.paused` was adopted alone. `micro-trade` emits seven topics, so for the whole life
   * of that entry six of them had no name here — and the cost of a missing name is larger than the
   * missing timeline entry it is usually described by. Three things were true at once while these
   * six were unregistered, and only the first is the one people talk about:
   *
   *   1. `activity` filed all six as `unclassified` — no feed entry for a bot a user started, a
   *      fill they were charged for, or a fee taken from their account — and `notify` had no rule.
   *   2. Because `unclassified` is the QUARANTINE retention class, those rows expired at 90 days
   *      rather than at the 1825 a financial record gets (`activity/src/retention.ts`). Four of the
   *      six move money. The estate was deleting its own trading record early, in a repository
   *      neither the producer nor the registry had any reason to look at — the same shape as the
   *      `identity.password.reset_requested` finding, which `notify/src/topics.ts` records.
   *   3. **`collectEnvelopeDefects` cannot check producer ownership without a `TopicSpec`.** Read
   *      it: the `producer !== spec.producer` branch is reachable only when `spec` is defined, and
   *      `spec` is defined only for a REGISTERED topic. So an envelope claiming
   *      `topic: 'trade.fee.settled'` with `producer: 'wallet'` classified as `unregistered_topic`
   *      with an EMPTY `defects` — the excused branch — and `activity/src/ingest.ts` shelved it.
   *      Measured 2026-08-10 against this file on main, before this block existed:
   *
   *          classifyEnvelope({ topic: 'trade.fee.settled',  producer: 'wallet', ... })
   *            → { reason: 'unregistered_topic', defects: [] }              // shelved
   *          classifyEnvelope({ topic: 'trade.bot.paused',   producer: 'wallet', ... })
   *            → { reason: 'malformed', defects: ['producer: "wallet" does not own topic …'] }
   *
   *      One character of difference in the topic, and the difference between a service publishing
   *      under another's namespace being refused and being filed. `ingest.ts` names this exactly —
   *      "that check arrives with the registration, and only with it" — so registering these six is
   *      not only what lets them be read, it is what lets them be REFUSED when they are forged.
   *
   * Every spec below is pasted from `trade/src/topics.ts` `AWAITING_REGISTRATION`, field for field,
   * because a spec the producer wrote is the thing being adopted and a second draft of it here
   * would be two repositories proposing two contracts for one topic.
   *
   * `keyedBy` was re-read off the emit site rather than trusted from the spec — the `custody`
   * lesson recorded above, where both ceremony topics were registered `keyedBy: 'user_id'` while
   * the emit sites passed the ADDRESS and every export event was filed against a user who does not
   * exist. Verified in `micro-trade`: `bots.ts` passes `bot.id` on both bot topics, `fills.ts`
   * passes `value.fill.id`, `fees.ts` passes the settlement `row.id`, `exchange.ts` passes
   * `order.id` (the TAKER's, which is what `trade/src/topics.ts` argues for at length), and
   * `transfers.ts` passes `transfer.id`. All six match.
   *
   * One payload shape each, which is the `identity.mfa.changed` test — a name carrying a
   * discriminator over several shapes is unregisterable by construction, because a `TopicSpec`
   * gives a topic exactly one `payloadType`. Each of the six has exactly one emit site.
   *
   * The last two belong to the order book, behind `TRADE_EXCHANGE_ENABLED`. They are registered
   * anyway rather than held back, for the reason `micro-trade` gives: the moment the flag is turned
   * on is the worst possible moment to discover that the estate cannot read the events.
   *
   * Landing this makes `adoptedProposals()` non-empty in `micro-trade`, whose suite fails until the
   * six quarantine entries are deleted. That is the self-emptying quarantine working, not a
   * regression this commit introduced. It also requires `activity` to hold six classifiers and
   * `notify` a rule or a recorded reason for each, both of which are typecheck- and test-enforced
   * in those repositories — which is why this could never have been a one-repository change.
   * ------------------------------------------------------------------------------------------ */
  'trade.bot.created': Object.freeze({
    producer: 'trade',
    payloadType: 'BotCreated',
    version: '1.0',
    keyedBy: 'bot_id',
    description: 'A trading bot was configured, with its mode, strategy and allocation.',
  }),
  'trade.bot.started': Object.freeze({
    producer: 'trade',
    payloadType: 'BotStarted',
    version: '1.0',
    keyedBy: 'bot_id',
    description: 'A bot began trading and its allocation was reserved through the ledger.',
  }),
  'trade.fill.settled': Object.freeze({
    producer: 'trade',
    payloadType: 'FillSettled',
    version: '1.0',
    // Keyed by the FILL and not by the bot, and `trade/src/topics.ts` argues it: two fills for one
    // bot have no ordering relationship to each other, and keying by the bot would serialise a bot
    // behind its own history.
    keyedBy: 'fill_id',
    description: 'A bot fill settled against the ledger, with its journal entry.',
  }),
  'trade.fee.settled': Object.freeze({
    producer: 'trade',
    payloadType: 'FeeSettled',
    version: '1.0',
    keyedBy: 'settlement_id',
    description: 'A performance fee settlement completed for a bot period, with its entry.',
  }),
  'trade.order.filled': Object.freeze({
    producer: 'trade',
    payloadType: 'OrderFilled',
    version: '1.0',
    // The TAKER's order, not the user and not the trade. One order can fill against many makers in
    // one pass, so a per-trade topic would print an unbounded burst for a single customer action;
    // the order is the aggregate a consumer follows.
    keyedBy: 'order_id',
    description:
      'An exchange order filled, wholly or partly, with the quantity and notional it traded.',
  }),
  'trade.transfer.settled': Object.freeze({
    producer: 'trade',
    payloadType: 'TransferSettled',
    version: '1.0',
    // The idempotency subject: one transfer, one journal entry, one event.
    keyedBy: 'transfer_id',
    description:
      'A deposit into or withdrawal out of an exchange balance settled against the ledger.',
  }),

  /* ---------------------------------------------------------------------------------------------
   * TESSERA — 23-tessera.md §11.2. Seven topics, registered in the same commit as the code that
   * emits them, which is the rule the two paragraphs above exist because nobody followed.
   *
   * `keyedBy` was decided per topic rather than defaulted, and one of the seven is the rule doing
   * work rather than being quoted. Each was checked against the emit site in `micro-tessera` —
   * `tessera/src/world.ts`, `kiln.ts` and `economy.ts` — not taken from the design document, for
   * the reason the `custody` note above records: both ceremony topics were registered
   * `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, and `activity` reads the
   * envelope key AS the user id, so every export event was filed against a user who does not
   * exist. `tessera/src/topics.test.ts` asserts the agreement from the producer's side, against
   * this registry, so the two halves cannot drift apart in either direction.
   * ------------------------------------------------------------------------------------------ */
  'tessera.parcel.claimed': Object.freeze({
    producer: 'tessera',
    payloadType: 'ParcelClaimed',
    version: '1.0',
    // Two claims on one parcel must serialise. Not `owner_subject`: one person claiming two
    // parcels has no ordering relationship at all, while two people reaching for one rectangle of
    // ground is exactly the sequence that exists.
    keyedBy: 'parcel_id',
    description:
      'Ground was claimed, free, by an account. The platform never sells land, so this event is never preceded by a payment.',
  }),
  'tessera.parcel.fallowed': Object.freeze({
    producer: 'tessera',
    payloadType: 'ParcelFallowed',
    version: '1.0',
    // Fallow and contest must order against the same parcel: a contest that overtook the fallow
    // that permitted it would read as a claim taken from a live owner.
    keyedBy: 'parcel_id',
    description:
      'A non-Homestead parcel went 90 days with no visitor and no edit. Contestable 30 days later; a Homestead never appears here.',
  }),
  'tessera.parcel.transferred': Object.freeze({
    producer: 'tessera',
    payloadType: 'ParcelTransferred',
    version: '1.0',
    // A transfer must not overtake the claim that preceded it.
    keyedBy: 'parcel_id',
    description:
      'A parcel changed hands, by trade or by a resolved contest. Never a Homestead — that is refused by the database.',
  }),
  'tessera.object.fired': Object.freeze({
    producer: 'tessera',
    payloadType: 'ObjectFired',
    version: '1.0',
    // The object's own id, not the author's: a Kiln firing's sequence is per object. The author
    // is a field, and an actor is not a discriminator.
    keyedBy: 'object_id',
    description:
      'An object came out of the Kiln, content-addressed by the sha256 of its own bytes, with the prompt and model that made it.',
  }),
  'tessera.object.anchored': Object.freeze({
    producer: 'tessera',
    payloadType: 'ObjectAnchored',
    version: '1.0',
    keyedBy: 'object_id',
    description:
      "Authorship of an object was written to Hearth's Registry of Authorship. Lazy and user-initiated: written when a creator first lists, not when they fire.",
  }),
  'tessera.ward.opened': Object.freeze({
    producer: 'tessera',
    payloadType: 'WardOpened',
    version: '1.0',
    keyedBy: 'ward_id',
    description:
      'A new ward minted, because the previous one crossed 70% occupancy. Supply is elastic; location is not.',
  }),
  'tessera.venue.booked': Object.freeze({
    producer: 'tessera',
    payloadType: 'VenueBooked',
    version: '1.0',
    /**
     * **NOT `booking_id`, and this is the one that matters.**
     *
     * The contended resource is the PARCEL'S CALENDAR, not the booking. Keying by the booking
     * would give every booking its own partition, so two bookings for one slot could be processed
     * in either order — which is precisely the failure `keyedBy` exists to prevent, and precisely
     * the reason `settlement.sweep.completed` is keyed by the deposit address rather than by the
     * outbound row's surrogate.
     *
     * The database already refuses the double-book (`tessera_one_open_booking`, a partial unique
     * index on `(parcel_id, slot) where status = 'open'`). This is the same fact stated for the
     * consumers, who have no such index: a calendar rendered from these events in booking-id
     * order is a calendar that can show the loser of a race as the winner.
     */
    keyedBy: 'parcel_id',
    description:
      "A Venue's calendar slot was booked, against an escrowed ledger hold. Keyed by the parcel, because the calendar is the contended resource.",
  }),
} as const satisfies Readonly<Record<string, TopicSpec>>)

export type TopicName = keyof typeof TOPICS

export const TOPIC_NAMES: readonly TopicName[] = Object.freeze(
  Object.keys(TOPICS) as TopicName[],
)

/**
 * `<service>.<aggregate>.<past-tense-verb>` — exactly three segments, lowercase.
 *
 * Underscores are allowed inside a segment (`custody.export.requested` versus
 * `identity.mfa.removed`) but a fourth segment is not: a topic that needs one is two topics, or
 * an aggregate that has not been named. Past tense is a convention no regular expression can
 * check; what the machine can enforce is the shape, and what the review enforces is the tense.
 */
const TOPIC_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*){2}$/

export interface ParsedTopic {
  readonly service: string
  readonly aggregate: string
  readonly verb: string
}

/** Shape only. Says nothing about whether the topic is registered. */
export function isValidTopicName(topic: string): boolean {
  return TOPIC_PATTERN.test(topic)
}

export function parseTopicName(topic: string): Validated<ParsedTopic> {
  if (!isValidTopicName(topic)) {
    return invalid([
      `topic: "${topic}" is not <service>.<aggregate>.<past-tense-verb> in lowercase`,
    ])
  }
  const [service, aggregate, verb] = topic.split('.') as [string, string, string]
  return { ok: true, value: { service, aggregate, verb } }
}

export function isRegisteredTopic(topic: string): topic is TopicName {
  return Object.hasOwn(TOPICS, topic)
}

export function topicSpec(topic: TopicName): TopicSpec {
  return TOPICS[topic]
}

/** Every topic a given service owns. What a producer's relay iterates over. */
export function topicsProducedBy(service: ProducerService): readonly TopicName[] {
  return TOPIC_NAMES.filter((name) => TOPICS[name].producer === service)
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export interface EventEnvelope<P = unknown> {
  /** UUIDv7. Time-ordered, so an outbox scan in id order is a scan in creation order. */
  readonly id: string
  readonly topic: TopicName
  /**
   * The ordering partition. Events sharing a `(topic, key)` are delivered in the order they were
   * written, and no other pair of events has any ordering relationship whatsoever.
   */
  readonly key: string
  /** ISO-8601 with an explicit offset. When the fact happened, not when it was relayed. */
  readonly occurredAt: string
  readonly producer: ProducerService
  readonly version: EventVersion
  readonly actor: Actor
  /**
   * Ties this event to the request that caused it, across every hop.
   *
   * Never optional. The estate already propagates `x-request-id` and the workflow that depends on
   * it — "paste the id the user quoted" — is the one debugging tool that reliably works today.
   * An event that drops the correlation is where a cross-service investigation stops.
   */
  readonly correlationId: string
  readonly payload: P
}

export interface MakeEventInput<P> {
  readonly topic: TopicName
  readonly key: string
  readonly actor: Actor
  readonly payload: P
  readonly correlationId?: string
  readonly occurredAt?: string | Date
  /** Supplied only when re-emitting a known id, such as a backfill. */
  readonly id?: string
}

/**
 * Build an envelope. `producer` and `version` are taken from the registry rather than passed in,
 * because a producer that can name itself is a producer that can name itself wrongly.
 */
export function makeEvent<P>(input: MakeEventInput<P>): EventEnvelope<P> {
  const spec = TOPICS[input.topic]
  if (!spec) throw new Error(`unknown topic: ${String(input.topic)}`)
  if (input.key === '') {
    throw new Error(`event on ${input.topic} has an empty key; ordering would be undefined`)
  }
  const id = input.id ?? eventId()
  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : (input.occurredAt ?? new Date().toISOString())
  return {
    id,
    topic: input.topic,
    key: input.key,
    occurredAt,
    producer: spec.producer,
    version: spec.version,
    actor: input.actor,
    // An event that starts a story rather than continuing one is its own correlation root.
    correlationId: input.correlationId ?? id,
    payload: input.payload,
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

let lastMillis = -1
let sequence = 0

/**
 * A UUIDv7: 48 bits of Unix milliseconds, then a counter, then randomness.
 *
 * v4 would be a smaller function and the wrong one. Ids here are the outbox primary key and the
 * inbox dedupe key, and 04-domain-model §0 requires v7 throughout so that a b-tree insert is
 * append-only and a relay can page through the outbox by id. Random ids scatter writes across the
 * index and give no ordering to page by.
 *
 * The counter is seeded randomly in the low half of its range each millisecond and incremented
 * within one, so ids minted in the same millisecond still sort in creation order. If the clock
 * steps backwards the previous millisecond is kept: an id that sorts before rows already written
 * would make the relay skip them forever.
 */
export function eventId(now: number = Date.now()): string {
  if (now > lastMillis) {
    lastMillis = now
    sequence = randomInt(0, 0x800)
  } else {
    sequence += 1
    if (sequence > 0xfff) {
      lastMillis += 1
      sequence = randomInt(0, 0x800)
    }
  }
  const bytes = randomBytes(16)
  bytes.writeUIntBE(lastMillis, 0, 6)
  bytes.writeUInt8(0x70 | ((sequence >> 8) & 0x0f), 6)
  bytes.writeUInt8(sequence & 0xff, 7)
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The consumer inbox key: unique on `(topic, event_id)`.
 *
 * The database constraint is on the pair of columns and that is what actually enforces
 * exactly-once handling. This returns the same pair as one string, for the in-memory set a
 * handler uses inside a batch, and it uses a separator that cannot occur in either half so that
 * two different pairs can never collide into one key.
 */
export function inboxKey(event: Pick<EventEnvelope, 'topic' | 'id'>): string {
  return `${event.topic}\u0000${event.id}`
}

/**
 * Which relay shard owns a `(topic, key)`.
 *
 * The relay job leases on `topic_shard` (04-domain-model §10.5). Ordering per `(topic, key)`
 * survives only if every event for one key is claimed by one lease, so the mapping has to be a
 * pure function of the key rather than round-robin over rows. FNV-1a: not a good hash, an
 * adequate and utterly stable one — it must return the same shard in every service, in every
 * language, forever.
 */
export function relayShard(topic: string, key: string, shards: number): number {
  if (!Number.isInteger(shards) || shards < 1) throw new RangeError('shards must be >= 1')
  let hash = 0x811c9dc5
  const input = `${topic}\u0000${key}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % shards
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Serialise with the envelope fields in a fixed order.
 *
 * A signature is over bytes, so the producer must be able to reproduce exactly the bytes it
 * signed and a consumer must be able to check them. Verification should always use the raw
 * request body where it is available; this exists so a producer emits one canonical spelling and
 * so tests are not comparing incidental key order.
 */
export function serialiseEvent(event: EventEnvelope): string {
  return JSON.stringify({
    id: event.id,
    topic: event.topic,
    key: event.key,
    occurredAt: event.occurredAt,
    producer: event.producer,
    version: event.version,
    actor: event.actor,
    correlationId: event.correlationId,
    payload: event.payload,
  })
}

/**
 * Validate an already-parsed value as an envelope.
 *
 * Note what is deliberately *not* checked: whether the version is one this consumer can read.
 * That is `acceptsVersion`, and it is separate because a well-formed event at an unreadable
 * version belongs in the dead-letter view with its version recorded, whereas a malformed event
 * belongs in the rejection log. Collapsing the two loses the distinction that tells an operator
 * whether to redeploy or to page the producer's owner.
 */
export function validateEnvelope(value: unknown): Validated<EventEnvelope> {
  const collected = collectEnvelopeDefects(value)
  // The registry defect first, exactly where the topic block used to push it, so the order and the
  // wording of this function's errors are unchanged by the split.
  const errors = [
    ...(collected.unregisteredTopic === null ? [] : [unregisteredTopicMessage(collected.unregisteredTopic)]),
    ...collected.defects,
  ]
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: value as EventEnvelope }
}

function unregisteredTopicMessage(topic: string): string {
  return `topic: "${topic}" is not in this registry; contracts-events may be behind`
}

interface CollectedDefects {
  /**
   * The topic, when it is a well-formed name this build's registry does not carry. Kept APART from
   * `defects` because it is a different fact with a different remedy — see `classifyEnvelope`.
   */
  readonly unregisteredTopic: string | null
  /** Every other reason a contract-following consumer would refuse this envelope. */
  readonly defects: readonly string[]
}

function collectEnvelopeDefects(value: unknown): CollectedDefects {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { unregisteredTopic: null, defects: ['envelope: expected a JSON object'] }
  }
  const record = value as Record<string, unknown>

  const topic = record['topic']
  let spec: TopicSpec | undefined
  let unregisteredTopic: string | null = null
  if (typeof topic !== 'string') {
    errors.push('topic: missing')
  } else if (!isValidTopicName(topic)) {
    errors.push(`topic: "${topic}" is not <service>.<aggregate>.<past-tense-verb> in lowercase`)
  } else if (!isRegisteredTopic(topic)) {
    // A lagging consumer meeting a topic added after its copy of this package was published.
    unregisteredTopic = topic
  } else {
    spec = TOPICS[topic]
  }

  const id = record['id']
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) errors.push('id: expected a UUID')

  const key = record['key']
  if (typeof key !== 'string' || key === '') errors.push('key: missing; ordering would be undefined')

  const occurredAt = record['occurredAt']
  if (typeof occurredAt !== 'string' || !ISO_PATTERN.test(occurredAt)) {
    errors.push('occurredAt: expected an ISO-8601 instant with an explicit offset')
  } else if (Number.isNaN(Date.parse(occurredAt))) {
    errors.push(`occurredAt: "${occurredAt}" is not a real instant`)
  }

  const producer = record['producer']
  if (typeof producer !== 'string') {
    errors.push('producer: missing')
  } else if (spec && producer !== spec.producer) {
    // The topic namespace is the ownership boundary. A service publishing under another's prefix
    // is either a copy-paste or an impersonation, and neither should reach a handler.
    errors.push(`producer: "${producer}" does not own topic "${String(topic)}" (${spec.producer} does)`)
  }

  const version = record['version']
  if (typeof version !== 'string') {
    errors.push('version: missing')
  } else {
    const parsed = parseVersion(version)
    if (!parsed.ok) errors.push(...parsed.errors)
  }

  const actor = record['actor']
  if (typeof actor !== 'string') {
    errors.push('actor: missing')
  } else {
    const parsed = parseActor(actor)
    if (!parsed.ok) errors.push(...parsed.errors)
  }

  const correlationId = record['correlationId']
  if (typeof correlationId !== 'string' || correlationId === '') {
    errors.push('correlationId: missing; a cross-service investigation stops here')
  }

  if (!('payload' in record)) errors.push('payload: missing')

  return { unregisteredTopic, defects: errors }
}

/** Parse a delivered body. A malformed body is a validation failure, never a thrown SyntaxError. */
export function parseEvent(json: string): Validated<EventEnvelope> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    return invalid([`envelope: not JSON (${err instanceof Error ? err.message : String(err)})`])
  }
  return validateEnvelope(parsed)
}

/**
 * The two facts `validateEnvelope`'s error list cannot separate, separated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **"MALFORMED" AND "NOT IN THIS REGISTRY" ARE DIFFERENT FACTS WITH DIFFERENT REMEDIES.**
 *
 * A malformed envelope is a **producer bug**: someone stamped the wire `version` as the integer `1`
 * rather than `'1.0'`, and every consumer refuses the event at the envelope, so it is never
 * delivered at all — invisible to every per-service suite, because each tests against its own fake.
 * That happened in four services at once. The remedy is a code change in the producer, today.
 *
 * An unregistered topic is a **missing registration**, and usually not a fault at all: a consumer
 * whose copy of this package predates a topic its producer already emits. This package is
 * additive-only, so the honest reading is that the CONSUMER is behind. The remedy is a release,
 * and in the meantime the event is quarantined rather than dropped. Collapsing the two is what let
 * eleven `notify` rules sit for months naming topics no producer emits.
 *
 * **Why this belongs here and not in a new package.** Four services — `market`, `trade`,
 * `community`, `devplatform` — each carry a byte-identical `envelopeDefects` that makes this
 * distinction by **string-matching the error message**:
 *
 *     const excused = `topic: "${topic}" is not in this registry; contracts-events may be behind`
 *     return verdict.errors.filter((error) => error !== excused)
 *
 * A prose error message is not an interface. Reword that sentence by one character and all four
 * copies silently stop excusing anything, every quarantined topic starts reading as a producer
 * bug, and four suites go red for a reason that has nothing to do with what they test. A fifth
 * copy was about to be written in `settlement`. The check is a property of the contract, so it
 * belongs beside the contract — this is an argument for FEWER packages, not more, and the answer
 * is one exported function rather than a `contracts-envelope`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export type EnvelopeVerdict =
  | {
      readonly ok: true
      readonly reason: 'valid'
      readonly value: EventEnvelope
      readonly defects: readonly string[]
      readonly unregisteredTopic: null
    }
  | {
      /**
       * The topic is a well-formed name this build's registry does not carry, and **nothing else
       * is wrong**. A consumer behind its producer. Quarantine, do not drop, and do not page.
       */
      readonly ok: false
      readonly reason: 'unregistered_topic'
      readonly value: null
      readonly defects: readonly []
      readonly unregisteredTopic: string
    }
  | {
      /**
       * At least one defect that is not a missing registration. A producer bug, and `defects` names
       * every one of them — not just the first, so a producer fixing this needs one round.
       *
       * `unregisteredTopic` is still reported when it applies, because an envelope can be both and
       * hiding half of it would send the author to fix one thing twice.
       */
      readonly ok: false
      readonly reason: 'malformed'
      readonly value: null
      readonly defects: readonly string[]
      readonly unregisteredTopic: string | null
    }

/**
 * Classify an already-parsed value. The same checks as `validateEnvelope`, structured.
 *
 * A producer's own suite runs this against an envelope its relay actually built — which is the only
 * way to find out it is unreadable without waiting for two services to be composed, and composing
 * two services is how the integer-version defect was found the first time, months late.
 */
export function classifyEnvelope(value: unknown): EnvelopeVerdict {
  const collected = collectEnvelopeDefects(value)
  if (collected.unregisteredTopic === null && collected.defects.length === 0) {
    return {
      ok: true,
      reason: 'valid',
      value: value as EventEnvelope,
      defects: [],
      unregisteredTopic: null,
    }
  }
  if (collected.unregisteredTopic !== null && collected.defects.length === 0) {
    return {
      ok: false,
      reason: 'unregistered_topic',
      value: null,
      defects: [],
      unregisteredTopic: collected.unregisteredTopic,
    }
  }
  return {
    ok: false,
    reason: 'malformed',
    value: null,
    defects: collected.defects,
    unregisteredTopic: collected.unregisteredTopic,
  }
}

/**
 * A producer's self-check: every reason a contract-following consumer would refuse this envelope,
 * with a missing registration excused only for the topics the caller says it is waiting on.
 *
 * This is the four duplicated copies, once. `awaitingRegistration` is the producer's own quarantine
 * list — a topic it emits and has proposed for registration — and nothing else is forgiven. An
 * empty list, the default, forgives nothing.
 *
 * ## This function shipped LOSSY, and why it was fixed rather than deleted
 *
 * The first cut branched on `verdict.reason` and returned `verdict.defects` for `malformed` — which
 * **dropped `unregisteredTopic` whenever any other defect was present**. An envelope on an
 * unproposed topic that also stamped `version` as the integer `1` reported only `version: missing`,
 * so the author fixed the version, redeployed, and only then learned the topic was never
 * registered. That is the precise round-trip the `EnvelopeVerdict` doc above promises not to cost
 * ("`unregisteredTopic` is still reported when it applies... hiding half of it would send the
 * author to fix one thing twice"), so the wrapper defeated the benefit its own package documents.
 * It was caught by the first repository to try adopting it; all four of `market`, `trade`,
 * `community` and `devplatform` kept a local flattening over `classifyEnvelope` because of it.
 *
 * Deleting it was the other defensible answer — a lossy convenience over a correct primitive earns
 * nothing. It is kept because the loss was never intrinsic to flattening, only to that branch. What
 * makes it worth keeping is that the honest flattening is **total**, and that is now an invariant
 * rather than a hope: with an empty `awaitingRegistration`, this returns exactly
 * `validateEnvelope(value).errors`, in the same order, message for message. It is `validateEnvelope`
 * plus one excusal list — nothing more, so there is nothing left for it to lose. Delete it and the
 * five repositories that need the excusal each re-derive it, which is the duplication that put this
 * function here in the first place.
 *
 * The reason it shipped is that no test in this package ever ran the both-at-once case THROUGH the
 * wrapper: `classifyEnvelope` had one and was right, and the wrapper's own test asserted only that
 * the version defect survived. `envelopeDefects is exactly validateEnvelope plus the excusal` now
 * pins the totality across a table of envelopes, so no future branch can quietly swallow a fact.
 */
export function envelopeDefects(
  value: unknown,
  awaitingRegistration: readonly string[] = [],
): readonly string[] {
  const verdict = classifyEnvelope(value)
  // Reported FIRST, exactly where `validateEnvelope` puts it, so a reader of a failure sees the
  // registry question before the envelope's own faults — and so the two lists are comparable.
  const unexplained =
    verdict.unregisteredTopic !== null && !awaitingRegistration.includes(verdict.unregisteredTopic)
      ? [unregisteredTopicMessage(verdict.unregisteredTopic)]
      : []
  return [...unexplained, ...verdict.defects]
}

// ---------------------------------------------------------------------------
// Delivery signatures
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = 'cf-signature'
export const EVENT_ID_HEADER = 'cf-event-id'
export const TOPIC_HEADER = 'cf-topic'

/**
 * How old a delivery may be and still be honoured, in milliseconds.
 *
 * Five minutes is long enough to absorb a relay retry and a few seconds of clock skew, and short
 * enough that a captured request is not a lasting credential. Redelivery after the window is a
 * new signature, which the relay produces for free on its next attempt.
 */
export const DELIVERY_TOLERANCE_MS = 300_000

export type DeliveryFailure =
  | 'malformed_header'
  | 'unsupported_scheme'
  | 'stale'
  | 'future'
  | 'mismatch'

export type DeliveryVerification =
  | {
      readonly ok: true
      /** Which secret matched. Non-zero means the endpoint is still accepting a rotated-out key. */
      readonly keyIndex: number
    }
  | { readonly ok: false; readonly reason: DeliveryFailure }

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

/**
 * Sign a delivery body.
 *
 * The timestamp is inside the signed message, not merely beside it, so it cannot be moved
 * without invalidating the signature — which is what makes the freshness window mean anything.
 * The `v1=` prefix is there so a future scheme can be added without every subscriber and every
 * developer webhook having to change on the same day.
 */
export function signDelivery(body: string, secret: string, at: number = Date.now()): string {
  const seconds = Math.floor(at / 1000)
  return `t=${seconds},v1=${hmacHex(secret, `${seconds}.${body}`)}`
}

/**
 * Verify a delivery.
 *
 * `secrets` is a list because rotation must not require both ends to change in the same instant:
 * an endpoint publishes a new secret, accepts both for a window, then drops the old one. All
 * candidates are tried, and every comparison is timing-safe — this is the check that stands
 * between an unauthenticated POST and a handler that credits money.
 */
export function verifyDelivery(
  body: string,
  header: string,
  secrets: string | readonly string[],
  options: { readonly now?: number; readonly toleranceMs?: number } = {},
): DeliveryVerification {
  const now = options.now ?? Date.now()
  const tolerance = options.toleranceMs ?? DELIVERY_TOLERANCE_MS

  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim())
  }
  const timestamp = parts.get('t')
  const provided = parts.get('v1')
  if (timestamp === undefined) return { ok: false, reason: 'malformed_header' }
  if (provided === undefined) {
    // A header carrying only an unknown scheme is a version problem, not a forgery, and the
    // operator needs to be able to tell those apart in the delivery-failure view.
    return { ok: false, reason: parts.size > 1 ? 'unsupported_scheme' : 'malformed_header' }
  }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'malformed_header' }
  if (!/^[0-9a-f]+$/.test(provided)) return { ok: false, reason: 'malformed_header' }

  const signedAt = Number(timestamp) * 1000
  if (now - signedAt > tolerance) return { ok: false, reason: 'stale' }
  // Clock skew forward is accepted up to the same window; beyond it, someone is choosing the
  // timestamp, which is the replay this design exists to stop.
  if (signedAt - now > tolerance) return { ok: false, reason: 'future' }

  const candidates = typeof secrets === 'string' ? [secrets] : secrets
  const providedBytes = Buffer.from(provided, 'hex')
  for (let index = 0; index < candidates.length; index += 1) {
    const secret = candidates[index]
    if (secret === undefined) continue
    const expected = Buffer.from(hmacHex(secret, `${timestamp}.${body}`), 'hex')
    // Length is compared first because timingSafeEqual throws on a mismatch. A digest length is
    // public knowledge, so leaking it leaks nothing.
    if (expected.length === providedBytes.length && timingSafeEqual(expected, providedBytes)) {
      return { ok: true, keyIndex: index }
    }
  }
  return { ok: false, reason: 'mismatch' }
}

// The operator audit log's view of this registry. A separate module so that adding a topic to
// `TOPICS` above and deciding whether the audit log carries it are one commit but not one hunk.
export * from './audit.ts'
