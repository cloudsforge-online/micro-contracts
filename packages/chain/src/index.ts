/**
 * Chain families, confirmation policy, and smallest-unit amount arithmetic.
 *
 * **This is the narrowest package in the set, and every consumer shares it at HEAD.**
 *
 * `wallet`, `settlement`, `custody` and `indexer` must agree byte-for-byte on the values in this
 * file. A skew in `RATE_SCALE`, in a confirmation depth, or in the rounding direction of
 * `shardsForCoinAmount` is not a 500 — it is money credited at the wrong depth, or a balance that
 * silently disagrees with the chain. That is a financial incident, and a change to it is a
 * coordinated release.
 *
 * **The old wording here said the package "is pinned to an exact version rather than a caret
 * range". Measured, that is not true and has not been:** every consumer resolves it as
 * `link:../contracts/packages/chain` (`wallet`, `settlement`, `custody`, `ledger`, `billing`,
 * `trade`, `mint`, `pricing`, `community`, `foresight`, and `indexer` via `file:`), and CI checks
 * micro-contracts out at `main` with no `ref:` (`org/.github/workflows/service-ci.yml:160`). So a
 * change here reaches every consumer on their next run, with no version to stage behind. That
 * makes the coordination real rather than notional, and it is why `SHARD` is deprecated in place
 * below instead of deleted.
 *
 * Everything here is pure. No I/O, no dependencies, no environment.
 */

export type ChainFamily = 'evm' | 'ember' | 'solana' | 'bitcoin' | 'xrp'

export type Network = 'mainnet' | 'testnet'

/**
 * Every asset code the estate can name — **including the one it is retiring.**
 *
 * `SHARD` is still here, and the reason is a measurement rather than an opinion. Shards sit
 * outside the estate's central guarantee (no balance may exist that the chain does not back),
 * which is why they are being removed; but the live ledger holds **114 SHARD accounts summing to
 * 132,000 units** right now. `ledger/src/jobs.ts:175` maps `SHARD` onto the synthetic `platform`
 * chain so that reconciliation still watches those accounts, and the reconcile job is typed
 * against this union. Delete the member today and the ledger can no longer *name* the asset it is
 * supervising — 132,000 units of real liability stop being reconciled at all. That is not a step
 * towards the guarantee, it is the guarantee switched off, so the member stays until the balances
 * are drained to zero.
 *
 * Nothing may be newly denominated in it. That is `IssuableAssetCode` below, and it is a type
 * rather than a comment because a comment does not fail a build.
 *
 * The removal is a coordinated release, not a unilateral one: every consumer resolves this package
 * by `link:../contracts/packages/chain` and CI checks micro-contracts out at `main` unpinned
 * (`org/.github/workflows/service-ci.yml:160`), so the union is shared at HEAD by roughly a dozen
 * repositories at once — see the header, which used to claim otherwise.
 */
export type AssetCode = 'EMBER' | 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'LTC' | 'SHARD'

/**
 * The assets that are being wound down. Nothing may be newly denominated in one.
 *
 * Retired is not the same as unknown: `CHAINS` still describes a retired asset, `chainSpec` still
 * answers for it, and the ledger still reconciles it. What changes is that no NEW liability may be
 * created in it, which is a property of the write paths rather than of the read paths.
 */
export const RETIRED_ASSETS: readonly AssetCode[] = Object.freeze(['SHARD'])

/**
 * An asset something may be **newly** denominated in.
 *
 * Written as `Exclude<AssetCode, 'SHARD'>` rather than as a second hand-typed union, so that
 * removing `SHARD` from `AssetCode` later empties this automatically instead of leaving a stale
 * duplicate behind. A service that types its settlement asset as this — `micro-billing` now does —
 * gets a compile error if anyone tries to route a purchase back through Shards.
 */
export type IssuableAssetCode = Exclude<AssetCode, 'SHARD'>

/** Is this asset wound down? The single question every write path asks before denominating. */
export function isRetiredAsset(asset: AssetCode): boolean {
  return RETIRED_ASSETS.includes(asset)
}

/**
 * Narrow an arbitrary asset code to one that may be newly denominated, or throw.
 *
 * The throw is the point. A retired asset arriving on a write path is a configuration error that
 * should stop the request, not a value to be coerced into something plausible — coercion here is
 * how an amount ends up denominated in an asset with the wrong number of decimals.
 */
export function assertIssuable(asset: AssetCode): IssuableAssetCode {
  if (isRetiredAsset(asset)) {
    throw new RangeError(`${asset} is retired and may not denominate anything new`)
  }
  return asset as IssuableAssetCode
}

/* ─────────────────────────────────────────────────── Explorer links, one network at a time */

declare const explorerTable: unique symbol

/**
 * Per-network explorer prefixes, where **no explorer may stand for more than one network**.
 *
 * Branded, and the brand is the point: the only way to obtain one of these is `explorers()`
 * below, so the rule cannot be sidestepped by writing an object literal into a `ChainSpec`. A
 * plain `Record<Network, string | null>` was sidestepped exactly that way — see `explorers()`.
 */
export type ExplorerTxUrls = Readonly<Record<Network, string | null>> & {
  readonly [explorerTable]: true
}

declare const distinctExplorers: unique symbol

/**
 * The compile error for naming one explorer on two networks. Unconstructable on purpose — there
 * is no value of this type, so the argument it is demanded as can never be supplied.
 */
export type MainnetAndTestnetExplorersMustDiffer = { readonly [distinctExplorers]: never }

/**
 * `[]` when the two networks name different explorers (or neither names one), and an
 * unsatisfiable argument list when they name the same one.
 *
 * `[M] extends [T]` rather than `M extends T` so a union never distributes; two nulls are the one
 * equal pair that is allowed, because a pair of nulls produces no link at all rather than the
 * wrong link.
 */
type ExplorerGuard<M, T> = [M] extends [T]
  ? [M] extends [null]
    ? []
    : [MainnetAndTestnetExplorersMustDiffer]
  : []

/**
 * Declare a chain's explorer, per network, and **fail the build if one URL serves both.**
 *
 * This exists because of a live defect: EMBER's mainnet and testnet prefixes were the same
 * literal string, so `explorerTxUrl('EMBER', 'testnet', h)` handed the user a **mainnet** explorer
 * link for a testnet hash. Nothing errored. The page loaded. It simply said the transaction did
 * not exist — the shape of failure that reads as "my funds are gone" rather than as "this link is
 * wrong", and the one the estate is about to multiply by standing testnet up beside mainnet on
 * the same apex.
 *
 * A test asserting the two differ would have caught it and been the ordinary answer. It is not
 * the answer here, because the table it guards is data and the next person to add a chain writes
 * a row rather than a test. The constraint therefore sits on the *constructor for the row*: an
 * asset whose two networks share an explorer cannot be written down, so there is no state for a
 * check to be late to.
 *
 * Both `null` is permitted and means "this chain has no explorer we can link to" — see SOL and
 * SHARD below. That is not the defect in the other direction: a null produces no link, and a
 * missing link cannot send anybody to the wrong chain.
 *
 * **What the failure looks like.** The two URLs being equal makes the third parameter demanded and
 * unsatisfiable, so `tsc` says `Expected 3 arguments, but got 2` at the offending row. That reads
 * oddly until you know why, which is what the parameter is named for: hovering the call shows
 * `..._explorersMustDifferPerNetwork`, and this comment is the rest of the answer.
 */
export function explorers<M extends string | null, T extends string | null>(
  mainnet: M,
  testnet: T,
  ..._explorersMustDifferPerNetwork: ExplorerGuard<M, T>
): ExplorerTxUrls {
  // The brand is a type and nothing else: it has no runtime representation, so the assertion adds
  // no property and the frozen object is exactly the two networks.
  const table: Readonly<Record<Network, string | null>> = Object.freeze({ mainnet, testnet })
  return table as ExplorerTxUrls
}

export interface ChainSpec {
  readonly asset: AssetCode
  readonly family: ChainFamily
  readonly name: string
  /** Smallest-unit exponent. EMBER is 18 because Hearth is an account-model EVM chain. */
  readonly decimals: number
  /** Blocks (or ledgers) before a deposit is credited. */
  readonly confirmations: number
  /**
   * A reorg at least this deep halts crediting for the chain and pages.
   *
   * Set below `confirmations` deliberately: a reorg shallower than the credit depth cannot have
   * produced a wrong credit, so it is noise. One at or past this depth means the assumption the
   * depth encodes has failed.
   */
  readonly reorgAlarmDepth: number
  /** Chain id where the family has one. Ember mainnet is 7411, testnet 7412. */
  readonly chainId?: Readonly<Record<Network, number>>
  /** Built by `explorers()`, which is the only thing that can build one. */
  readonly explorerTxUrl: ExplorerTxUrls
}

/**
 * The supported chains.
 *
 * EMBER's depth of 60 (~15 minutes at a 15-second block time) is the number Hearth publishes to
 * exchanges in `docs/exchange-integration.md` §4. It is high because Hearth is a young CPU-mined
 * chain with no finality gadget, and depth is the only defence available.
 */
export const CHAINS: Readonly<Record<AssetCode, ChainSpec>> = Object.freeze({
  EMBER: Object.freeze({
    asset: 'EMBER',
    family: 'ember',
    name: 'Hearth',
    decimals: 18,
    confirmations: 60,
    reorgAlarmDepth: 5,
    chainId: Object.freeze({ mainnet: 7411, testnet: 7412 }),
    // The two environments run side by side on one host under one apex: mainnet at
    // `cloudsforge.online`, testnet at `testnet.cloudsforge.online`. Both explorers are real and
    // both are served — `micro-deploy/cloudflared/config.mainnet.public.yml:76` and
    // `config.testnet.public.yml:76`. Until now this said the mainnet host twice.
    explorerTxUrl: explorers(
      'https://explorer.cloudsforge.online/#/tx/',
      'https://explorer.testnet.cloudsforge.online/#/tx/',
    ),
  }),
  ETH: Object.freeze({
    asset: 'ETH',
    family: 'evm',
    name: 'Ethereum',
    decimals: 18,
    confirmations: 12,
    reorgAlarmDepth: 3,
    chainId: Object.freeze({ mainnet: 1, testnet: 11155111 }),
    explorerTxUrl: explorers('https://etherscan.io/tx/', 'https://sepolia.etherscan.io/tx/'),
  }),
  // CONFIRMATIONS WERE RAISED FROM 3 TO 6 WHEN NATIVE DEPOSITS WERE BUILT, and the number is the
  // only one in this file that was ever a placeholder rather than a decision. Three is roughly
  // thirty minutes and is below what any custodian uses for Bitcoin; it was also, absurdly, twenty
  // times more relaxed than the depth this same file applies to the platform's own chain. Six is
  // the industry convention, it is what the network's own economics are usually argued against,
  // and crediting a stranger's deposit before it is final is not a latency optimisation — it is
  // giving away money that a reorg then takes back.
  //
  // CHANGING IT IS FREE TODAY AND WILL NOT BE LATER. `INDEXER_CHAINS` is unset in the estate, so no
  // Bitcoin block has ever been indexed and no BTC deposit has ever been credited at three. There
  // is no in-flight deposit to be re-judged by the new number and no reconciliation to restate.
  // The same edit after the first real deposit is a migration; here it is a constant.
  BTC: Object.freeze({
    asset: 'BTC',
    family: 'bitcoin',
    name: 'Bitcoin',
    decimals: 8,
    confirmations: 6,
    // Still strictly below `confirmations`, which is the property the estate relies on: a reorg deep
    // enough to retract a CREDITED movement is always deep enough to have halted the chain first.
    reorgAlarmDepth: 2,
    explorerTxUrl: explorers('https://mempool.space/tx/', 'https://mempool.space/testnet/tx/'),
  }),
  /**
   * Litecoin. Bitcoin's family, not Bitcoin's constants.
   *
   * `family: 'bitcoin'` is the whole point and it is load-bearing: Litecoin Core answers the same
   * JSON-RPC the Bitcoin worker already speaks (`getblockchaininfo`, `getblockcount`,
   * `getblockhash`, `getblock`, `getrawtransaction`), its transaction structure is Bitcoin's, and
   * its addresses are emitted BY THE NODE rather than derived by the indexer — so the follower, the
   * reorg repair, the RBF handling and the UTXO extraction are reused rather than reimplemented.
   * What is NOT shared is address encoding, which lives in custody and settlement as a network
   * parameter table (different version bytes, a different bech32 HRP and a different WIF byte).
   *
   * CONFIRMATIONS ARE 12, NOT BITCOIN'S 6. Blocks are ~2.5 minutes rather than ~10, so six here
   * would be fifteen minutes of work rather than an hour's, on a chain with a small fraction of
   * Bitcoin's hashrate. Twelve is ~30 minutes and is the depth the larger exchanges publish for
   * Litecoin. Copying Bitcoin's 6 because the family matches is exactly the "reuse the number with
   * the code" mistake this file exists to prevent — a depth is a property of a chain's security
   * budget and block time, never of the software that follows it.
   */
  LTC: Object.freeze({
    asset: 'LTC',
    family: 'bitcoin',
    name: 'Litecoin',
    decimals: 8,
    confirmations: 12,
    reorgAlarmDepth: 6,
    explorerTxUrl: explorers('https://litecoinspace.org/tx/', 'https://litecoinspace.org/testnet/tx/'),
  }),
  SOL: Object.freeze({
    asset: 'SOL',
    family: 'solana',
    name: 'Solana',
    decimals: 9,
    confirmations: 32,
    reorgAlarmDepth: 8,
    // THE SAME DEFECT AS EMBER'S, found by the constructor above rather than reported: both
    // networks said `https://solscan.io/tx/`, so a testnet signature was handed to a page that
    // reads mainnet-beta. It is null rather than corrected because Solana's explorers select the
    // cluster with a QUERY parameter — `…/tx/<sig>?cluster=testnet` — which a prefix cannot carry,
    // this field being a prefix that `explorerTxUrl()` concatenates a hash onto. Null costs the
    // link; the old value spent it on the wrong cluster.
    explorerTxUrl: explorers('https://solscan.io/tx/', null),
  }),
  XRP: Object.freeze({
    asset: 'XRP',
    family: 'xrp',
    name: 'XRP Ledger',
    decimals: 6,
    confirmations: 1,
    reorgAlarmDepth: 1,
    explorerTxUrl: explorers(
      'https://livenet.xrpl.org/transactions/',
      'https://testnet.xrpl.org/transactions/',
    ),
  }),
  // RETIRED — `RETIRED_ASSETS`. The spec stays because the ledger still supervises 114 live SHARD
  // accounts and `chainSpec('SHARD')` must keep answering for them; `decimals: 0` in particular is
  // load-bearing, because it is the only thing that says a stored `250` means 250 Shards and not
  // 250 wei. Anything that re-denominates a Shard amount has to read this, or it changes the scale
  // of stored money by a factor of 10¹⁸ without saying so.
  SHARD: Object.freeze({
    asset: 'SHARD',
    family: 'evm', // never used on chain; present so the record is total
    name: 'Shards',
    decimals: 0,
    confirmations: 0,
    reorgAlarmDepth: 0,
    explorerTxUrl: explorers(null, null),
  }),
})

/**
 * The assets the estate HOLDS BALANCES IN, which is a smaller set than the assets it can name.
 *
 * The distinction this list draws is not cosmetic: `CHAINS` says "the estate knows this chain's
 * rules", and this list says "the ledger supervises balances denominated in it". An asset reaches
 * the first long before it reaches the second.
 *
 * ── LTC WAS THE STANDING EXAMPLE OF THE GAP, AND IT CLOSED ON 2026-08-05 ────────────────────────
 *
 * This comment used to say Litecoin was "deliberately absent, and adding it is a coordinated
 * release rather than a one-line edit", and list the three things that would break. It was right,
 * so the list is kept below with what was actually done about each — because the next asset will
 * face the same three, and "it was done once" is more useful than "it must be done".
 *
 *   1. **`ledger` seeds a `chain_assets` table from a hand-written literal in its own migrations**,
 *      and its reconciliation test asserts the table equals THIS list. The migration text is
 *      checksummed, so it can be neither amended in place nor back-filled from here.
 *      → `ledger` migration 14, `litecoin_chain_asset`, inserts the row. A NEW migration, because
 *        editing 11 would change an applied checksum and every deployment would refuse to start.
 *   2. **`pricing` derives `MARKET_ASSETS` as everything here that is not administered**, so a new
 *      member immediately becomes an asset the oracle claims to quote. This was the dangerous one
 *      and it was worse than this comment claimed: it is not that the round "degrades" for the
 *      others, it is that Coinbase built its product URL from the asset code, `httpFetchJson`
 *      throws on a non-200, and `Promise.all` turned one unlisted symbol into a source that
 *      answered nothing for BTC, ETH, SOL and XRP as well.
 *      → `pricing` now carries a symbol map per venue and builds its URLs from it, so a venue is
 *        never asked for a symbol it does not publish; `pricing/src/sources.test.ts` fails the
 *        moment this list widens past those maps. LTC was wired and proved at all four venues
 *        BEFORE this line changed. **That order is the rule, not the anecdote.**
 *   3. **`site` publishes the count of on-chain assets** and re-derives it from this array in a
 *      test that explicitly refuses to skip.
 *      → It re-derived itself to 6. The PROSE beside it did not, because it was typed; it is now
 *        derived from this array too (`site/src/content/pages.ts`).
 *
 * A fourth was found while doing it, and is recorded because nothing was watching it: **`sdk`
 * keeps a deliberate copy of these values** for a public package that must not import a private
 * one. Its `tools/drift.ts` compared only the assets the SDK already knew, so an asset present
 * here and absent there was invisible to it — which is how the SDK went on telling integrators
 * that a BTC deposit is final at 3 confirmations for as long as it did. It now compares the SETS.
 *
 * So the order for the next asset is unchanged and now has a worked example: wire the follower,
 * the addresses and the sweep; add the price source and prove it against the live venues; then add
 * the member here, in a release that carries the ledger migration with it.
 */
export const ON_CHAIN_ASSETS: readonly AssetCode[] = Object.freeze([
  'EMBER',
  'BTC',
  'ETH',
  'LTC',
  'SOL',
  'XRP',
])

export function chainSpec(asset: AssetCode): ChainSpec {
  const spec = CHAINS[asset]
  if (!spec) throw new Error(`unknown asset: ${asset}`)
  return spec
}

/**
 * Fixed-point scale for exchange rates. Six decimal places, as BigInt.
 *
 * Rates are never floats. A float rate applied to an 18-decimal amount loses precision in the
 * least significant digits, which is exactly where a reconciliation drift shows up.
 */
export const RATE_SCALE = 1_000_000n

/* ───────────────────────────────────────────────────────────── Sparks, the display denomination */

/**
 * **A Spark is a display denomination of EMBER. It is not a second asset code and must never
 * become one.**
 *
 * This is `tessera/src/sparks.ts`'s rule, promoted here because it is not tessera's rule — it is
 * the estate's, and a rule that lives in one service is a rule the next service does not know
 * about. The reason is the ledger's balancing invariant, which is enforced **per `asset_code`** by
 * trigger (`ledger/src/migrations.ts:302-313`). A Spark asset code would satisfy that trigger
 * independently of `EMBER`, so the two halves of one pile of money could drift apart with nothing
 * able to notice — and reconciling them again would need a rate between an internal unit and a
 * chain asset, which is exactly the mechanism that mints liability against nothing.
 *
 * One asset, one trial balance, one number to reconcile against the chain. `index.test.ts` greps
 * this file to keep that code from ever appearing as a quoted string literal — which is the exact
 * edit that would add it to the union. The identifiers below are named for the denomination and
 * are deliberately not string literals.
 */
export const SPARK_DECIMALS = 6

/** EMBER's decimals, named once so the Spark arithmetic below cannot drift from `CHAINS.EMBER`. */
export const EMBER_DECIMALS = 18

/**
 * One Spark, in wei. `10 ** (18 - 6)` = 10¹².
 *
 * Computed from the two exponents rather than written as a literal, because a literal with twelve
 * zeros in it is a literal somebody eventually types with eleven. `index.test.ts` asserts it
 * against `CHAINS.EMBER.decimals` so the constant cannot outlive a change to the chain spec.
 */
export const WEI_PER_SPARK = 10n ** BigInt(EMBER_DECIMALS - SPARK_DECIMALS)

/** Wei to whole Sparks, for display. Throws on a sub-Spark remainder rather than hiding it. */
export function toSparks(wei: bigint): bigint {
  if (wei % WEI_PER_SPARK !== 0n) {
    throw new RangeError(`${wei} wei is not a whole number of Sparks`)
  }
  return wei / WEI_PER_SPARK
}

/** Sparks to wei. The direction a client's "400 Sparks" arrives in. */
export function fromSparks(sparks: bigint): bigint {
  return sparks * WEI_PER_SPARK
}

/* ────────────────────────────────────────────────────────── USD, and the retirement of the peg */

/** USD is held as cents. Two places, integer, always — the same unit `contracts-money` uses. */
export const USD_CENTS_DECIMALS = 2

/**
 * A coin amount, in smallest units, for a price stated in **US cents**.
 *
 * This is the conversion that replaces the Shard peg. A price is durable in USD and the coin
 * amount is a settlement-time question, because there is no market price for EMBER — Hearth has no
 * exchange listing, so `micro-pricing` carries an *administered* number for it
 * (`pricing/src/rates.ts:55`, seeded at 0.25 USD in `pricing/src/migrations.ts:185`). An
 * administered rate is a figure an operator typed. Storing a price in EMBER against it would mean
 * that editing that figure silently restates every stated dollar price in the catalogue, which is
 * precisely the silent revaluation this estate is trying to stop.
 *
 * **Rounds down**, matching the direction rule already used above: dust falls in the payer's
 * favour and is visible to reconciliation, never in the platform's favour and invisible.
 *
 * **A positive price must never convert to zero.** Rounding down can reach `0n` for a small enough
 * price or a large enough rate, and `0n` here is a free purchase — the same shape of defect as
 * `BigInt('')` being `0n`. So it throws instead, and the caller decides. Callers must not paper
 * over this with `|| someDefault`.
 */
export function coinAmountForUsdCents(
  cents: bigint,
  decimals: number,
  usdPerCoinScaled: bigint,
): bigint {
  if (cents < 0n) throw new RangeError('cents must not be negative')
  if (usdPerCoinScaled <= 0n) throw new RangeError('rate must be positive')
  const multiplier = 10n ** BigInt(decimals)
  const centsPerCoinScaled = usdPerCoinScaled * 10n ** BigInt(USD_CENTS_DECIMALS)
  const amount = (cents * multiplier * RATE_SCALE) / centsPerCoinScaled
  if (amount === 0n && cents > 0n) {
    throw new RangeError(
      `a price of ${cents} cents converts to zero smallest units at this rate — refusing to price something at nothing`,
    )
  }
  return amount
}

/**
 * Shards per US dollar. 100 Shards = 1 USD, fixed.
 *
 * @deprecated Shards are being retired. This constant survives for two reasons and no others:
 * `micro-pricing` still publishes a Shard column from it (`pricing/src/rates.ts:202`), and it is
 * the peg that the one-time re-denomination of `micro-billing`'s catalogue was computed against
 * (billing migration 11). Because the peg is exactly 100 Shards to 100 cents, that conversion is
 * the identity on the stored integer — see the migration, which argues it. Use
 * `coinAmountForUsdCents` for anything new.
 */
export const SHARDS_PER_USD = 100n

/**
 * Convert a smallest-unit coin amount to Shards at a scaled USD rate.
 *
 * **Rounds down, always.** Rounding a credit up mints Shards that no coin backs; over enough
 * conversions that is a growing, invisible liability. Rounding down leaves dust in the user's
 * favour on the coin side, which reconciliation can see.
 *
 * @deprecated Shards are being retired — see `AssetCode`. This is retained because
 * `micro-pricing` still derives a Shard column from it and `contracts-money`'s `moneyForShards`
 * still calls it; both are read paths over an asset that is being wound down, not new issuance.
 * Nothing new should convert *into* Shards.
 */
export function shardsForCoinAmount(
  smallestUnits: bigint,
  decimals: number,
  usdPerCoinScaled: bigint,
): bigint {
  if (smallestUnits < 0n) throw new RangeError('amount must not be negative')
  if (usdPerCoinScaled < 0n) throw new RangeError('rate must not be negative')
  const divisor = 10n ** BigInt(decimals)
  return (smallestUnits * usdPerCoinScaled * SHARDS_PER_USD) / (divisor * RATE_SCALE)
}

/**
 * The inverse. Also rounds down, so a user is never given more coin than their Shards buy.
 *
 * @deprecated Shards are being retired — see `AssetCode`. Use `coinAmountForUsdCents`, which
 * converts from the durable USD figure directly and does not route a price through an internal
 * unit that has no chain behind it.
 */
export function coinAmountForShards(
  shards: bigint,
  decimals: number,
  usdPerCoinScaled: bigint,
): bigint {
  if (shards < 0n) throw new RangeError('shards must not be negative')
  if (usdPerCoinScaled <= 0n) throw new RangeError('rate must be positive')
  const multiplier = 10n ** BigInt(decimals)
  return (shards * multiplier * RATE_SCALE) / (usdPerCoinScaled * SHARDS_PER_USD)
}

/**
 * Format a smallest-unit amount for display. Never used for arithmetic.
 *
 * Returns a plain decimal string with no thousands separators and no currency symbol, because
 * locale formatting belongs in the browser and a formatted number that finds its way back into a
 * calculation is a bug waiting to happen.
 */
export function formatAmount(smallestUnits: bigint, decimals: number): string {
  const negative = smallestUnits < 0n
  const abs = negative ? -smallestUnits : smallestUnits
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const fraction = abs % divisor
  const sign = negative ? '-' : ''
  if (decimals === 0) return `${sign}${whole}`
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fractionText ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`
}

/** Parse a decimal string into smallest units. Refuses more precision than the asset has. */
export function parseAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim()
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new RangeError(`not a decimal amount: ${text}`)
  const negative = trimmed.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.')
  if (fraction.length > decimals) {
    throw new RangeError(`too many decimal places for an asset with ${decimals}`)
  }
  const padded = fraction.padEnd(decimals, '0')
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded)
  return negative ? -value : value
}

/** Is a deposit creditable at this depth? The single question every crediting path asks. */
export function isConfirmed(asset: AssetCode, confirmations: number): boolean {
  return confirmations >= chainSpec(asset).confirmations
}

/** Should a reorg of this depth halt the chain? */
export function isReorgAlarming(asset: AssetCode, depth: number): boolean {
  const spec = chainSpec(asset)
  return spec.reorgAlarmDepth > 0 && depth >= spec.reorgAlarmDepth
}

export function explorerTxUrl(asset: AssetCode, network: Network, txHash: string): string | null {
  const base = chainSpec(asset).explorerTxUrl[network]
  return base ? `${base}${txHash}` : null
}

/**
 * A canonical URN for a chain transaction, used as a cross-service reference.
 *
 * Includes the network, because an XRP address and its transactions are valid on testnet and
 * mainnet alike — a reference without the network is ambiguous in exactly the case that matters.
 */
export function txUrn(asset: AssetCode, network: Network, txHash: string): string {
  return `cf:chain:${asset.toLowerCase()}:${network}:${txHash}`
}
