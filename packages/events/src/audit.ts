/**
 * The operator audit log, fed from the bus that already exists.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DECISION: `*.audit.recorded` SHOULD NOT EXIST, AND IS NOT REGISTERED HERE.**
 *
 * `admin-api/src/server.ts` declares `AUDIT_MIRROR_TOPIC_SUFFIX = '.audit.recorded'` and its
 * intake is built, signed, scoped and deduped correctly. That string appears in exactly
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
 *                       naming rule here AND the `action` format `admin-api/src/audit.ts`
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
  'identity.email.verification_requested': {
    audited: true,
    subjectKind: 'user',
    outcome: 'allowed',
    /*
     * Audited, unlike `identity.session.created`, and the two are worth telling apart.
     *
     * Volume is what excludes sign-ins: one row per login per user, for ever. A verification is
     * asked for once per account plus each resend, so the row count is bounded by sign-ups rather
     * than by usage — the same shape as `identity.user.registered` beside it, which is audited.
     *
     * And it is the one event that says an address was CLAIMED. "Who asked for a link to this
     * address, and when" is the question any dispute about account ownership starts from, and the
     * event carries a single-use credential: an audited request is what makes a resend storm or a
     * claim on somebody else's address visible after the fact rather than only in a log that
     * rotates.
     */
  },
  'identity.password.reset_requested': {
    audited: true,
    subjectKind: 'user',
    outcome: 'allowed',
    /*
     * Audited for the reason its sibling above is, and one more.
     *
     * Bounded volume: a reset is asked for rarely and per account, so this is not the sign-in
     * problem. And it is the single strongest account-takeover signal the estate produces — "who
     * asked to replace the credential on this account, and when" is where every dispute about a
     * compromised account starts, and the event carries a live single-use credential. An operator
     * who cannot answer that after the fact cannot tell a takeover from a forgetful user.
     */
  },
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
  // `failed`, and it is the clearest case in this table for that outcome: a customer's money
  // arrived at an address the platform controls and no ledger entry accounts for it. An operator
  // filtering the log for failures is filtering for exactly this — money the estate is holding
  // against a liability it never recorded — and the row is the only durable trace outside
  // micro-wallet's own table. micro-org#200.
  'wallet.deposit.token_uncredited': {
    audited: true,
    subjectKind: 'wallet',
    outcome: 'failed',
  },
  'wallet.withdrawal.requested': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  // An address the platform will credit money arriving at. "Which address did we give this person,
  // and when" is an incident question, and it had no answer.
  'wallet.deposit_address.assigned': {
    audited: true,
    subjectKind: 'deposit_address',
    outcome: 'allowed',
  },
  // The moment an external address became spendable-to. It is the control a withdrawal to a
  // stranger's address would have to defeat, so it must be provable after the fact.
  'wallet.link.verified': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  'wallet.link.revoked': { audited: true, subjectKind: 'wallet', outcome: 'allowed' },
  // `failed`: a refund is money a customer asked to withdraw and did not get, however correctly
  // the balance was returned.
  'wallet.withdrawal.refunded': { audited: true, subjectKind: 'withdrawal', outcome: 'failed' },
  'wallet.withdrawal.stuck': { audited: true, subjectKind: 'withdrawal', outcome: 'failed' },
  'settlement.withdrawal.completed': {
    audited: true,
    subjectKind: 'withdrawal',
    outcome: 'allowed',
  },
  // `failed`, deliberately: a stuck withdrawal is money that a customer asked for and did not get.
  'settlement.withdrawal.stuck': { audited: true, subjectKind: 'chain_network', outcome: 'failed' },
  // `failed` for the same reason, and this one carries the refund decision. `refundable` is what
  // wallet reads to return the reservation to a user's balance (wallet/src/server.ts), so it is
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
  // NOT audited, and this one needed arguing rather than labelling, because the obvious reading —
  // "an offer is a bid, not a transfer, so no money moves" — is FALSE. `makeOffer` calls
  // `holdEscrow` (market/src/bids.ts), which calls `ledger.postEntry` with `reservePostings`
  // (market/src/escrow.ts) before the offer row is even returned. Making an offer reserves the
  // offerer's money. The reason it is still excluded is the settlement.outbound.confirmed reason,
  // not the simulation one: that reservation IS already in the operator log, as the richer of the
  // two rows.
  'market.offer.made': {
    audited: false,
    why:
      'The money an offer moves is already audited, by the row that actually names it. holdEscrow ' +
      '(market/src/escrow.ts:145) posts a ledger entry for the reservation, and ledger emits ' +
      'ledger.entry.posted for every posted entry (ledger/src/entries.ts:441) — which IS audited ' +
      'above, keyed by the entry, carrying both postings and the amount. This envelope carries ' +
      'neither account and is keyed by the listing, so mirroring it as well would put a second, ' +
      'thinner row in the log for one reservation of one buyer\'s money, and an operator asking ' +
      '"where did this go" would see it held twice. The platform is also not a party to an offer ' +
      'and exercises no authority over one: it is a buyer bidding their own funds, refused ' +
      'outright when the offerer is the seller (bids.ts:417). The point at which the platform ' +
      'becomes a party is the SALE, and market.listing.sold is audited above. Volume settles what ' +
      'is left — an offer is the high-volume half of a marketplace and most of them expire or are ' +
      'declined, so auditing them would bury the sales that matter under bids that came to ' +
      'nothing. If a future offer path ever moves money the ledger does not see, this decision is ' +
      'wrong and must be revisited here.',
  },
  'mint.deploy.confirmed': { audited: true, subjectKind: 'token', outcome: 'allowed' },
  // Treasury money leaving for an address the platform itself controls, and the ONLY record of it
  // on the bus: settlement plans this as a `gas_topup` outbound, and `settlement/src/worker.ts`
  // deliberately emits nothing when a top-up confirms. Excluding the request would leave an
  // operator asking "why did the treasury balance drop" with nothing to read.
  // `allowed` rather than `failed` even though it reports a deploy that cannot proceed: a freshly
  // derived deployer address always holds zero, so this fires once on the happy path of EVERY paid
  // deploy. Filed as a failure it would bury the rows that are genuinely failures.
  'mint.deploy.funding_requested': { audited: true, subjectKind: 'token', outcome: 'allowed' },
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

  /* ---------------------------------------------------------------- credentials that act as a user */
  // An API key is a credential with NO password and NO second factor behind it: whoever holds it
  // acts as the account until it is revoked. That puts these two on exactly the identity side of
  // the dividing line — "an account's security changing" — and issuance by somebody other than the
  // owner is the first thing a compromise looks like. `subjectKind` is `api_key` because the key
  // holds `key_id` (`TopicSpec.keyedBy`), and a subject kind that names something other than the
  // envelope key is a console filter that returns the wrong rows.
  'devplatform.key.issued': { audited: true, subjectKind: 'api_key', outcome: 'allowed' },
  // `allowed`, not `failed`: a revocation is a control working, not a customer being denied
  // something. It is the row that proves WHEN a credential stopped being valid, which is the
  // question asked after every leaked-key incident.
  'devplatform.key.revoked': { audited: true, subjectKind: 'api_key', outcome: 'allowed' },

  /* ----------------------------------------------------------------- automated trading
   *
   * SEVEN topics now, and this block used to hold one. The entry below promised that when
   * `trade.fill.settled` and `trade.fee.settled` were registered "this table will demand a
   * decision about it, and that decision should be yes". micro-org#345 registered them and four
   * others; the promise is kept literally — the four that move money are audited, and the two that
   * do not each say why at the length of a decision.
   *
   * The dividing line inside `trade` is NOT "is it about trading". It is the same line as
   * everywhere else in this table: **does an operator have to be able to reconstruct, afterwards,
   * where a customer's money went.** `bot.created` and `bot.paused` are a user arranging their own
   * automation and no posting is made on either; `bot.started` is where the platform reserves the
   * capital through the ledger, and from there every one of the remaining four carries a journal
   * entry or a balance movement.
   */
  'trade.bot.created': {
    audited: false,
    why:
      'Configuration, not a movement. `insertBot` writes the row and sets the bot\'s own cash and ' +
      'equity mirror to the allocation the user typed; the ledger is not called at all until the ' +
      'bot is STARTED, which is the entry below and which is audited for exactly that reason. So ' +
      'an operator reconstructing where a customer\'s money went learns nothing here that ' +
      'trade.bot.started does not carry, and it is always the owner configuring their own ' +
      'automation, so there is no operator authority to prove afterwards. Registering an ' +
      'intention is not the same fact as acting on it, and auditing both would put two rows in ' +
      'front of an investigator for one movement — the tessera.parcel.transferred argument.',
  },
  // The moment the platform takes capital out of a customer's balance and holds it. `startBot`
  // calls the ledger's `reserve` as `service:trade` — the service acting on the user's money under
  // its own authority — and the reservation entry id it returns is the ONLY handle anybody has on
  // where the allocation went; `trade.bot.paused` below is explicit that the reservation is still
  // outstanding after a pause, so this row is what an investigator holds until the bot is stopped.
  // `bot`, because the key is `bot.id` (`TopicSpec.keyedBy: 'bot_id'`).
  'trade.bot.started': { audited: true, subjectKind: 'bot', outcome: 'allowed' },
  'trade.bot.paused': {
    audited: false,
    why:
      'No money moves. Pause is deliberately NOT a flatten — `pauseBot` leaves the position open ' +
      'and the ledger reservation taken at start untouched — so an operator reconstructing where ' +
      'a user\'s money went learns nothing from this row that trade.bot.started did not already ' +
      'give them. It is also always the user acting on their own automation: the single caller is ' +
      'the bot actions route and the actor is always that bot\'s owner, so there is no operator ' +
      'authority to prove afterwards. The trade facts that DO move money are the four audited in ' +
      'this block, which is the commitment this entry used to make in the future tense.',
  },
  // A bot spent or received a customer's Shards against the ledger, and the payload carries the
  // journal `entryId` that proves it. `fill`, because the key is the fill's own id and not the
  // bot's — `trade/src/topics.ts` argues that partition at length.
  'trade.fill.settled': { audited: true, subjectKind: 'fill', outcome: 'allowed' },
  // THE PLATFORM CHARGING A CUSTOMER. A performance fee is money leaving an account on the
  // estate's own initiative rather than the customer's, which is the strongest case in this whole
  // table for a row an operator can produce afterwards: "why was I billed this" is answerable from
  // the settlement id, the period and the entry, or it is not answerable at all.
  'trade.fee.settled': { audited: true, subjectKind: 'fee_settlement', outcome: 'allowed' },
  // One order crossing the book moves the balances of TWO customers, and the exchange is the
  // platform's own venue rather than a third party's. `order`, the taker's, matching `keyedBy`.
  // Behind TRADE_EXCHANGE_ENABLED, and decided now for the reason the registry entry gives: the
  // day the flag goes on is the worst day to discover the log has no opinion about it.
  'trade.order.filled': { audited: true, subjectKind: 'order', outcome: 'allowed' },
  // Money crossing the boundary between a customer's wallet and their exchange balance — the one
  // trade event that corresponds to a ledger entry a reconciliation can be run against. This is
  // the same fact wallet's own deposit and withdrawal topics are audited for, on the other side of
  // the same boundary; auditing one end and not the other would leave a movement with a row at its
  // origin and none at its destination.
  'trade.transfer.settled': { audited: true, subjectKind: 'exchange_transfer', outcome: 'allowed' },

  /* ---------------------------------------------------------------- a world, and one thing in it */
  //
  // FIVE of Tessera's seven are simulation on the same reading as the two games above: an operator
  // has no authority over a claim or a firing, and the title service owns the record. Two are not,
  // for two DIFFERENT reasons, and both are worth stating rather than letting the SIMULATION label
  // absorb them — 23-tessera.md is the first design in this estate where a title moves money OUT
  // to a person, so "it is a game, therefore it is simulation" is exactly the inference this table
  // should stop being able to make quietly.
  //
  // `tessera.object.anchored` is audited: the platform acts with authority over a user's property.
  // `tessera.venue.booked` is NOT audited, but not because it is a game — it moves real money, and
  // the reason it is excluded is that the money is already audited by the row that names it. That
  // entry is written out in full below, because a booking carrying a ledger reservation is
  // precisely the "money topic added to a game service" this helper's docstring exists to catch.
  'tessera.parcel.claimed': { audited: false, why: SIMULATION('ground being claimed') },
  'tessera.parcel.fallowed': { audited: false, why: SIMULATION('a parcel going quiet') },
  'tessera.parcel.transferred': {
    audited: false,
    why:
      'A parcel changing hands is a trade between two players, and the platform is not a party to ' +
      'it: land is claimed free and never sold by the platform (23-tessera.md §4), so there is no ' +
      'operator authority to prove afterwards. The MONEY half of a parcel trade is a ' +
      'micro-market order, and market.listing.sold is the row that proves where the payment went ' +
      '— auditing this one as well would record the same transaction twice, once without its ' +
      'amount.',
  },
  'tessera.object.fired': { audited: false, why: SIMULATION('an object coming out of the Kiln') },
  'tessera.ward.opened': { audited: false, why: SIMULATION('a ward minting at 70% occupancy') },
  'tessera.venue.booked': {
    audited: false,
    why:
      'NOT simulation, and calling it that would be the mistake this table watches for: a booking ' +
      'moves real money. An open booking is refused unless it names an escrowed ledger ' +
      'reservation — `bookings_open_holds_money` (tessera/src/migrations.ts:916) is a CHECK that a ' +
      "row with status 'open' has a non-null reservation_id — so a free hold on somebody else's " +
      'calendar is unrepresentable rather than discouraged. It is excluded for the reason ' +
      'market.offer.made is: the money is already audited by the row that actually names it. The ' +
      'reservation is a balanced posting pair in micro-ledger, and ledger emits ' +
      'ledger.entry.posted for it — which IS audited above, keyed by the entry, carrying both ' +
      'postings and the amount. This envelope carries priceWei and the reservation id but NEITHER ' +
      'ACCOUNT, and it is keyed by parcel_id because the contended resource is the calendar, not ' +
      'the money. Mirroring it would put a second, thinner row in the log for one reservation of ' +
      "one player's funds, and an operator asking \"where did this go\" would see it held twice. " +
      "The platform is also not a party: it is a player booking a slot on another player's venue " +
      'with their own funds. Two things would make this decision wrong and both must be ' +
      'revisited HERE, not silently: if the booking path ever moves money the ledger does not ' +
      'see, or if the platform ever takes a cut at booking time rather than at settlement.',
  },
  // The exception, and the reason it is one:
  //
  // Anchoring writes an authorship claim to a public chain, from a PLATFORM key, on a user's
  // behalf. It is irreversible, it is externally visible for ever, and the account it names as
  // author is a claim the platform made rather than one the user signed — 23-tessera.md §9.3 is
  // explicit that a player cannot sign through custody today (`user` is excluded from the signing
  // purposes at custody/src/gates.ts), so v1 anchors with a platform key and v2 is gated on
  // that changing. That is precisely "the platform acted with authority over a user's property",
  // which is what this log exists to hold.
  //
  // `subjectKind` is `user` because the operator question afterwards is "whose authorship did we
  // write", and the answer must join to a person rather than to an object id. The envelope key is
  // the OBJECT id, so the payload carries `authorSubject` and the audit consumer reads that —
  // stated here because the custody defect this table's header records was exactly the opposite
  // mistake, a subjectKind naming something the envelope key did not hold.
  'tessera.object.anchored': { audited: true, subjectKind: 'user', outcome: 'allowed' },

  /* ------------------------------------------------------------------ the public square
   *
   * FOURTEEN topics, and TWO of them are audited. That ratio is the point rather than an oversight,
   * and the line between them is the sharpest in this table because it is not about money.
   *
   * The estate's audited topics are all "the platform acted, or a customer's money moved". Agora has
   * no money in it at all, so the first half of the test does all the work: **an operator suspending
   * a voice or removing a post is the platform exercising authority over a person's speech, and
   * there has to be a row proving what was done, by whom and against which report.** Those two are
   * `agora.voice.suspended` and `agora.moderation.acted`, and the appeal that follows is answered
   * from them or it is answered from nothing.
   *
   * Everything else on this service is people talking to each other, and `SQUARE` below argues why
   * copying that into a hash-chained 730-day evidence log would be actively harmful rather than
   * merely noisy. `agora.report.filed` is the one that looks like it belongs and does not — the
   * argument is written out in full at its entry, because "somebody complained" reads like a
   * security fact and is not one.
   */
  'agora.post.created': { audited: false, why: SQUARE('a post being published') },
  'agora.post.edited': { audited: false, why: SQUARE('somebody correcting a typo') },
  'agora.post.deleted': {
    audited: false,
    why:
      'The sharpest case for SQUARE, and worth stating rather than folding into it: the audit log ' +
      'is hash-chained and kept for years, so a mirror of this topic would be a permanent record ' +
      'that a person deleted something — and, joined against the creation event, a record that it ' +
      'existed at all. Auditing deletion is how a delete button becomes a lie. An operator who ' +
      'REMOVES a post is a different fact and is audited: agora.moderation.acted below.',
  },
  'agora.spark.created': { audited: false, why: SQUARE('a like') },
  'agora.echo.created': { audited: false, why: SQUARE('a repost') },
  'agora.voice.renamed': {
    audited: false,
    why:
      'A handle is a display name on one service, not a credential and not an identity: the ' +
      'account behind it is unchanged, identity is untouched, and nothing an operator controls ' +
      'happened. It is registered because a mention or a link that named the old handle is now ' +
      'wrong and consumers need to hear that, which is a cache-invalidation fact rather than a ' +
      'security one. The security-relevant renames — an email or an MFA factor changing — are ' +
      "identity's topics, and those ARE audited above.",
  },
  'agora.follow.created': { audited: false, why: SQUARE('one person following another') },
  'agora.bar.created': {
    audited: false,
    why:
      'A bar is somebody protecting themselves, and it is the single most sensitive row this ' +
      'service holds: it names two people and states that one of them wants nothing to do with the ' +
      'other. 41-agora.md is explicit that the barred voice is never told, and a permanent ' +
      'operator-readable record of every bar is exactly the thing that makes "never told" depend ' +
      'on nobody looking. There is also no operator authority to prove — the platform did not act, ' +
      'a user did — so the log would hold a personal safety decision and no accountability.',
  },
  'agora.circle.created': { audited: false, why: SQUARE('a group being opened') },
  'agora.whisper.sent': {
    audited: false,
    why:
      'A private message between two people, and the ONE topic in this registry where mirroring ' +
      'metadata would be worse than mirroring content. The payload deliberately carries no body — ' +
      'only the two voices and a length — so an audit row would add nothing an operator could act ' +
      'on and everything a subpoena could read: who talked to whom, when, and how much, for every ' +
      'pair on the square, retained for years and chained so it cannot be edited. That is a ' +
      'surveillance archive built as a side effect of a feature nobody asked for it in.',
  },
  'agora.report.filed': {
    audited: false,
    why:
      'This is the entry that looks like it belongs here and does not. A report is a USER asking ' +
      'for review, not the platform acting: no authority has been exercised yet and there is ' +
      'nothing to prove afterwards. The moment authority IS exercised, agora.moderation.acted ' +
      'carries the reportId, so the operator question — "why was this removed, and on what ' +
      'complaint" — is answerable from the audited row alone. Auditing both would also defeat a ' +
      "rule the service is built around: the envelope's actor is the reporter, and 41-agora.md " +
      'says the subject is never told who reported them. A permanent, exportable log keyed by the ' +
      'thing reported, with the reporter in the actor column, is one careless console view away ' +
      'from being that disclosure. The moderation queue shows an operator what they need while ' +
      'the report is open; the evidence chain does not need to keep it for ever.',
  },
  // THE PLATFORM SILENCING A PERSON. A suspension is not a game state and not a preference — it is
  // this service withdrawing somebody's right to speak on it, taken by an operator, against an
  // account that keeps working everywhere else in the estate. If there is one row on this service
  // an appeal must be able to produce, it is this one. `voice`, matching `keyedBy: 'voice_id'`.
  'agora.voice.suspended': { audited: true, subjectKind: 'voice', outcome: 'allowed' },
  // The general case of the same fact: an operator dismissed a report, removed a post, or lifted a
  // suspension, and the payload carries who did it and which report it resolves.
  //
  // `subjectKind` is `agora_subject` rather than `post`, and that is the header's rule doing work
  // rather than being quoted. This topic is keyed by `subject_id`, which is a POST id, a VOICE id
  // or a CIRCLE id depending on what was acted upon — the discriminator is `subjectKind` in the
  // payload. Writing `post` here would be precisely the custody defect this table's header records:
  // a subjectKind naming something the envelope key does not always hold, so a console filtering on
  // it returns the wrong rows and silently omits every suspension.
  'agora.moderation.acted': { audited: true, subjectKind: 'agora_subject', outcome: 'allowed' },
  'agora.notification.mail_requested': {
    audited: false,
    why:
      'A notification becoming due for mail is plumbing, and the delivery record already exists ' +
      'somewhere better: micro-notify holds every send, its status and its failures, which is ' +
      'where an operator asking "did this person get the mail" already looks. Mirroring the ' +
      'REQUEST here would put a row in the evidence chain for something that may never have been ' +
      'sent, and would build — one row per opted-in notification, retained for years — a record of ' +
      'who was told about whose activity. It carries the account subject, so that record would ' +
      'name people. No authority is exercised: the sweep is a timer acting on a preference the ' +
      'recipient set and can unset.',
  },
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

/**
 * The other reason, spelled once, for the fourteen topics of the public square.
 *
 * It is deliberately NOT `SIMULATION` with a different noun. The game argument is "this does not
 * matter enough to keep"; this one is the opposite — the rows matter a great deal, to the people in
 * them, which is exactly why the operator log must not hold them. An audit log is hash-chained,
 * exported and kept for years; a mirror of ordinary conversation is a permanent, tamper-evident
 * social graph of who spoke to whom, assembled as a side effect and outliving both the post and the
 * person's decision to delete it. Nothing on the square is an operator's to act on except
 * moderation, and moderation has its own two topics that ARE audited.
 */
function SQUARE(what: string): string {
  return (
    `${what} is people using the product, not the platform acting on them. There is no operator ` +
    'authority to prove afterwards and no operator action to take, and the audit log is chained ' +
    'and retained for years — so mirroring it would build a permanent, tamper-evident record of ' +
    'who interacted with whom that outlives the content itself, which is a surveillance archive ' +
    'rather than an accountability one. The two facts on this service that ARE the platform acting ' +
    '— a voice suspended, and a moderation action taken — are audited, and they are the rows an ' +
    'appeal is answered from.'
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
