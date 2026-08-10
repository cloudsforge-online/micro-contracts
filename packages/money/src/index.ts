/**
 * The ledger contract: accounts, journal entries, postings, balances and reconciliation.
 *
 * **This package is the type-level replacement for `forge-pay`'s single-sided `ledger` table.**
 *
 * That table has one `delta` column. There is no account, no counter-account, no journal grouping
 * and therefore no balancing invariant — nothing in the estate can answer "where did this value
 * come from" or "does the money add up". The consequences are all live today:
 *
 * - `wallets.shards` and `coin_balances.amount` are running columns that *are* the truth. Nothing
 *   can check them, because there is no journal to replay them from.
 * - Coin deposits write no ledger row at all, so a credited deposit leaves no accounting trace.
 * - There is no reserved/available split, so a marketplace listing cannot hold funds and the same
 *   balance can be spent twice.
 * - `ledger.source` exists but only the `/internal/*` routes populate it, so per-product revenue
 *   is not derivable from the ledger at all.
 * - `convertCoinToEmber` credits custodial EMBER with no on-chain movement behind it — a
 *   liability minted against nothing, which no reconciliation exists to catch.
 *
 * Every shape below exists to make one of those impossible to express. The centre of it is
 * `balanceEntry`: an entry that does not balance per asset is not an entry, and a system that
 * cannot post an unbalanced entry cannot lose track of value.
 *
 * Everything here is pure. No I/O, no environment, and no dependency but `contracts-chain`, from
 * which all scale and rounding decisions are taken rather than restated.
 *
 * **All money is `bigint`.** There is not a floating-point number anywhere in this file and there
 * is a test that enforces it.
 */

import {
  type AssetCode,
  type Network,
  CHAINS,
  RATE_SCALE,
  SHARDS_PER_USD,
  chainSpec,
  coinAmountForShards,
  formatAmount,
  parseAmount,
  shardsForCoinAmount,
} from '@cloudsforge/contracts-chain'

export type { AssetCode }
// Re-exported so a consumer needs one import to post an entry. These are contracts-chain's
// values, not copies: a second declaration of the Shard rate is exactly the skew this avoids.
export { RATE_SCALE, SHARDS_PER_USD }

/** ISO-8601, UTC, millisecond precision. Business dates are separate explicit fields. */
export type Timestamp = string

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** A tokenised asset, keyed by the URN of the token the `mint` service deployed. */
export type TokenAssetCode = `TOKEN:${string}`

/**
 * What a ledger account may be denominated in.
 *
 * A superset of `contracts-chain`'s `AssetCode`, because the ledger holds two things no chain
 * does: `USD` (administered prices, invoices, payout statements) and `TOKEN:<urn>` (a user-minted
 * token held custodially). The chain asset codes are *imported*, never re-listed — a second list
 * would drift from the confirmation policy that indexes off the first.
 */
export type LedgerAssetCode = AssetCode | 'USD' | TokenAssetCode

/** USD is held as cents. Two places, integer, always. */
export const USD_DECIMALS = 2

export function isChainAsset(code: LedgerAssetCode): code is AssetCode {
  return Object.hasOwn(CHAINS, code)
}

export function isTokenAsset(code: LedgerAssetCode): code is TokenAssetCode {
  return code.startsWith('TOKEN:')
}

/* ─────────────────────────────────────────────── Chain tokens, and the ban on the brand name */

/**
 * An ERC-20-style token asset, named by the DEPLOYMENT it lives at.
 *
 * A subtype of `TokenAssetCode` rather than a narrowing of it, because `TOKEN:` carries two
 * unrelated urn families and always will: this one, and `micro-tessera`'s fired objects
 * (`tessera/src/itemasset.ts` builds `TOKEN:cf:tessera:object:<hex>`). Narrowing the parent
 * would break tessera's build, and every consumer resolves this package by `link:` at HEAD.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## `USDT` IS NOT AN ASSET CODE. NEITHER IS `USDC`. NEITHER IS ANY OTHER BRAND NAME.
 *
 * This is `settlement/src/sweeps.ts`'s rule, promoted here for the reason the Spark rule was
 * promoted into `contracts-chain`: a rule that lives in one service is a rule the next service
 * does not know about. Settlement states it in a comment, `foresight/src/stakeassets.ts`
 * re-derives it as a regex, and `foresight/src/migrations.ts` re-derives it a third time as a
 * CHECK constraint. Three spellings of one rule, and none of them in the contract they all import.
 *
 * The reason is arithmetic, not taste. **Tether is six decimals on Ethereum, six on Tron and
 * eighteen on BSC.** A single `USDT` code forces one exponent onto all three, and a wrong exponent
 * on a stablecoin is a balance wrong by a factor of 10^12 — the same class of silent scale defect
 * as `BigInt('') === 0n`, which this estate has been bitten by before. USDC is the same shape of
 * problem with different numbers, which is why it is named above rather than left to be discovered.
 *
 * The second reason is that one brand code silently asserts a deposit on one chain may be paid out
 * on another. It may not, without a bridge this platform is not and must never become.
 *
 * A brand name is a display grouping for a frontend. It is never a code.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Decimals are deliberately not in the code.** They are a property of the deployment, read from
 * the registry that admitted it, and `assetDecimals` below refuses to guess one. Putting them in
 * the string would make every consumer that parses it a second authority on the number.
 */
export type ChainTokenAssetCode = `TOKEN:${string}:${Network}:0x${string}`

/** The three things that name a token deployment. Decimals are not among them — see above. */
export interface ChainTokenAsset {
  /**
   * The chain slug. Lower-case, and **the estate does not agree on it**: `micro-custody` stores
   * `ethereum` where `micro-settlement` uses `eth` (`settlement/src/sweeps.ts` translates
   * between them). This package deliberately does not invent a third vocabulary to arbitrate
   * that — it validates the shape and leaves the slug to the services that already own one.
   */
  readonly chain: string
  readonly network: Network
  /** Lower-case hex, `0x` and forty digits. Checksum casing is normalised away, never trusted. */
  readonly contract: string
}

/**
 * The one shape a chain token asset code may take: `TOKEN:<chain>:<network>:<0x contract>`.
 *
 * Kept identical to `foresight/src/stakeassets.ts` and `foresight/src/migrations.ts` on
 * purpose, so that promoting this does not quietly admit a code those two would reject.
 */
const CHAIN_TOKEN_CODE = /^TOKEN:([a-z0-9]+):([a-z0-9]+):(0x[0-9a-f]{40})$/

const NETWORKS: readonly string[] = Object.freeze(['mainnet', 'testnet'])

/**
 * Build the ledger asset code for a token deployment, or throw.
 *
 * Throws rather than normalising a bad input, because this is the one place two spellings of one
 * deployment could be born — and two spellings of one deployment are two ledger assets holding
 * halves of one pile of money, with nothing able to notice.
 *
 * The contract is lower-cased on the way in. That is not distrust of the caller's schema: an
 * address arrives EIP-55 checksummed from some sources and lower-case from others, and a
 * normalisation that happens in only some places is the one that gets skipped.
 */
export function chainTokenAssetCode(asset: ChainTokenAsset): ChainTokenAssetCode {
  const code = `TOKEN:${asset.chain}:${asset.network}:${asset.contract.toLowerCase()}`
  if (!CHAIN_TOKEN_CODE.test(code)) {
    throw new RangeError(
      `a chain token asset is TOKEN:<chain>:<network>:<lowercase 0x contract>, not ${code} — ` +
        'a brand name such as USDT or USDC is never a code, because one brand is deployed at ' +
        'several contracts with different decimals',
    )
  }
  return code as ChainTokenAssetCode
}

/** The deployment a code names, or `null` when it names something else — a tessera object, say. */
export function parseChainTokenAsset(code: LedgerAssetCode): ChainTokenAsset | null {
  const matched = CHAIN_TOKEN_CODE.exec(code)
  const [, chain, network, contract] = matched ?? []
  if (chain === undefined || network === undefined || contract === undefined) return null
  if (!NETWORKS.includes(network)) return null
  return { chain, network: network as Network, contract }
}

/**
 * Smallest-unit exponent for any ledger asset.
 *
 * A `TOKEN:` asset has no fixed answer — decimals are chosen at deploy time — so the caller must
 * supply the value the mint recorded. Guessing 18 because most EVM tokens use it would credit a
 * six-decimal token a trillion times over.
 */
export function assetDecimals(assetCode: LedgerAssetCode, tokenDecimals?: number): number {
  if (assetCode === 'USD') return USD_DECIMALS
  if (isChainAsset(assetCode)) return chainSpec(assetCode).decimals
  if (tokenDecimals === undefined) {
    throw new RangeError(`decimals must be supplied for ${assetCode}`)
  }
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new RangeError(`implausible token decimals: ${tokenDecimals}`)
  }
  return tokenDecimals
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * Who an account belongs to.
 *
 * `platform`, `custody`, `clearing` and `exchange` are singletons: there is one platform, one
 * custody position per asset, one clearing position per asset and one exchange escrow per asset,
 * and each is distinguished from the others only by `(assetCode, purpose)`.
 */
export type AccountSubject =
  | `user:${string}`
  | `community:${string}`
  | `organisation:${string}`
  | 'platform'
  | 'custody'
  | 'clearing'
  | 'exchange'
  | 'platform:engagement-treasury'
  | `engagement:${string}`
  | `chain:${string}`

export type ParsedSubject =
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'community'; readonly id: string }
  | { readonly kind: 'organisation'; readonly id: string }
  | { readonly kind: 'platform' }
  | { readonly kind: 'custody' }
  | { readonly kind: 'clearing' }
  | { readonly kind: 'exchange' }
  | { readonly kind: 'engagement-treasury' }
  | { readonly kind: 'engagement'; readonly service: string }
  | { readonly kind: 'chain'; readonly id: string }

export const PLATFORM: AccountSubject = 'platform'
export const CUSTODY: AccountSubject = 'custody'
export const CLEARING: AccountSubject = 'clearing'

/**
 * The exchange's omnibus escrow — the balance the order book holds while an order rests, with
 * `micro-trade`'s `exchange_accounts` rows as the sub-ledger that says whose it is.
 *
 * `micro-trade` has spelled this subject by hand since the order book shipped
 * (`trade/src/transfers.ts`, `transferPostings`), and the grammar did not have it, so every
 * posting it made would have died at `parseAccountSubject` inside the ledger's `ensureAccount` —
 * the same way foresight's `chain:` entries died before `chainSubject` was registered below.
 * Nothing had noticed because the feature is off behind `TRADE_EXCHANGE_ENABLED`, and the wire
 * type for a subject is `string`, so TypeScript had nothing to object to. micro-org#372.
 *
 * A singleton for the same reason `custody` is: there is one escrow pool per asset, and which
 * customer it is held for is the sub-ledger's question, not the subject's.
 *
 * It is used at purpose `escrow`, type **`liability`** — the money is owed onwards, and it must
 * NOT be overdraft-exempt, which is what rules out `clearing`. That the reconciliation invariant
 * survives it is not an assumption: `ledger/src/reconcile.ts`'s `totalFor(tx, 'liability', asset)`
 * filters on the account TYPE and passes no subject, so a balance moving from
 * `user:<id>/available/liability` into this account leaves Σ liabilities — the half of the
 * invariant that is compared against Σ custody assets — exactly where it was.
 */
export const EXCHANGE: AccountSubject = 'exchange'

/**
 * The engagement treasury — docs/ecosystem/21 §4, spelled exactly as that document's tree spells
 * it. A singleton like `platform`, and deliberately NOT a `platform`-purpose variant: the
 * engagement programme's whole safety argument is that an auditor reconstructs it from the ledger
 * alone, and a subject that names the programme is what makes `select .. where subject like
 * 'engagement%' or subject = 'platform:engagement-treasury'` the entire reconstruction query.
 *
 * The colon inside a singleton name is safe for the same reason `user:<id>` is: `accountKey`
 * joins on `|`, never on `:`.
 */
export const ENGAGEMENT_TREASURY: AccountSubject = 'platform:engagement-treasury'

const SINGLETON_SUBJECTS = ['platform', 'custody', 'clearing', 'exchange'] as const

/**
 * The delimiter used by the canonical account key.
 *
 * Subjects and token asset codes both contain `:`, so `:` cannot separate the parts of a key.
 * `|` appears in neither a UUIDv7 nor a `cf:` URN, and any id containing one is rejected at
 * construction — otherwise two distinct accounts could produce one key, which is the quietest
 * possible way to merge two users' balances.
 */
const KEY_DELIMITER = '|'

function assertId(kind: string, id: string): void {
  if (id.length === 0) throw new RangeError(`${kind} id must not be empty`)
  if (id.includes(':')) throw new RangeError(`${kind} id must not contain ':': ${id}`)
  if (id.includes(KEY_DELIMITER)) {
    throw new RangeError(`${kind} id must not contain '${KEY_DELIMITER}': ${id}`)
  }
}

export function userSubject(id: string): AccountSubject {
  assertId('user', id)
  return `user:${id}`
}

export function communitySubject(id: string): AccountSubject {
  assertId('community', id)
  return `community:${id}`
}

export function organisationSubject(id: string): AccountSubject {
  assertId('organisation', id)
  return `organisation:${id}`
}

/**
 * A service's engagement account — docs/ecosystem/21 §4: `engagement:<service>`, one per service
 * the treasury funds, populated only by operator-approved `engagement.transfer` actions in
 * `micro-admin-api`. The service name obeys the same id rule as every other prefixed subject
 * (no `:`, no `|`), so `engagement:foresight` parses and `engagement:a:b` is refused.
 */
export function engagementSubject(service: string): AccountSubject {
  assertId('engagement', service)
  return `engagement:${service}`
}

/**
 * The one entry kind an engagement grant is posted under — docs/ecosystem/21 §5.
 *
 * **`treasury_spend`, and it is not a compromise.** The ledger's kind vocabulary is CLOSED
 * (`journal_entries_kind_chk`, ledger/src/migrations.ts) precisely so that "how much did the
 * engagement programme spend" is answerable by counting rather than by grepping descriptions —
 * and an engagement account IS a treasury (purpose `treasury`, type `equity`), so a grant out of
 * it is literally a treasury spend. Naming it here, once, is what stops `market`, `worlds` and
 * `trade` picking three different kinds for one programme and making that count impossible.
 *
 * No new kind was added for this, deliberately: the vocabulary is a CHECK constraint in
 * `micro-ledger`'s schema, so a fourth service inventing `engagement_grant` would not merely be
 * inconsistent — every entry it posted would be refused at the constraint. `micro-foresight`
 * shipped exactly that defect with `foresight.settlement_fee` and posted nothing for months.
 */
export const ENGAGEMENT_GRANT_KIND: EntryKind = 'treasury_spend'

/**
 * An account named the way every service's ledger CLIENT names one on the wire.
 *
 * Deliberately NOT `Posting` (which is `accountId`-shaped, the RESOLVED form the ledger uses
 * internally): a grant's whole point is that the engagement account may not exist yet and is
 * created idempotently on first use, which the wire's inline `account` block is what enables.
 */
export interface EngagementAccountRef extends AccountIdentity {
  readonly type: AccountType
}

/**
 * The DEBIT side of every engagement grant — 21 §4: "Every grant a service pays out references
 * its engagement account as the debit side. An auditor reconstructs the entire programme from
 * the ledger alone."
 *
 * That sentence is only true if all four fields are spelled identically by every service, because
 * the ledger's account key is `(subject, asset_code, purpose)` and a second spelling is a second
 * account — which is the quietest possible way to split one programme's ledger in half. So the
 * spelling lives here and nowhere else.
 *
 * `equity` under `treasury`: the programme is the platform's own money earmarked, not revenue and
 * not a user liability. It matters at the ledger's overdraft trigger — an `equity` account is NOT
 * overdraft-exempt (ledger/src/migrations.ts, `ledger_assert_no_overdraft`), so a service that
 * tries to grant more than its engagement account holds is refused by the ledger rather than
 * quietly going negative. An engagement account cannot be spent before it is funded.
 *
 * **`assetCode` is required, and was defaulted to `'SHARD'` until SHARD was retired.** A default
 * asset on an account constructor is a decision made by omission: `engagementAccount('foo')`
 * compiles, reads as complete, and silently picks the denomination of the programme's ledger — and
 * once the picked asset is one nothing issues any more, the quiet answer is also the wrong one.
 * Making it required moves that decision to the call site, where a reviewer can see which asset a
 * service grants in. It stays `LedgerAssetCode` rather than `IssuableAssetCode`: the accounts
 * holding retired assets still exist and still have to be addressable to be drained, so refusing
 * to spell one would strand the balance rather than protect it.
 */
export function engagementAccount(
  service: string,
  assetCode: LedgerAssetCode,
): EngagementAccountRef {
  return {
    subject: engagementSubject(service),
    assetCode,
    purpose: 'treasury',
    type: 'equity',
  }
}

/**
 * A chain's clearing position, as bookkeeping about somebody else's ledger (the chain's).
 *
 * `micro-foresight` has posted fee reports against `chain:<id>` since its fee mirror shipped
 * (foresight/src/ledgerclient.ts, feePostings) — a spelling this grammar refused until 2026-08,
 * so every such entry died at the ledger's `parseAccountSubject` call inside `ensureAccount`.
 * Registered here rather than papered over in foresight because the subject is right: an entry
 * that mirrors an on-chain movement needs a subject that says "this came from outside", and a
 * chain is the honest owner of that side of the entry.
 */
export function chainSubject(id: string): AccountSubject {
  assertId('chain', id)
  return `chain:${id}`
}

export function parseAccountSubject(text: string): ParsedSubject {
  for (const singleton of SINGLETON_SUBJECTS) {
    if (text === singleton) return { kind: singleton }
  }
  if (text === ENGAGEMENT_TREASURY) return { kind: 'engagement-treasury' }
  const separator = text.indexOf(':')
  const prefix = separator === -1 ? '' : text.slice(0, separator)
  const id = separator === -1 ? '' : text.slice(separator + 1)
  if (prefix === 'user' || prefix === 'community' || prefix === 'organisation') {
    assertId(prefix, id)
    return { kind: prefix, id }
  }
  if (prefix === 'engagement') {
    assertId('engagement', id)
    return { kind: 'engagement', service: id }
  }
  if (prefix === 'chain') {
    assertId('chain', id)
    return { kind: 'chain', id }
  }
  throw new RangeError(`not an account subject: ${text}`)
}

export function isAccountSubject(text: string): text is AccountSubject {
  try {
    parseAccountSubject(text)
    return true
  } catch {
    return false
  }
}

/** Who caused an entry. Distinct from the subject: an operator may post against a user. */
export type Actor = `user:${string}` | `service:${string}` | `operator:${string}` | 'system'

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * `liability` is what we owe users; `asset` is what we hold on chain. The pair of them is the
 * reconciliation invariant: for each asset, Σ user liabilities must equal Σ custody assets.
 */
export type AccountType = 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing'

export type AccountPurpose =
  | 'available'
  | 'reserved'
  | 'escrow'
  | 'treasury'
  | 'fees'
  | 'payout_due'
  | 'suspense'

export type AccountStatus = 'open' | 'frozen' | 'closed'

export const ACCOUNT_TYPES: readonly AccountType[] = Object.freeze([
  'liability',
  'asset',
  'revenue',
  'expense',
  'equity',
  'clearing',
])

export const ACCOUNT_PURPOSES: readonly AccountPurpose[] = Object.freeze([
  'available',
  'reserved',
  'escrow',
  'treasury',
  'fees',
  'payout_due',
  'suspense',
])

/** The three fields that identify an account. Unique together; nothing else may be. */
export interface AccountIdentity {
  readonly subject: AccountSubject
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
}

export interface Account extends AccountIdentity {
  readonly id: string
  readonly type: AccountType
  readonly status: AccountStatus
  /**
   * Whether the account may hold a balance against its normal direction.
   *
   * Only `clearing` and `suspense` accounts get this. A user liability going negative means we
   * have paid out value the user never had, which must fail loudly at the posting, not be
   * discovered at the month end.
   */
  readonly overdraftAllowed?: boolean
  readonly createdAt: Timestamp
}

/**
 * The canonical account key: `(subject, assetCode, purpose)`.
 *
 * Takes an object rather than three positional strings deliberately. All three arguments are
 * strings of similar shape, and a transposed `subject`/`assetCode` pair would produce a
 * well-formed key for an account that must never exist.
 */
export function accountKey(identity: AccountIdentity): string {
  if (identity.assetCode.includes(KEY_DELIMITER)) {
    throw new RangeError(`asset code must not contain '${KEY_DELIMITER}': ${identity.assetCode}`)
  }
  parseAccountSubject(identity.subject)
  return [identity.subject, identity.assetCode, identity.purpose].join(KEY_DELIMITER)
}

export function parseAccountKey(key: string): AccountIdentity {
  const parts = key.split(KEY_DELIMITER)
  const [subject, assetCode, purpose] = parts
  if (parts.length !== 3 || subject === undefined || assetCode === undefined || purpose === undefined) {
    throw new RangeError(`not an account key: ${key}`)
  }
  parseAccountSubject(subject)
  if (!(ACCOUNT_PURPOSES as readonly string[]).includes(purpose)) {
    throw new RangeError(`not an account purpose: ${purpose}`)
  }
  return {
    subject: subject as AccountSubject,
    assetCode: assetCode as LedgerAssetCode,
    purpose: purpose as AccountPurpose,
  }
}

/** True when the account is permitted to sit the wrong side of zero. */
export function permitsOverdraft(account: Pick<Account, 'purpose' | 'overdraftAllowed'>): boolean {
  if (account.overdraftAllowed === true) return true
  return account.purpose === 'suspense'
}

/**
 * Would this balance breach the floor? Checked after applying a posting, before committing.
 *
 * Expressed in *normal-direction* terms, so the same rule covers a liability that has gone
 * negative and an asset that has been overspent, without the caller having to remember which
 * direction is which for the account's type.
 */
export function wouldOverdraw(
  account: Pick<Account, 'type' | 'purpose' | 'overdraftAllowed'>,
  balanceAfter: bigint,
): boolean {
  if (account.type === 'clearing') return false
  if (permitsOverdraft(account)) return false
  return balanceAfter < 0n
}

// ---------------------------------------------------------------------------
// Entries and postings
// ---------------------------------------------------------------------------

/** The closed set from 04-domain-model.md §2.2. It is also the audit vocabulary. */
export const ENTRY_KINDS = Object.freeze([
  'deposit_credited',
  'withdrawal_requested',
  'withdrawal_settled',
  'withdrawal_refunded',
  'conversion',
  'transfer',
  'purchase',
  'subscription_charge',
  'fee_charged',
  'reward_granted',
  'market_escrow',
  'market_settled',
  'royalty_paid',
  'trading_fill',
  'performance_fee',
  'creator_payout',
  'treasury_spend',
  'adjustment',
  'reconciliation_correction',
  'reversal',
] as const)

export type EntryKind = (typeof ENTRY_KINDS)[number]

export function isEntryKind(value: string): value is EntryKind {
  return (ENTRY_KINDS as readonly string[]).includes(value)
}

export type Direction = 'debit' | 'credit'

export function opposite(direction: Direction): Direction {
  return direction === 'debit' ? 'credit' : 'debit'
}

/**
 * One side of a movement. **`amount` is always positive**; direction lives in `direction`.
 *
 * The old `ledger.delta` column encoded direction in the sign of the amount, which is why a
 * mis-ported posting set is a recognised failure mode below rather than a generic validation
 * error — see `mixed_sign`.
 */
export interface Posting {
  readonly accountId: string
  readonly direction: Direction
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  /** Position within the entry. Unique per entry, so a posting has a stable identity. */
  readonly sequence: number
}

/** Open-ended, non-queried detail. Never a substitute for a column, and never a float. */
export type EntryMetadata = Readonly<Record<string, string | number | boolean | null>>

export interface JournalEntry {
  readonly id: string
  readonly kind: EntryKind
  readonly description?: string
  /** Which service posted this. Present on every entry, unlike today's optional `source`. */
  readonly originatingService: string
  readonly actor: Actor
  /** Ties the entry to the request or event that caused it, across every service it touched. */
  readonly correlationId: string
  /** Unique, and claimed in the same transaction as the postings. */
  readonly idempotencyKey: string
  /** Set on a correction. A correction is a new entry; postings are never edited. */
  readonly reversesEntryId?: string
  /** When the business event happened. */
  readonly occurredAt: Timestamp
  /** When the ledger learned of it. Differs from `occurredAt` on any replayed or late entry. */
  readonly recordedAt: Timestamp
  readonly metadata?: EntryMetadata
  readonly postings: readonly Posting[]
}

// ---------------------------------------------------------------------------
// The balancing invariant
// ---------------------------------------------------------------------------

export type BalanceProblem =
  /** No postings at all. An entry that moves nothing is a bug in the caller, not an entry. */
  | { readonly code: 'empty_entry' }
  /** Zero or negative. Amounts carry magnitude only. */
  | {
      readonly code: 'non_positive_amount'
      readonly sequence: number
      readonly accountId: string
      readonly amount: bigint
    }
  /**
   * Some amounts positive, some negative — the signature of a posting set ported straight from
   * the old single-sided `delta` column. Reported separately from `non_positive_amount` because
   * the fix is different: the direction must move into `direction`, not the sign be flipped.
   */
  | { readonly code: 'mixed_sign' }
  | { readonly code: 'duplicate_sequence'; readonly sequence: number }
  | { readonly code: 'invalid_sequence'; readonly sequence: number }
  /**
   * All postings for an asset face the same way. This is precisely what today's ledger table can
   * express and nothing else, so it gets its own code rather than being reported as unbalanced.
   */
  | {
      readonly code: 'single_sided'
      readonly assetCode: LedgerAssetCode
      readonly direction: Direction
      readonly amount: bigint
    }
  | {
      readonly code: 'unbalanced'
      readonly assetCode: LedgerAssetCode
      readonly debits: bigint
      readonly credits: bigint
      /** debits − credits. Positive means the debit side is heavy. */
      readonly difference: bigint
    }

export type BalanceCheck =
  | {
      readonly ok: true
      /** Per asset, the amount that moved: Σ debits, which by definition equals Σ credits. */
      readonly totals: ReadonlyMap<LedgerAssetCode, bigint>
    }
  | { readonly ok: false; readonly problems: readonly BalanceProblem[] }

/**
 * **The invariant the whole platform rests on: Σ debits = Σ credits, per asset, per entry.**
 *
 * Per asset, not per entry, because an entry may legitimately touch two assets — a conversion
 * debits a user's EMBER and credits their Shards in one atomic entry, and those two totals have
 * no arithmetic relationship whatsoever. Summing across assets would make a nonsense entry
 * balance and a correct one fail.
 *
 * Returns a discriminated result rather than throwing, because the caller is a posting API that
 * must report *which* asset is out and by how much; a thrown string is not a diagnosis.
 */
export function balanceEntry(postings: readonly Posting[]): BalanceCheck {
  if (postings.length === 0) return { ok: false, problems: [{ code: 'empty_entry' }] }

  const problems: BalanceProblem[] = []
  const seenSequences = new Set<number>()
  let sawPositive = false
  let sawNegative = false

  for (const posting of postings) {
    if (posting.amount > 0n) sawPositive = true
    if (posting.amount < 0n) sawNegative = true
    if (posting.amount <= 0n) {
      problems.push({
        code: 'non_positive_amount',
        sequence: posting.sequence,
        accountId: posting.accountId,
        amount: posting.amount,
      })
    }
    if (!Number.isInteger(posting.sequence) || posting.sequence < 0) {
      problems.push({ code: 'invalid_sequence', sequence: posting.sequence })
    } else if (seenSequences.has(posting.sequence)) {
      problems.push({ code: 'duplicate_sequence', sequence: posting.sequence })
    }
    seenSequences.add(posting.sequence)
  }

  if (sawPositive && sawNegative) problems.push({ code: 'mixed_sign' })

  // Stop here when any amount is malformed. A per-asset sum computed over a negative amount is
  // not a diagnosis, it is a second wrong answer laid on top of the first.
  if (problems.length > 0) return { ok: false, problems }

  const debits = new Map<LedgerAssetCode, bigint>()
  const credits = new Map<LedgerAssetCode, bigint>()
  for (const posting of postings) {
    const side = posting.direction === 'debit' ? debits : credits
    side.set(posting.assetCode, (side.get(posting.assetCode) ?? 0n) + posting.amount)
  }

  // Sorted so a caller comparing two failures of the same entry sees a stable problem list.
  const assets = [...new Set([...debits.keys(), ...credits.keys()])].sort()
  const totals = new Map<LedgerAssetCode, bigint>()
  for (const assetCode of assets) {
    const debited = debits.get(assetCode) ?? 0n
    const credited = credits.get(assetCode) ?? 0n
    if (debited === 0n || credited === 0n) {
      problems.push({
        code: 'single_sided',
        assetCode,
        direction: debited === 0n ? 'credit' : 'debit',
        amount: debited === 0n ? credited : debited,
      })
    } else if (debited !== credited) {
      problems.push({
        code: 'unbalanced',
        assetCode,
        debits: debited,
        credits: credited,
        difference: debited - credited,
      })
    } else {
      totals.set(assetCode, debited)
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, totals }
}

export function describeBalanceProblem(problem: BalanceProblem): string {
  switch (problem.code) {
    case 'empty_entry':
      return 'entry has no postings'
    case 'non_positive_amount':
      return `posting ${problem.sequence} on ${problem.accountId} has amount ${problem.amount}; amounts carry magnitude only`
    case 'mixed_sign':
      return 'postings mix positive and negative amounts; direction belongs in `direction`, not in the sign'
    case 'duplicate_sequence':
      return `sequence ${problem.sequence} appears more than once`
    case 'invalid_sequence':
      return `sequence ${problem.sequence} is not a non-negative integer`
    case 'single_sided':
      return `${problem.assetCode} has only ${problem.direction} postings totalling ${problem.amount}; it has no counter-account`
    case 'unbalanced':
      return `${problem.assetCode} is out by ${problem.difference} (debits ${problem.debits}, credits ${problem.credits})`
  }
}

/** For call sites inside a transaction, where the only correct response is to abort. */
export function assertBalanced(postings: readonly Posting[]): ReadonlyMap<LedgerAssetCode, bigint> {
  const result = balanceEntry(postings)
  if (result.ok) return result.totals
  throw new RangeError(`entry does not balance: ${result.problems.map(describeBalanceProblem).join('; ')}`)
}

// ---------------------------------------------------------------------------
// The sign convention
// ---------------------------------------------------------------------------

/**
 * The direction in which an account type increases. **This is the thing most likely to be got
 * backwards, so it is stated once, here, and every balance change goes through it.**
 *
 * - `liability` — a **credit** increases it. A user's balance is money we owe them; crediting a
 *   deposit increases our obligation. This is the one that reads backwards to anyone who thinks
 *   of a credit as "money in" from the user's bank-statement point of view: the statement is
 *   written from the bank's ledger, and the user's account there is the bank's liability too.
 * - `asset` — a **debit** increases it. Coin arriving in a custody wallet is a debit to custody.
 * - `revenue` — a **credit** increases it. Fee income is credited; it is owed to equity.
 * - `expense` — a **debit** increases it. Gas paid is debited.
 * - `equity` — a **credit** increases it.
 * - `clearing` — treated as credit-normal, like a liability: it holds value in transit that is
 *   owed onwards. It nets to zero over a settled period, which is what makes a non-zero clearing
 *   balance the first thing reconciliation looks at.
 *
 * The whole double-entry system falls out of this: a deposit debits custody (asset up) and
 * credits the user (liability up), and the entry balances because those are the same number.
 */
export function normalBalance(type: AccountType): Direction {
  switch (type) {
    case 'asset':
    case 'expense':
      return 'debit'
    case 'liability':
    case 'revenue':
    case 'equity':
    case 'clearing':
      return 'credit'
  }
}

/** True when a posting in this direction increases an account of this type. */
export function increasesBalance(direction: Direction, type: AccountType): boolean {
  return direction === normalBalance(type)
}

/**
 * Apply one posting to a running balance, in the account's own normal direction.
 *
 * The returned balance is therefore always "how much of this account there is", positive, for
 * both a liability and an asset — the caller never has to hold the sign convention in its head
 * a second time.
 */
export function applyPosting(balance: bigint, posting: Posting, accountType: AccountType): bigint {
  if (posting.amount <= 0n) {
    throw new RangeError(`posting amount must be positive, got ${posting.amount}`)
  }
  return increasesBalance(posting.direction, accountType)
    ? balance + posting.amount
    : balance - posting.amount
}

/** Replay a sequence of postings onto an opening balance. The projection, in one function. */
export function applyPostings(
  balance: bigint,
  postings: readonly Posting[],
  accountType: AccountType,
): bigint {
  let running = balance
  for (const posting of postings) running = applyPosting(running, posting, accountType)
  return running
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export interface ReversalOptions {
  readonly id: string
  /** Must differ from the original's, or the reversal is swallowed as a replay of it. */
  readonly idempotencyKey: string
  readonly recordedAt: Timestamp
  /** Defaults to `recordedAt`. See below for why it is not the original's `occurredAt`. */
  readonly occurredAt?: Timestamp
  readonly actor?: Actor
  readonly correlationId?: string
  readonly description?: string
  /** Defaults to `reversal`. `reconciliation_correction` is the other honest choice. */
  readonly kind?: EntryKind
  readonly metadata?: EntryMetadata
}

/**
 * The mirror of an entry: every posting flipped, `reversesEntryId` set.
 *
 * **A correction is a new entry, never an edit.** Postings are append-only, so the audit trail
 * shows the mistake and the fix rather than only the fix. Reversing a reversal is legal and
 * lands back on the original postings, which is what makes an operator's mis-click recoverable.
 */
export function reverseEntry(entry: JournalEntry, options: ReversalOptions): JournalEntry {
  if (options.idempotencyKey === entry.idempotencyKey) {
    throw new RangeError('a reversal needs its own idempotency key')
  }
  if (options.id === entry.id) {
    throw new RangeError('a reversal needs its own entry id')
  }

  const reversed: JournalEntry = {
    id: options.id,
    kind: options.kind ?? 'reversal',
    description: options.description ?? `Reversal of ${entry.id}`,
    originatingService: entry.originatingService,
    actor: options.actor ?? entry.actor,
    correlationId: options.correlationId ?? entry.correlationId,
    idempotencyKey: options.idempotencyKey,
    reversesEntryId: entry.id,
    // The correction happens now. Back-dating it to the original's business time would move the
    // money out of a period that may already have been reported and closed.
    occurredAt: options.occurredAt ?? options.recordedAt,
    recordedAt: options.recordedAt,
    postings: entry.postings.map(reversePosting),
    // The original's metadata is deliberately not copied. It routinely carries the external
    // reference that identified the original event, and a reversal carrying it looks to every
    // downstream consumer like a duplicate of the thing it is undoing.
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  }
  return reversed
}

export function reversePosting(posting: Posting): Posting {
  return { ...posting, direction: opposite(posting.direction) }
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export interface ReservationMove {
  readonly availableAccountId: string
  readonly reservedAccountId: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  /** Where in the entry the pair starts. Defaults to 0. */
  readonly startSequence?: number
}

/**
 * Move value from `available` to `reserved`.
 *
 * **A reservation is a posting pair, not a column update.** That is the whole point of modelling
 * the split as two accounts: a reservation is then auditable, reversible and impossible to
 * lose — and a listing that cannot reserve cannot be listed, which is what makes "sold twice"
 * unrepresentable. Today no reservation concept exists at all, so a marketplace listing holds
 * nothing and a balance can be spent twice.
 *
 * Both accounts are the user's liability accounts, so the debit leaves `available` and the credit
 * arrives in `reserved` — see `normalBalance`. The entry balances because it is the same amount.
 */
export function reservePostings(move: ReservationMove): readonly [Posting, Posting] {
  return movePostings(move.availableAccountId, move.reservedAccountId, move)
}

/** The mirror: `reserved` back to `available`, on cancellation or expiry. */
export function releasePostings(move: ReservationMove): readonly [Posting, Posting] {
  return movePostings(move.reservedAccountId, move.availableAccountId, move)
}

/**
 * A balanced pair moving one asset between two accounts of the same type.
 *
 * Exported because a transfer, an escrow step and a treasury move are all this shape, and each of
 * them reimplemented separately is an opportunity to get the direction wrong once.
 */
export function movePostings(
  fromAccountId: string,
  toAccountId: string,
  move: Pick<ReservationMove, 'assetCode' | 'amount' | 'startSequence'>,
): readonly [Posting, Posting] {
  if (move.amount <= 0n) {
    throw new RangeError(`reservation amount must be positive, got ${move.amount}`)
  }
  if (fromAccountId === toAccountId) {
    throw new RangeError('a movement needs two distinct accounts')
  }
  const start = move.startSequence ?? 0
  return [
    {
      accountId: fromAccountId,
      direction: 'debit',
      amount: move.amount,
      assetCode: move.assetCode,
      sequence: start,
    },
    {
      accountId: toAccountId,
      direction: 'credit',
      amount: move.amount,
      assetCode: move.assetCode,
      sequence: start + 1,
    },
  ]
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** An amount and what it is denominated in. Never one without the other. */
export interface Money {
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
}

export function money(amount: bigint, assetCode: LedgerAssetCode): Money {
  if (typeof amount !== 'bigint') throw new TypeError('money amounts are bigint')
  return { amount, assetCode }
}

function sameAsset(a: Money, b: Money): void {
  if (a.assetCode !== b.assetCode) {
    throw new RangeError(`cannot combine ${a.assetCode} with ${b.assetCode}`)
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameAsset(a, b)
  return { amount: a.amount + b.amount, assetCode: a.assetCode }
}

export function subtractMoney(a: Money, b: Money): Money {
  sameAsset(a, b)
  return { amount: a.amount - b.amount, assetCode: a.assetCode }
}

export function negateMoney(a: Money): Money {
  return { amount: -a.amount, assetCode: a.assetCode }
}

export function absMoney(a: Money): Money {
  return { amount: a.amount < 0n ? -a.amount : a.amount, assetCode: a.assetCode }
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameAsset(a, b)
  if (a.amount < b.amount) return -1
  if (a.amount > b.amount) return 1
  return 0
}

export function isZero(a: Money): boolean {
  return a.amount === 0n
}

/** Display only. The result must never re-enter a calculation — see `parseMoney`. */
export function formatMoney(value: Money, tokenDecimals?: number): string {
  return formatAmount(value.amount, assetDecimals(value.assetCode, tokenDecimals))
}

/** Parse a decimal string. Refuses more precision than the asset has, rather than rounding it. */
export function parseMoney(
  text: string,
  assetCode: LedgerAssetCode,
  tokenDecimals?: number,
): Money {
  return { amount: parseAmount(text, assetDecimals(assetCode, tokenDecimals)), assetCode }
}

/**
 * Convert a coin amount to Shards at a scaled USD rate.
 *
 * Delegates to `contracts-chain`. The rounding direction is decided there, once, and rounding it
 * a second time here — even identically — would be a second place for it to change.
 */
export function shardsForMoney(coin: Money, usdPerCoinScaled: bigint): Money {
  if (!isChainAsset(coin.assetCode) || coin.assetCode === 'SHARD') {
    throw new RangeError(`not a convertible coin: ${coin.assetCode}`)
  }
  return {
    amount: shardsForCoinAmount(coin.amount, chainSpec(coin.assetCode).decimals, usdPerCoinScaled),
    assetCode: 'SHARD',
  }
}

/** The inverse, likewise delegated. */
export function moneyForShards(shards: bigint, assetCode: AssetCode, usdPerCoinScaled: bigint): Money {
  if (assetCode === 'SHARD') throw new RangeError('SHARD is not a conversion target')
  return {
    amount: coinAmountForShards(shards, chainSpec(assetCode).decimals, usdPerCoinScaled),
    assetCode,
  }
}

/**
 * Shards for a USD amount in cents. Exact at the fixed rate, but floors anyway: a cent that does
 * not divide is a cent the platform keeps, not a Shard minted against nothing.
 */
export function shardsForUsdCents(cents: bigint): bigint {
  if (cents < 0n) throw new RangeError('amount must not be negative')
  return (cents * SHARDS_PER_USD) / 10n ** BigInt(USD_DECIMALS)
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconciliationStatus = 'clean' | 'drift_within_tolerance' | 'drift_exceeded' | 'failed'

/** Per-asset smallest-unit tolerance. An asset absent from the map is given zero tolerance. */
export type AssetTolerance = Readonly<Partial<Record<LedgerAssetCode, bigint>>>

export interface ReconciliationRun {
  readonly id: string
  readonly chain: string
  readonly network: 'mainnet' | 'testnet'
  readonly assetCode: LedgerAssetCode
  readonly startedAt: Timestamp
  readonly finishedAt?: Timestamp
  /** Σ of the custody asset accounts, from the journal. */
  readonly ledgerCustodyTotal: bigint
  /** Σ of the confirmed on-chain balances the indexer observes for those addresses. */
  readonly indexerObservedTotal: bigint
  /** `ledgerCustodyTotal − indexerObservedTotal`. Positive means the ledger claims more. */
  readonly drift: bigint
  readonly status: ReconciliationStatus
  readonly notes?: string
}

/**
 * Ledger minus chain.
 *
 * The sign carries the meaning and must not be discarded. **Positive** — the ledger believes we
 * hold coin the chain does not show — is the dangerous direction: it is the shape of
 * `convertCoinToEmber` crediting custodial EMBER with no on-chain movement behind it. **Negative**
 * is an uncredited deposit: still a bug, but one that owes the user rather than the reverse.
 */
export function computeDrift(ledgerCustodyTotal: bigint, indexerObservedTotal: bigint): bigint {
  return ledgerCustodyTotal - indexerObservedTotal
}

/**
 * Is this run's drift acceptable for its asset?
 *
 * **An asset with no configured tolerance gets zero, not infinity.** Failing closed on a missing
 * config is the whole reason this function takes the map rather than a number: the alternative is
 * an asset silently exempt from the only check that guards it.
 *
 * Both directions are compared against the same bound. Fees in flight explain a small positive
 * drift, but a negative drift of any size means the indexer sees coin the ledger has not
 * credited, and that is not something to wave through either.
 */
export function withinTolerance(
  run: Pick<ReconciliationRun, 'assetCode' | 'drift'>,
  tolerance: AssetTolerance,
): boolean {
  const bound = tolerance[run.assetCode] ?? 0n
  if (bound < 0n) throw new RangeError(`tolerance must not be negative: ${bound}`)
  const magnitude = run.drift < 0n ? -run.drift : run.drift
  return magnitude <= bound
}

/** The status a completed run should carry. `failed` is set by the runner, not derived here. */
export function reconciliationStatus(
  run: Pick<ReconciliationRun, 'assetCode' | 'drift'>,
  tolerance: AssetTolerance,
): Exclude<ReconciliationStatus, 'failed'> {
  if (run.drift === 0n) return 'clean'
  return withinTolerance(run, tolerance) ? 'drift_within_tolerance' : 'drift_exceeded'
}

/** Exceeding tolerance freezes withdrawals for that asset and pages. */
export function freezesWithdrawals(status: ReconciliationStatus): boolean {
  return status === 'drift_exceeded' || status === 'failed'
}

// ---------------------------------------------------------------------------
// Billing (04-domain-model.md §8)
// ---------------------------------------------------------------------------

export type ProductKind = 'one_off' | 'subscription' | 'consumable' | 'metered'

export interface Product {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly kind: ProductKind
  readonly status: 'draft' | 'active' | 'retired'
}

export type BillingInterval = 'day' | 'week' | 'month' | 'year'

export interface Price {
  readonly id: string
  readonly productId: string
  readonly assetCode: LedgerAssetCode
  /** Smallest units. A price is never a float, in any currency. */
  readonly unitAmount: bigint
  /** Null for a one-off price. */
  readonly interval: BillingInterval | null
  readonly intervalCount?: number
  readonly status: 'active' | 'retired'
}

/**
 * Where an entitlement applies. **The product dimension today's entitlements lack** — without it
 * no service can ask "does this user own X *for this title*".
 */
export type EntitlementScope = 'platform' | `title:${string}` | `community:${string}`

export type EntitlementSource = 'purchase' | 'subscription' | 'grant' | 'reward' | 'migration'

/**
 * Today's entitlements lack four things and every one of them is a live defect: a product
 * dimension, an expiry, revocation, and a service-readable API. The first three are fields here;
 * the fourth is the reason this type lives in a contract package at all.
 */
export interface Entitlement {
  readonly id: string
  readonly subject: AccountSubject
  readonly productId: string
  readonly sku: string
  readonly scope: EntitlementScope
  readonly source: EntitlementSource
  readonly grantedAt: Timestamp
  /** Absent means perpetual. Present is what lets a season pass end. */
  readonly expiresAt?: Timestamp
  /** Set by a refund. Revocation removes what the payment bought. */
  readonly revokedAt?: Timestamp
  /** Seats, uses or copies. `bigint` for the same reason every other quantity here is. */
  readonly quantity: bigint
  readonly metadata?: EntryMetadata
}

/**
 * The one question every consuming service asks. Evaluated at an explicit instant rather than
 * `Date.now()` so that a replay, a backfill and a test all get a deterministic answer.
 */
export function isEntitlementActive(entitlement: Entitlement, at: Timestamp): boolean {
  const when = Date.parse(at)
  if (Number.isNaN(when)) throw new RangeError(`not a timestamp: ${at}`)
  if (entitlement.quantity <= 0n) return false
  if (Date.parse(entitlement.grantedAt) > when) return false
  if (entitlement.revokedAt !== undefined && Date.parse(entitlement.revokedAt) <= when) return false
  if (entitlement.expiresAt !== undefined && Date.parse(entitlement.expiresAt) <= when) return false
  return true
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'cancelled'
  | 'expired'

export interface Subscription {
  readonly id: string
  readonly subject: AccountSubject
  readonly productId: string
  readonly priceId: string
  readonly status: SubscriptionStatus
  readonly quantity: bigint
  readonly currentPeriodStart: Timestamp
  readonly currentPeriodEnd: Timestamp
  /** Set when a cancellation is scheduled for the period end rather than taken immediately. */
  readonly cancelAt?: Timestamp
  readonly cancelledAt?: Timestamp
  /** The `subscription_charge` entry that paid for the current period. */
  readonly latestEntryId?: string
}

/** A subscription confers its entitlements while in these states, and only these. */
export function subscriptionConfersAccess(status: SubscriptionStatus): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due'
}

export type PayoutStatus = 'pending' | 'approved' | 'paid' | 'failed' | 'cancelled'

/**
 * A creator payout. **A ledger movement plus optionally a withdrawal — never a separate money
 * system.** `journalEntryId` is what makes that true and checkable.
 */
export interface Payout {
  readonly id: string
  readonly subject: AccountSubject
  readonly periodStart: Timestamp
  readonly periodEnd: Timestamp
  readonly assetCode: LedgerAssetCode
  readonly gross: bigint
  readonly platformFee: bigint
  readonly net: bigint
  readonly status: PayoutStatus
  readonly journalEntryId?: string
  readonly destinationWalletId?: string
}

export function payoutNet(gross: bigint, platformFee: bigint): bigint {
  if (gross < 0n) throw new RangeError('gross must not be negative')
  if (platformFee < 0n) throw new RangeError('platform fee must not be negative')
  if (platformFee > gross) throw new RangeError('platform fee must not exceed gross')
  return gross - platformFee
}

/**
 * `net = gross − platformFee`, exactly. Checked rather than assumed, because a payout whose parts
 * do not add up is the arithmetic a reconciliation cannot see: it balances as an entry while
 * paying the wrong amount.
 */
export function isPayoutConsistent(payout: Payout): boolean {
  return (
    payout.gross >= 0n &&
    payout.platformFee >= 0n &&
    payout.platformFee <= payout.gross &&
    payout.net === payout.gross - payout.platformFee
  )
}
