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
 * micro-contracts out at `main` with no `ref:` (`org/.github/workflows/service-ci.yml`). So a
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
 * 132,000 units** right now. `ledger/src/jobs.ts` maps `SHARD` onto the synthetic `platform`
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
 * (`org/.github/workflows/service-ci.yml`), so the union is shared at HEAD by roughly a dozen
 * repositories at once — see the header, which used to claim otherwise.
 */
export type AssetCode = 'EMBER' | 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'LTC' | 'DOGE' | 'ETC' | 'SHARD'

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
  /**
   * How long one block (or ledger, or slot) takes, in seconds. `null` for an asset with no chain.
   *
   * ── WHY THIS IS HERE WHEN THE HEADER SAYS NOTHING THAT MOVES MONEY MAY DEPEND ON A BLOCK TIME ──
   *
   * It is still true that nothing may. This field is **display-only** and the rest of this file is
   * arranged so that it cannot become anything else: no function here reads it, `isConfirmed` still
   * answers from `confirmations` alone, and a wrong value costs an estimate on a card and nothing
   * else. Read `blockSecondsIsAdvisory` below before using it for anything.
   *
   * What it replaces is worse than what it risks. `hub-api/src/nextactions.ts` carried a private
   * `BLOCK_SECONDS` map typed `Partial<Record<AssetCode, number>>` to turn "41/60 confirmations"
   * into "~5 min" on the deposit card. Being partial, it had rows for EMBER, ETH, BTC, SOL and XRP
   * and none for LTC, DOGE or ETC — and a missing row is `undefined`, so the estimate silently
   * became `null` and the card simply stopped saying how long. That degradation is honest but it
   * lands hardest exactly where it is least affordable: **ETC credits at 7,500 blocks**, so the one
   * asset in this file whose deposit takes over a day was also the one the screen refused to put a
   * time against.
   *
   * The general form of that defect is the reason for a field rather than a fourth copy of the
   * table. `CHAINS` is `Readonly<Record<AssetCode, ChainSpec>>` and therefore TOTAL, so a new asset
   * added to the union cannot compile without a decision here — where the other numbers about the
   * chain already are, next to the depth they will be multiplied by.
   *
   * ── TARGETS AND MEASUREMENTS ARE BOTH USED, AND WHICH ONE IS NOT A STYLE CHOICE ────────────────
   *
   * A chain that ENFORCES a spacing gets its enforced figure, because a mean sampled from it is a
   * measurement of the retarget's error rather than of the chain. A chain that does not gets a
   * dated measurement. Each row below says which it is and where it came from, and every citation
   * was re-read or re-run on 2026-08-09 rather than copied from this file's own prose.
   */
  readonly blockSeconds: number | null
}

/**
 * **`blockSeconds` IS ADVISORY. NOTHING MAY CREDIT, RELEASE, EXPIRE OR RECONCILE AGAINST IT.**
 *
 * Named as a constant so that the rule has somewhere to be imported from and asserted about, rather
 * than living only in a comment on a field that a future reader meets through autocomplete.
 *
 * The rule is the header's, restated for the one field it applies to: `confirmations` is a contract
 * that `wallet`, `settlement`, `custody` and `indexer` agree on byte-for-byte, and a skew in it is
 * money credited at the wrong depth. `blockSeconds` is an estimate of wall-clock time, it drifts
 * with hashrate on every proof-of-work chain here, and a deposit that became creditable because
 * enough SECONDS had passed would be a deposit credited without the chain's agreement. `isConfirmed`
 * takes a block count and will keep taking one.
 *
 * What it is for: telling a user roughly how long they are waiting, beside a confirmation count
 * that remains the authoritative figure.
 */
export const blockSecondsIsAdvisory = true as const

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
    // TARGET, from `hearth/README.md` — "Block time: 15 seconds" — and the figure Hearth's LWMA
    // retarget aims at. Deliberately NOT measured, even though mainnet is reachable and a mean
    // could be taken: `network-site/src/content/facts.ts` already ruled on this exact number and
    // the ruling holds here — "a measurement is a runtime figure and belongs to the chain index".
    // The consequence to know when reading an estimate built from it: Hearth is young, so the
    // observed spacing runs LONGER than the target and this number flatters the wait.
    blockSeconds: 15,
    chainId: Object.freeze({ mainnet: 7411, testnet: 7412 }),
    // The two environments run side by side on one host under one apex: mainnet at
    // `cloudsforge.online`, testnet under the SINGLE-LABEL suffix `-testnet.cloudsforge.online`.
    // Both explorers are real and both are served — `micro-deploy/cloudflared/
    // config.mainnet.public.yml` and `config.testnet.public.yml`.
    //
    // THIS LINE HAS BEEN WRONG TWICE, IN TWO DIFFERENT WAYS, AND THE SECOND IS WHY THE HOSTNAME
    // SHAPE IS SPELLED OUT HERE. First it said the mainnet host twice, so a testnet hash opened
    // the mainnet explorer and was told it did not exist. The repair pointed at
    // `explorer.testnet.cloudsforge.online` — testnet as an apex PREFIX, two labels deep. That
    // host does not resolve and cannot: Cloudflare Universal SSL's wildcard covers exactly ONE
    // label, so `*.cloudsforge.online` matches `explorer-testnet` and not `explorer.testnet`.
    // The link stopped being wrong-network and started being unreachable — measured, not
    // inferred: it answers nothing at all, where `explorer-testnet.cloudsforge.online` answers
    // 200. `micro-deploy/compose/env/traefik.testnet.env:104` is the authority for the shape,
    // `CF_WEB_SUFFIX=-testnet.cloudsforge.online`, and every testnet surface is formed from it.
    //
    // `explorers()` guards only that the two differ, which BOTH broken versions satisfied. It
    // cannot know whether a hostname resolves, so that half stays a matter of reading this
    // comment before editing the line.
    explorerTxUrl: explorers(
      'https://explorer.cloudsforge.online/#/tx/',
      'https://explorer-testnet.cloudsforge.online/#/tx/',
    ),
  }),
  ETH: Object.freeze({
    asset: 'ETH',
    family: 'evm',
    name: 'Ethereum',
    decimals: 18,
    confirmations: 12,
    reorgAlarmDepth: 3,
    // ENFORCED, not measured. Post-Merge Ethereum has a fixed slot clock:
    // `ethereum/consensus-specs`, `configs/mainnet.yaml`, read at `master` on 2026-08-09, carries
    // `SLOT_DURATION_MS: 12000`. Missed slots make the observed MEAN a little above 12, which is
    // why the enforced figure is the honest one to publish — sampling it would measure how often
    // proposers are offline, not how long a block takes.
    blockSeconds: 12,
    chainId: Object.freeze({ mainnet: 1, testnet: 11155111 }),
    explorerTxUrl: explorers('https://etherscan.io/tx/', 'https://sepolia.etherscan.io/tx/'),
  }),
  /**
   * Ethereum Classic. The EVM family's second network, and **the deepest credit depth in this
   * file by three orders of magnitude.** That number is the entire content of this comment.
   *
   * `family: 'evm'` and no new family, which is what `docs/ecosystem/29-native-assets.md` §2
   * already decided when it worked the question through for BSC: "Adding it means either a second
   * asset code with its own spec (fine, that is what BNB is) or a notion of *network within family*
   * that the type does not have. Prefer the former." ETC is that shape exactly — same EVM, same
   * `eth_*` JSON-RPC, same 18 decimals, same address encoding, different chain ids.
   *
   * ── CONFIRMATIONS ARE 7500, NOT ETH'S 12, AND THE REASON IS THIS CHAIN'S OWN HISTORY ──────────
   *
   * Ethereum Classic is a minority-hashrate proof-of-work chain that has been 51%-attacked
   * repeatedly, and the reorganisations were not deep in the way a chain analyst means "deep" —
   * they were deep in the way that makes a confirmation depth meaningless. Reported depths:
   *
   *   2019-01     ~100 blocks     double spends of roughly 219,500 ETC
   *   2020-08-01  ~3,693 blocks
   *   2020-08-06  ~4,236 blocks
   *   2020-08-29  ~7,000 blocks
   *
   * MEASURED 2026-08-08 against `https://etc.rivet.link`: `eth_chainId` answers `0x3d` (61), and
   * 10,000 blocks either side of head spanned 137,004 seconds — **a mean block time of 13.70s**.
   * So those reorgs were, respectively, ~23 minutes, ~14.1 hours, ~16.1 hours and ~26.6 hours of
   * chain. ETH's twelve confirmations is **2.7 minutes** on this chain. Every one of the four
   * attacks above would have retracted a deposit credited at that depth, and three of them would
   * have retracted a deposit credited at any depth a person would call generous.
   *
   * **The rule chosen is: credit no shallower than the deepest reorganisation this chain has
   * actually produced.** 7,500 × 13.70s ≈ 28.5 hours, which clears the 2020-08-29 event with
   * margin. It is a rule rather than a feeling because the alternatives are all feelings: any
   * number between 12 and 7,000 is a bet that the next attack is smaller than the last one, and
   * this estate's central guarantee is that no balance exists that the chain does not back.
   *
   * **WHAT HAS CHANGED SINCE 2020, AND WHY IT IS NOT A REASON TO GO SHALLOWER.** ETC adopted MESS
   * (ECIP-1100) in late 2020, which prices deep reorgs out subjectively, and the Ethereum merge in
   * 2022 pushed a large body of GPU hashrate onto Etchash, so rentable hashrate as a fraction of
   * ETC's own is far below what it was. Both are real and both are mitigations. A confirmation
   * depth is not a mitigation — it is what the estate is left holding when the mitigations fail,
   * which is the only circumstance in which the number is ever read. Setting it from the strength
   * of a defence rather than from the damage it is defending against is how BTC came to sit at 3.
   *
   * **THE COST IS ~28 HOURS TO CREDIT AN ETC DEPOSIT, AND IT IS BEING PAID DELIBERATELY.** That is
   * a product decision as much as a security one and it should be argued again by whoever wants
   * ETC deposits to feel instant. What must not happen is that it is argued by *lowering this
   * number quietly*: `index.test.ts` pins it, and the pin is the intended experience. The same
   * freedom the BTC note above relies on applies here — `INDEXER_CHAINS` has never followed ETC,
   * no ETC deposit has ever been credited at any depth, so there is no in-flight deposit to
   * re-judge. Changing it costs nothing today and is a migration after the first real deposit.
   *
   * `reorgAlarmDepth: 100` is anchored on the same table from the other end: alarm at the depth of
   * the SMALLEST attack this chain has suffered, credit past the depth of the LARGEST. 100 blocks
   * is ~23 minutes, far above ordinary one- and two-block noise, and it fires roughly 27 hours
   * before anything could be wrongly credited — which is the whole point of having the two numbers
   * be different. ETH's 3 would be ~41 seconds and would page on ordinary chain behaviour.
   *
   * ── GAS: ETC IS LEGACY, NOT EIP-1559, AND IT FALLS ON EMBER'S SIDE OF THE LINE ────────────────
   *
   * `docs/ecosystem/35-chain-solvency-invariant.md` §G4 draws the line and states the consequence:
   * settlement fixes an outbound's fee at planning time as `gasPrice × TRANSFER_GAS` and books
   * that figure, "so on a legacy-gas EVM chain the platform pays *exactly* what was booked … Any
   * EIP-1559 chain must book from the receipt (`gasUsed × effectiveGasPrice`) before it is
   * reconciled", because otherwise the booked estimate exceeds the burn on nearly every
   * transaction and zero tolerance turns that into a freeze per payment.
   *
   * **ETC did not adopt London.** There is no base fee, no `maxFeePerGas`, and the effective gas
   * price is the one that was signed. ETC therefore sits with EMBER on the safe side, and the
   * plan-time booking is exact for it — no receipt-reading work is required to reconcile ETC.
   *
   * This is recorded as prose rather than as a field because `ChainSpec` has no gas model on it
   * and one should not be invented here for a single consumer: nothing in `contracts` branches on
   * EIP-1559, and `settlement/src/fees.ts` and `settlement/src/evm.ts` are where the distinction is
   * acted on. **Note for whoever wires the EVM adapter: the asset on this family that DOES need the
   * receipt fix is ETH, not ETC, and it needs it today rather than because of this change.**
   *
   * Chain ids measured live on 2026-08-08 rather than copied from a list: mainnet `eth_chainId` is
   * `0x3d` = 61 (`etc.rivet.link` and `etc.etcdesktop.com`, independently), and Mordor's is `0x3f`
   * = 63 (`rpc.mordor.etccooperative.org`). Mordor is the surviving ETC testnet; Kotti (6) was
   * retired and Morden (62) long before it, so 63 is the only honest value for `testnet` here.
   */
  ETC: Object.freeze({
    asset: 'ETC',
    family: 'evm',
    name: 'Ethereum Classic',
    decimals: 18,
    confirmations: 7500,
    reorgAlarmDepth: 100,
    // MEASURED, because ETC enforces no spacing — it is Ethash with a difficulty adjustment and no
    // slot clock, so there is no target to quote. Re-run 2026-08-09 against `https://etc.rivet.link`
    // (the same endpoint the depth above was derived from): blocks 25,102,520 → 25,112,520 spanned
    // 134,835 seconds, a mean of 13.4835s. The spec above records 13.70s from 2026-08-08; the two
    // agree to within 2%, which is the drift a proof-of-work chain has by construction and the
    // reason this field is advisory. Rounded to 13.5 rather than carried to four places, because
    // the digits past that are noise and publishing them would imply a precision nobody has.
    //
    // 7,500 × 13.5s ≈ 28.1 hours, which is what the depth above costs a depositor — and the number
    // that used to have nowhere to be displayed from.
    blockSeconds: 13.5,
    chainId: Object.freeze({ mainnet: 61, testnet: 63 }),
    // Both verified 200 on 2026-08-08 against a full-length hash path, and they differ, which is
    // the property `explorers()` guards. Blockscout rather than a chain-agnostic aggregator
    // because it serves both networks under one shape — the EMBER lesson is that a mainnet-only
    // explorer with a hand-built testnet sibling is how a testnet hash reaches a mainnet page.
    explorerTxUrl: explorers('https://etc.blockscout.com/tx/', 'https://etc-mordor.blockscout.com/tx/'),
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
    // ENFORCED. `bitcoin/bitcoin`, `src/kernel/chainparams.cpp`, read at `master` on 2026-08-09:
    // `consensus.nPowTargetSpacing = 10 * 60`. The difficulty retarget exists to hold this, so it
    // is the figure to publish; a short sample says nothing, and one taken on 2026-08-09 over the
    // last 14 blocks came out at 395s, which is Poisson noise rather than a faster Bitcoin.
    blockSeconds: 600,
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
    // ENFORCED. `litecoin-project/litecoin`, `src/chainparams.cpp`, read at `master` on 2026-08-09:
    // `consensus.nPowTargetSpacing = 2.5 * 60`. This is the number the depth above was argued from
    // — "twelve is ~30 minutes" — so it now sits beside it instead of only in the prose, and 12 ×
    // 150s = 1,800s is that claim as arithmetic rather than as a sentence.
    blockSeconds: 150,
    explorerTxUrl: explorers('https://litecoinspace.org/tx/', 'https://litecoinspace.org/testnet/tx/'),
  }),
  /**
   * Dogecoin. Litecoin's shape, Litecoin's RPC, and NOT Litecoin's depth.
   *
   * `family: 'bitcoin'` for the reasons the LTC comment above sets out and which were re-checked
   * against that spec rather than assumed: Dogecoin Core answers the same bitcoind JSON-RPC the
   * Bitcoin worker already speaks — `getblockchaininfo`, `getblockcount`, `getblockhash`,
   * `getblock`, `getrawtransaction` — its transaction structure is Bitcoin's, and its addresses
   * come off the node rather than being derived by the indexer. So the follower, the reorg repair
   * and the UTXO extraction are reused.
   *
   * `docs/ecosystem/29-native-assets.md` §2 is blunt about what that does *not* buy, and it is
   * worth repeating where the spec is rather than leaving it in a document: "the indexer's Bitcoin
   * worker reads Esplora, and the Esplora ecosystem is thin-to-absent for Dogecoin … the dust
   * thresholds differ, and Dogecoin's fee policy is a different animal from Bitcoin's. Call it
   * **half an integration each**, not a configuration change." Nothing in this spec makes that
   * false. What it does is fix the numbers that must not be decided twice.
   *
   * ── CONFIRMATIONS ARE 30, DERIVED FROM THE BLOCK TIME RATHER THAN COPIED FROM LTC ─────────────
   *
   * MEASURED 2026-08-08 over the 1,000 blocks below head 6,323,952 (BlockCypher's `/v1/doge/main`):
   * 63,401 seconds, **a mean block time of 63.40s**. Litecoin's is ~2.5 minutes and it credits at
   * 12, i.e. ~30 minutes; Bitcoin's is ~10 minutes and it credits at 6, i.e. ~60 minutes. Thirty
   * blocks here is 30 × 63.40s ≈ **31.7 minutes**, which is Litecoin's wall clock and half
   * Bitcoin's.
   *
   * Litecoin's 12 was the number to beware of, and copying it would have been the exact mistake
   * the LTC comment names one paragraph up — "a depth is a property of a chain's security budget
   * and block time, never of the software that follows it". Twelve Dogecoin blocks is **12.7
   * minutes**, less than half the time the same estate insists on for Litecoin, on a chain whose
   * blocks are individually four times cheaper to produce.
   *
   * Wall-clock parity with LTC is the argument and it deliberately stops there, because the
   * security half does not point the same way in both directions and should not be quietly
   * averaged in: Dogecoin has been merge-mined with Litecoin under AuxPoW since 2014, so its work
   * is Litecoin's Scrypt work rather than a small independent budget — which is why 30 is not
   * pushed higher — while a single Dogecoin block still commits a quarter of the work a Litecoin
   * block does, which is why it is not pushed lower.
   *
   * `reorgAlarmDepth: 15` keeps LTC's relationship exactly: LTC alarms at 6 against 12, half the
   * credit depth, so 30 gives 15. Half rather than a copied absolute, because what LTC's 6 encodes
   * is a fraction of a credit depth and not a count of blocks.
   *
   * ── WHAT IS NOT HERE, AND IS NOT AN OVERSIGHT ─────────────────────────────────────────────────
   *
   * **Dogecoin has no bech32 and no segwit.** Addresses are base58: P2PKH at version byte `0x1e`
   * (they begin with `D`) and P2SH at `0x16`. There is no HRP to give it, and if a consumer ever
   * derives one for this asset by pattern-matching against LTC's `ltc1`/BTC's `bc1`, it will
   * produce addresses that no Dogecoin node will ever pay to. **Its SLIP-0044 coin type is 3**
   * (Bitcoin 0, Litecoin 2), so a derivation path built by incrementing LTC's lands on a different
   * chain's keys.
   *
   * Neither fact is a field, because `ChainSpec` carries no address parameters at all: the LTC
   * comment above records that address encoding "lives in custody and settlement as a network
   * parameter table (different version bytes, a different bech32 HRP and a different WIF byte)",
   * and that is still the right home for it. They are written here because this file is what a
   * person reads when they add the asset, and because "no bech32" is a fact most easily encoded by
   * omission — which is indistinguishable from having forgotten it unless somebody says so.
   */
  DOGE: Object.freeze({
    asset: 'DOGE',
    family: 'bitcoin',
    name: 'Dogecoin',
    decimals: 8,
    confirmations: 30,
    reorgAlarmDepth: 15,
    // One provider serving BOTH networks, verified 200 on each on 2026-08-08. The obvious mainnet
    // explorers — blockchair, dogechain.info, BlockCypher's — have no testnet sibling under a
    // shape this prefix can carry, and `explorers()` would have accepted a mainnet URL beside a
    // null while a person filled the null in later with whatever looked close. That is EMBER's
    // defect written out longhand, so the pair is taken from one provider or not at all.
    explorerTxUrl: explorers(
      'https://blockexplorer.one/dogecoin/mainnet/tx/',
      'https://blockexplorer.one/dogecoin/testnet/tx/',
    ),
    // MEASURED, and the only row where the measurement and the chain's own target disagree enough
    // to matter. `dogecoin/dogecoin`, `src/chainparams.cpp`, read at `master` on 2026-08-09, says
    // `consensus.nPowTargetSpacing = 60; // 1 minute`. Blocks arrive slower than that: over blocks
    // 6,323,657 → 6,324,657 (BlockCypher `/v1/doge/main`, 2026-08-09) 1,000 blocks spanned 63,298
    // seconds, a mean of 63.298s, ~5.5% above target. That is what a chain whose difficulty is
    // retargeted per block looks like when merge-mined hashrate is drifting rather than steady, and
    // it is the number a depositor experiences: 30 × 63.3s ≈ 32 minutes, against the 30 minutes the
    // target would promise. The published figure is the measured one for the same reason the ETC
    // row above uses a measurement — the estimate exists to predict a wait, not to quote a policy.
    blockSeconds: 63.3,
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
    // ENFORCED, and the one row where "block" means slot. `solana-labs/solana`,
    // `sdk/program/src/clock.rs`, read at `master` on 2026-08-09: `DEFAULT_MS_PER_SLOT` is derived
    // from `DEFAULT_TICKS_PER_SLOT` and `DEFAULT_TICKS_PER_SECOND` and pinned by
    // `const_assert_eq!(DEFAULT_MS_PER_SLOT, 400)`. A 2026-08-09 sample over 100,000 slots gave
    // 0.42159s — slots are SKIPPED when a leader misses, so wall-clock always runs above the
    // constant — but the skip rate is a network-health figure that moves week to week, and pinning
    // a display estimate to it would make this file drift. `confirmations: 32` above counts slots,
    // so 32 × 0.4s ≈ 13s is the estimate; the real wait is nearer 14s, which is inside the rounding
    // a "minutes" display does anyway.
    blockSeconds: 0.4,
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
    // MEASURED, because the XRP Ledger enforces no close interval at all: a ledger closes when the
    // validators agree one has, so there is no constant in `XRPLF/rippled` to cite the way BTC and
    // LTC have one. Over ledgers 106,173,077 → 106,174,077 (`xrplcluster.com`, 2026-08-09) 1,000
    // ledgers spanned 3,880 seconds, a mean of 3.88s, published as 3.9. `confirmations: 1` above
    // means this is the whole wait — the only row where `blockSeconds` and the user's wait are the
    // same number — and the ledger is final on close, so the estimate does not decay into a lie the
    // way it would on a probabilistic chain.
    blockSeconds: 3.9,
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
    // `null`, not `0`, and the distinction is the reason the field is nullable. SHARD never touched
    // a chain, so there is no block and no source to cite; `0` would be a number, and a number here
    // multiplies by a remaining depth to produce "0 minutes" — an estimate that reads as "any
    // moment now" for a thing that will never arrive. `null` makes a consumer say nothing instead,
    // which is what `hub-api`'s deposit card does with it.
    blockSeconds: null,
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
 *
 * ── DOGE AND ETC, 2026-08-08, AND THE ONE PLACE THE LIST ABOVE WAS INCOMPLETE ───────────────────
 *
 * The next asset turned out to be two, and they went through the four items above exactly as
 * written. Item 2 was done FIRST and separately, which is the part that is a rule rather than an
 * anecdote: `micro-pricing`'s venue maps carried `DOGE` and `ETC` — measured against all four live
 * venues, not inferred — and merged on their own before this line was touched. That PR is inert on
 * its own, because `quoted()` intersects the maps with `MARKET_ASSETS`, and `MARKET_ASSETS` is
 * derived from this array. **It must be merged before this file reaches `main`, or `micro-pricing`
 * goes red on a change it does not contain.**
 *
 * Two things were learned that the list above did not say, and both belong to it now.
 *
 *   5. **A PRICING FIXTURE IS PART OF THE PRICE SOURCE.** Widening the four symbol maps is not
 *      sufficient. `pricing/src/sources.test.ts` drives every venue through a fake keyed by asset
 *      and then asserts the answer's key set EQUALS `MARKET_ASSETS`; an asset that reaches this
 *      array while absent from that fixture reads as `undefined`, is dropped by `collect`, and
 *      fails the comparison. The symbol map makes the LIVE oracle safe and the fixture makes the
 *      SUITE survive — they are two halves of item 2 and the second was invisible until now.
 *   6. **THE UNION IS WIDENED HERE AND NOWHERE ELSE, SO THE PRICING PR CANNOT NAME ITS OWN
 *      ASSETS.** `pricing`'s maps are `Partial<Record<AssetCode, …>>`. Writing `DOGE:` inside the
 *      object literal is accepted (the literal passes through `Object.freeze`, which loses the
 *      excess-property check), but `COINGECKO_IDS['DOGE']` is a TS7053 against a union that does
 *      not yet contain it. So the earlier repository can carry the DATA but cannot yet TYPE it,
 *      and its test says so in a comment rather than pretending otherwise. This is a property of
 *      wiring-before-listing in general, not of these two assets.
 *
 * Item 3, `site`'s published count, re-derives itself from this array and needs no edit. Item 4,
 * `sdk/tools/drift.ts`, now compares the SETS — so it will report DOGE and ETC as missing from the
 * SDK's copy the moment this merges. That is the mechanism working, and it is step-2 work in
 * `micro-sdk`, deliberately not done here: `sdk` is a public package that must not import a
 * private one, and a copy that silently agreed would defeat the drift check that caught it.
 *
 * Item 1 — the follower, the addresses and the sweep — is NOT done for either asset, and this is
 * the one place these two differ from LTC. They are listed here because the ledger can supervise a
 * balance denominated in them and the oracle can price them, not because a deposit can arrive.
 * `INDEXER_CHAINS` follows neither, so no DOGE or ETC deposit has ever been credited at any depth,
 * which is exactly the window in which a confirmation depth is still a constant rather than a
 * migration — see the ETC spec, which spends 7,500 blocks of latency inside it.
 */
export const ON_CHAIN_ASSETS: readonly AssetCode[] = Object.freeze([
  'EMBER',
  'BTC',
  'ETH',
  'ETC',
  'LTC',
  'DOGE',
  'SOL',
  'XRP',
])

/**
 * **The assets a deposit can actually arrive in.** A strict subset of `ON_CHAIN_ASSETS`, and the
 * only list that may appear in a promise made to a customer.
 *
 * ── WHY THIS EXISTS, AND WHY THE ARRAY ABOVE COULD NOT ANSWER THE QUESTION ──────────────────────
 *
 * `ON_CHAIN_ASSETS` answers "which chains does this estate model" — the ledger can supervise a
 * balance denominated in one, the oracle can price it, the SDK can name it. Item 1 of the order
 * written above this file's other list — *wire the follower, the addresses and the sweep* — is a
 * separate fact, and for five of the eight it is not done. The note above `ON_CHAIN_ASSETS` has
 * said so in prose since 2026-08-08: "They are listed here because the ledger can supervise a
 * balance denominated in them and the oracle can price them, **not because a deposit can arrive**."
 *
 * Prose is not a declaration, and while it stayed prose the marketing site derived a promise from
 * the wrong array. `cloudsforge.online` published "Eight coins, not just ours — your wallet holds
 * EMBER, Bitcoin, Ethereum, Ethereum Classic, Litecoin, Dogecoin, Solana, XRP Ledger", correctly
 * derived, and untrue of five of them: send Solana to CloudsForge today and nothing observes it,
 * because no follower is watching that chain and no address was ever handed out on it. The owner
 * caught it on 2026-08-11. This is the same defect `micro-foresight` fixed with
 * `STAKE_ASSET_REGISTRY` (micro-org#291) — *being nameable by the estate and being accepted at the
 * door are different facts, and only the second belongs in a promise* — and it is fixed the same
 * way: the second fact gets a declaration of its own, so a page can derive it instead of inheriting
 * the first one by accident.
 *
 * ── WHAT PUTS AN ASSET ON THIS LIST ─────────────────────────────────────────────────────────────
 *
 * A follower that reads the chain, an address the estate can hand out, and a sweep that moves what
 * arrives. Measured on the mainnet estate on 2026-08-11, `micro-indexer` is configured for exactly
 * three — `INDEXER_RPC_EMBER_MAINNET`, `INDEXER_RPC_BTC_MAINNET`, `INDEXER_RPC_LTC_MAINNET` — and
 * `INDEXER_CHAINS` has never named any other. The five absentees are absent for two distinct
 * reasons, and neither is "nobody got round to it":
 *
 *   - **DOGE** has the code. `family: 'bitcoin'` means it needs no worker of its own
 *     (`indexer/src/chains.ts`), and merge-mining against Litecoin is built. It waits on this
 *     estate's dogecoind, which was 39.6% through initial block download on 2026-08-10.
 *   - **ETH, ETC, SOL and XRP** have no follower running and no address ever issued.
 *
 * ── THE RULE FOR EDITING IT ─────────────────────────────────────────────────────────────────────
 *
 * An asset joins this array in the release that turns its follower on, and not in the one that
 * writes it. The cost of being early here is not a red test — it is a customer sending money to a
 * chain nobody is watching, which is the one failure in this file that cannot be corrected
 * downstream.
 */
export const CREDITABLE_ASSETS: readonly AssetCode[] = Object.freeze(['EMBER', 'BTC', 'LTC'])

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
 * trigger (`ledger/src/migrations.ts`). A Spark asset code would satisfy that trigger
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
 * (`pricing/src/rates.ts`, seeded at 0.25 USD in `pricing/src/migrations.ts`). An
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
 * `micro-pricing` still publishes a Shard column from it (`pricing/src/rates.ts`), and it is
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
