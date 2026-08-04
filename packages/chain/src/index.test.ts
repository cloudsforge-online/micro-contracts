import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  CHAINS,
  EMBER_DECIMALS,
  ON_CHAIN_ASSETS,
  RATE_SCALE,
  SHARDS_PER_USD,
  SPARK_DECIMALS,
  WEI_PER_SPARK,
  assertIssuable,
  chainSpec,
  coinAmountForShards,
  coinAmountForUsdCents,
  explorerTxUrl,
  explorers,
  formatAmount,
  fromSparks,
  isConfirmed,
  isReorgAlarming,
  isRetiredAsset,
  parseAmount,
  shardsForCoinAmount,
  toSparks,
  txUrn,
  type AssetCode,
} from './index.ts'

test('the published confirmation depths are exactly what the estate promises', () => {
  // These are consensus values across wallet, settlement, custody and indexer. A change here is
  // a coordinated release, not an edit — EMBER's 60 is the number Hearth publishes to exchanges.
  assert.equal(CHAINS.EMBER.confirmations, 60)
  assert.equal(CHAINS.ETH.confirmations, 12)
  assert.equal(CHAINS.SOL.confirmations, 32)
  assert.equal(CHAINS.XRP.confirmations, 1)
  assert.equal(CHAINS.BTC.confirmations, 3)
})

test('EMBER is 18 decimals, because Hearth is an account-model EVM chain', () => {
  assert.equal(CHAINS.EMBER.decimals, 18)
  assert.equal(CHAINS.EMBER.chainId?.mainnet, 7411)
  assert.equal(CHAINS.EMBER.chainId?.testnet, 7412)
})

test('every on-chain asset has a spec, and the registry is frozen', () => {
  for (const asset of ON_CHAIN_ASSETS) {
    const spec = chainSpec(asset)
    assert.ok(spec.decimals >= 0)
    assert.ok(spec.confirmations >= 1, `${asset} must require at least one confirmation`)
  }
  assert.throws(() => {
    ;(CHAINS as unknown as Record<string, unknown>)['EMBER'] = null
  })
})

test('an unknown asset throws rather than returning undefined', () => {
  assert.throws(() => chainSpec('DOGE' as AssetCode), /unknown asset/)
})

test('the reorg alarm sits below the credit depth, so shallow reorgs are not noise', () => {
  for (const asset of ON_CHAIN_ASSETS) {
    const spec = chainSpec(asset)
    assert.ok(
      spec.reorgAlarmDepth <= spec.confirmations,
      `${asset}: an alarm deeper than the credit depth can never fire usefully`,
    )
  }
})

test('isConfirmed is the single question every crediting path asks', () => {
  assert.equal(isConfirmed('EMBER', 59), false)
  assert.equal(isConfirmed('EMBER', 60), true)
  assert.equal(isConfirmed('EMBER', 61), true)
  assert.equal(isConfirmed('XRP', 1), true)
})

test('isReorgAlarming fires at the stated depth', () => {
  assert.equal(isReorgAlarming('EMBER', 4), false)
  assert.equal(isReorgAlarming('EMBER', 5), true)
  assert.equal(isReorgAlarming('SHARD', 99), false, 'Shards are not on a chain')
})

test('the Shard peg is 100 to the dollar, at a six-decimal rate scale', () => {
  assert.equal(SHARDS_PER_USD, 100n)
  assert.equal(RATE_SCALE, 1_000_000n)
})

test('one ETH at $2,000 converts to 200,000 Shards', () => {
  const oneEth = 10n ** 18n
  const rate = 2_000n * RATE_SCALE
  assert.equal(shardsForCoinAmount(oneEth, 18, rate), 200_000n)
})

test('CONVERSION ROUNDS DOWN — rounding up would mint Shards no coin backs', () => {
  // 1 wei at $2,000 is worth 0.0000000000000002 Shards. Rounding that up, across enough
  // conversions, is a growing liability that nothing on the chain covers.
  assert.equal(shardsForCoinAmount(1n, 18, 2_000n * RATE_SCALE), 0n)

  // 0.00999 ETH at $100 is $0.999, which is 99.9 Shards. It must floor to 99, never round to 100.
  const justUnder = (10n ** 18n * 999n) / 100_000n
  assert.equal(shardsForCoinAmount(justUnder, 18, 100n * RATE_SCALE), 99n)
})

test('the inverse also rounds down, so Shards never buy more coin than they are worth', () => {
  const coin = coinAmountForShards(200_000n, 18, 2_000n * RATE_SCALE)
  assert.equal(coin, 10n ** 18n)
  // 1 Shard is $0.01; at $2,000 that is 0.000005 ETH, i.e. 5 × 10^12 wei.
  assert.equal(coinAmountForShards(1n, 18, 2_000n * RATE_SCALE), 5_000_000_000_000n)
})

test('a round trip never creates value', () => {
  const rate = 1_234n * RATE_SCALE + 567_000n
  for (const amount of [10n ** 18n, 3n * 10n ** 17n, 7n, 999_999_999_999_999_999n]) {
    const shards = shardsForCoinAmount(amount, 18, rate)
    const back = coinAmountForShards(shards, 18, rate)
    assert.ok(back <= amount, `round trip created value: ${amount} → ${shards} → ${back}`)
  }
})

test('negative amounts and rates are refused rather than silently wrapping', () => {
  assert.throws(() => shardsForCoinAmount(-1n, 18, RATE_SCALE), RangeError)
  assert.throws(() => shardsForCoinAmount(1n, 18, -1n), RangeError)
  assert.throws(() => coinAmountForShards(-1n, 18, RATE_SCALE), RangeError)
  assert.throws(() => coinAmountForShards(1n, 18, 0n), RangeError, 'a zero rate is not a rate')
})

test('conversion is exact at large magnitudes — no float would be', () => {
  // 21 million BTC in satoshis, a magnitude a double cannot represent exactly.
  const allBitcoin = 21_000_000n * 10n ** 8n
  const shards = shardsForCoinAmount(allBitcoin, 8, 100_000n * RATE_SCALE)
  assert.equal(shards, 21_000_000n * 100_000n * 100n)
})

test('formatAmount renders without a float anywhere near it', () => {
  assert.equal(formatAmount(10n ** 18n, 18), '1')
  assert.equal(formatAmount(15n * 10n ** 17n, 18), '1.5')
  assert.equal(formatAmount(1n, 18), '0.000000000000000001')
  assert.equal(formatAmount(0n, 18), '0')
  assert.equal(formatAmount(-15n * 10n ** 17n, 18), '-1.5')
  assert.equal(formatAmount(12345n, 0), '12345')
})

test('parseAmount round-trips with formatAmount', () => {
  for (const text of ['1', '1.5', '0.000000000000000001', '0', '123456.789']) {
    const units = parseAmount(text, 18)
    assert.equal(formatAmount(units, 18), text === '0' ? '0' : text)
  }
})

test('parseAmount refuses more precision than the asset has', () => {
  assert.throws(() => parseAmount('0.123456789', 6), /too many decimal places/)
  assert.equal(parseAmount('0.123456', 6), 123_456n)
})

test('parseAmount refuses anything that is not a decimal', () => {
  for (const bad of ['', 'abc', '1.2.3', '1e18', '0x10', ' ']) {
    assert.throws(() => parseAmount(bad, 18), RangeError, `accepted ${JSON.stringify(bad)}`)
  }
})

test('a transaction URN names its network — an XRP address is valid on both', () => {
  assert.equal(txUrn('XRP', 'testnet', 'ABC'), 'cf:chain:xrp:testnet:ABC')
  assert.notEqual(txUrn('XRP', 'testnet', 'ABC'), txUrn('XRP', 'mainnet', 'ABC'))
})

test('explorer links differ per network, and Shards have none', () => {
  assert.match(explorerTxUrl('ETH', 'mainnet', '0xabc') ?? '', /etherscan\.io\/tx\/0xabc/)
  assert.match(explorerTxUrl('ETH', 'testnet', '0xabc') ?? '', /sepolia/)
  assert.equal(explorerTxUrl('SHARD', 'mainnet', 'x'), null)
})

test("an EMBER testnet link goes to the TESTNET explorer, not the one that says 'not found'", () => {
  // The defect this replaces: both networks named `explorer.cloudsforge.online`, so every testnet
  // hash was linked into the mainnet explorer, which cannot know it. The two environments stand
  // side by side under one apex — `micro-deploy/cloudflared/config.testnet.public.yml:76` serves
  // `explorer.testnet.cloudsforge.online` — so the testnet link has somewhere real to point.
  assert.equal(
    explorerTxUrl('EMBER', 'testnet', '0xdead'),
    'https://explorer.testnet.cloudsforge.online/#/tx/0xdead',
  )
  assert.equal(
    explorerTxUrl('EMBER', 'mainnet', '0xdead'),
    'https://explorer.cloudsforge.online/#/tx/0xdead',
  )
})

test('no chain lends one explorer to two networks — asserted over every chain, not just EMBER', () => {
  // `explorers()` makes this unwritable, so this test cannot fail while the table is built by it.
  // It is here for the case the type is worked around with a cast, and because it states in one
  // place the rule the constructor enforces in another.
  for (const spec of Object.values(CHAINS)) {
    const { mainnet, testnet } = spec.explorerTxUrl
    if (mainnet === null || testnet === null) continue
    assert.notEqual(mainnet, testnet, `${spec.asset} points both networks at ${mainnet}`)
  }
})

test('SOL has no testnet explorer link rather than a mainnet one', () => {
  // Solana's explorers choose the cluster with `?cluster=`, a query this prefix cannot carry. No
  // link is the honest answer; the previous one opened mainnet-beta for a testnet signature.
  assert.equal(explorerTxUrl('SOL', 'testnet', 'sig'), null)
  assert.equal(explorerTxUrl('SOL', 'mainnet', 'sig'), 'https://solscan.io/tx/sig')
})

test('a chain that names one explorer twice does not compile', () => {
  // THIS IS A TYPE ASSERTION, and it is the actual guard — the runtime tests above can only see a
  // table that already exists, whereas this fails at the moment somebody writes the bad row. If
  // `explorers()` ever stops rejecting a repeated URL, `@ts-expect-error` becomes an unused
  // suppression and `tsc --noEmit` fails on THIS LINE. A test that cannot fail is not a check;
  // this one fails in both directions.
  // @ts-expect-error mainnet and testnet may not name the same explorer
  explorers('https://example.test/tx/', 'https://example.test/tx/')

  // ...and a genuinely distinct pair is accepted, so the rejection above is about the equality
  // rather than about the call shape.
  const ok = explorers('https://a.test/tx/', 'https://b.test/tx/')
  assert.equal(ok.testnet, 'https://b.test/tx/')
})

/* ═══════════════════════════════════════════ Sparks, and the asset code they must never become */

test('SPARK is not an asset code anywhere in this file — the source is the assertion', async () => {
  // The same guard `tessera/src/sparks.ts` keeps over itself, kept here because this file is where
  // an asset code would actually be added. It greps the SOURCE rather than the exports, because
  // the failure being prevented is somebody typing `| 'SPARK'` into the union — which a test over
  // the compiled surface would happily accept.
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

  // Any string literal 'SPARK' or "SPARK", and any use as a union member or record key. Prose
  // about Sparks is fine and there is a lot of it; a quoted asset code is not.
  assert.equal(
    /['"`]SPARK['"`]/.test(source),
    false,
    "'SPARK' appears as a string literal — a Spark is a display denomination of EMBER and must never be a second asset code (ledger/src/migrations.ts:302-313)",
  )
  assert.equal(
    (ON_CHAIN_ASSETS as readonly string[]).includes('SPARK'),
    false,
    'SPARK reached ON_CHAIN_ASSETS',
  )
  assert.equal(Object.keys(CHAINS).includes('SPARK'), false, 'SPARK reached CHAINS')
})

test('a Spark is 10^-6 EMBER, derived from the chain spec rather than typed', () => {
  assert.equal(SPARK_DECIMALS, 6)
  // The point of the derivation: change CHAINS.EMBER.decimals and this fails rather than drifting.
  assert.equal(EMBER_DECIMALS, CHAINS.EMBER.decimals)
  assert.equal(WEI_PER_SPARK, 10n ** 12n)
  assert.equal(WEI_PER_SPARK, 10n ** BigInt(CHAINS.EMBER.decimals - SPARK_DECIMALS))
})

test('Spark conversion round-trips, and a sub-Spark remainder is refused not rounded', () => {
  assert.equal(fromSparks(400n), 400_000_000_000_000n)
  assert.equal(toSparks(fromSparks(400n)), 400n)
  // One wei short of a whole Spark. Silently flooring this is how a price loses its last digit.
  assert.throws(() => toSparks(WEI_PER_SPARK - 1n), /not a whole number of Sparks/)
  assert.equal(toSparks(0n), 0n)
})

/* ═════════════════════════════════════════════════════ SHARD's retirement, enforced by the type */

test('SHARD is retired: still nameable, never newly issuable', () => {
  // Nameable — the ledger supervises 114 live SHARD accounts and must keep being able to ask.
  assert.equal(chainSpec('SHARD').decimals, 0)
  assert.equal(isRetiredAsset('SHARD'), true)

  // Not issuable. This is the guard that replaces deleting the union member.
  assert.throws(() => assertIssuable('SHARD'), /retired/)
  for (const asset of ON_CHAIN_ASSETS) {
    assert.equal(isRetiredAsset(asset), false, `${asset} was reported retired`)
    assert.equal(assertIssuable(asset), asset)
  }
})

test('SHARD and EMBER do not share a scale, which is why relabelling is not converting', () => {
  // 250 Shards is $2.50. The same integer read as EMBER is 250 wei — 2.5e-16 EMBER. A migration
  // that changed only `asset_code` would move a price by eighteen orders of magnitude.
  assert.equal(chainSpec('SHARD').decimals, 0)
  assert.equal(chainSpec('EMBER').decimals, 18)
  assert.notEqual(chainSpec('SHARD').decimals, chainSpec('EMBER').decimals)
})

/* ══════════════════════════════════════════════════════════ USD → coin, the peg's replacement */

test('a USD price converts to coin at the administered rate', () => {
  // EMBER's administered price is 0.25 USD (pricing/src/migrations.ts:185) = 250000 scaled.
  const quarter = 250_000n
  // $2.50 = 250 cents. At $0.25/EMBER that is 10 EMBER.
  assert.equal(coinAmountForUsdCents(250n, 18, quarter), 10n * 10n ** 18n)
  // $89.99 at $0.25 is 359.96 EMBER.
  assert.equal(coinAmountForUsdCents(8_999n, 18, quarter), 359_960_000_000_000_000_000n)
})

test('a positive price never converts to zero — that would be a free purchase', () => {
  // One cent at an absurd rate. Flooring reaches 0n, and 0n here is the BigInt('') defect wearing
  // a different hat: a purchase that posts nothing and grants the entitlement anyway.
  assert.throws(() => coinAmountForUsdCents(1n, 0, 10n ** 12n), /converts to zero/)
  // Zero for zero is fine and is not the same thing.
  assert.equal(coinAmountForUsdCents(0n, 18, 250_000n), 0n)
})

test('coinAmountForUsdCents rounds down, in the payer’s favour', () => {
  // A rate that does not divide evenly. Down means the platform collects at most the stated price.
  const rate = 333_333n // $0.333333
  const amount = coinAmountForUsdCents(100n, 18, rate)
  const exact = (100n * 10n ** 18n * RATE_SCALE) / (rate * 100n)
  assert.equal(amount, exact)
  assert.ok(amount * rate * 100n <= 100n * 10n ** 18n * RATE_SCALE)
})

test('coinAmountForUsdCents refuses a negative price and a non-positive rate', () => {
  assert.throws(() => coinAmountForUsdCents(-1n, 18, 250_000n), /must not be negative/)
  assert.throws(() => coinAmountForUsdCents(100n, 18, 0n), /must be positive/)
  assert.throws(() => coinAmountForUsdCents(100n, 18, -1n), /must be positive/)
})
