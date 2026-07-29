import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAINS,
  ON_CHAIN_ASSETS,
  RATE_SCALE,
  SHARDS_PER_USD,
  chainSpec,
  coinAmountForShards,
  explorerTxUrl,
  formatAmount,
  isConfirmed,
  isReorgAlarming,
  parseAmount,
  shardsForCoinAmount,
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
