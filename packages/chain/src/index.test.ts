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
  blockSecondsIsAdvisory,
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
  // Raised from 3 when native BTC deposits were built. See the note on the BTC spec: three was a
  // placeholder nobody had revisited, and it was changed while no deposit had ever been credited
  // at it. This assertion going red is the intended experience of changing it again.
  assert.equal(CHAINS.BTC.confirmations, 6)
  // Litecoin is Bitcoin's family and NOT Bitcoin's depth — ~2.5-minute blocks, so twelve is the
  // ~30 minutes that six would have been on Bitcoin. If this ever equals BTC's, somebody has
  // copied the number along with the code.
  assert.equal(CHAINS.LTC.confirmations, 12)
  assert.notEqual(CHAINS.LTC.confirmations, CHAINS.BTC.confirmations)
  // Dogecoin's ~63.4s blocks (measured 2026-08-08 over 1,000 blocks) put 30 at ~31.7 minutes —
  // Litecoin's wall clock, which is the argument. The `notEqual` is the same guard LTC carries
  // against BTC and it is aimed at the same reflex: LTC's 12 here would be 12.7 minutes.
  assert.equal(CHAINS.DOGE.confirmations, 30)
  assert.notEqual(CHAINS.DOGE.confirmations, CHAINS.LTC.confirmations)
  // ETC IS THE DEEPEST IN THE FILE BY THREE ORDERS OF MAGNITUDE AND THAT IS THE POINT. At ~13.70s
  // blocks it is ~28.5 hours, chosen to clear the ~7,000-block reorg of 2020-08-29 rather than to
  // feel proportionate. See the spec: the four recorded 51% attacks would each have retracted a
  // deposit credited at ETH's 12, which is 2.7 minutes on this chain.
  assert.equal(CHAINS.ETC.confirmations, 7500)
  assert.ok(
    CHAINS.ETC.confirmations > 7000,
    'ETC credits shallower than a reorg it has actually suffered',
  )
  assert.notEqual(CHAINS.ETC.confirmations, CHAINS.ETH.confirmations)
})

test('a second EVM network is one asset code and one spec, and no new family', () => {
  // `docs/ecosystem/29-native-assets.md` §2 decided this for BNB and it applies unchanged to ETC:
  // `CHAINS` is a bijection from asset code to spec, so "another EVM network" is another row —
  // never a `family`, and never a network dimension inside one spec.
  assert.equal(CHAINS.ETC.family, 'evm')
  assert.equal(CHAINS.ETC.family, CHAINS.ETH.family)
  assert.equal(CHAINS.ETC.decimals, 18)
  // Measured live on 2026-08-08: `eth_chainId` is 0x3d (61) on ETC mainnet and 0x3f (63) on Mordor,
  // which is the surviving ETC testnet — Kotti (6) and Morden (62) are both retired.
  assert.equal(CHAINS.ETC.chainId?.mainnet, 61)
  assert.equal(CHAINS.ETC.chainId?.testnet, 63)
  // Two EVM assets must never share a chain id pair: that is the same class of defect as one
  // explorer serving two networks, and it would route an ETC transaction at an ETH node.
  assert.notEqual(CHAINS.ETC.chainId?.mainnet, CHAINS.ETH.chainId?.mainnet)
  assert.notEqual(CHAINS.ETC.chainId?.testnet, CHAINS.ETH.chainId?.testnet)
})

test('DOGE is Bitcoin-family with Bitcoin-family plumbing and none of Litecoin’s constants', () => {
  assert.equal(CHAINS.DOGE.family, 'bitcoin')
  assert.equal(CHAINS.DOGE.family, CHAINS.LTC.family)
  assert.equal(CHAINS.DOGE.decimals, 8)
  // No chain id, for the same reason Bitcoin and Litecoin have none: the network binding is in the
  // WIF and in the node's own `getblockchaininfo.chain`, not in a number inside the transaction.
  // A chain id appearing here would mean somebody had generalised from the EVM specs.
  assert.equal(CHAINS.DOGE.chainId, undefined)
  assert.equal(CHAINS.BTC.chainId, undefined)
  assert.equal(CHAINS.LTC.chainId, undefined)
})

test('every asset that shares a family still gets its own depth — no family-wide constant', () => {
  // The generalisation of the two `notEqual`s above, and the reason it is worth a test of its own:
  // the estate now has three Bitcoin-family assets and two EVM ones, so "reuse the number with the
  // code" has more places to happen than it did when LTC was the only instance. A family whose
  // members all agree on a depth is not proof of a bug, but it is the signature of one, and the
  // arithmetic differs per chain in every case here.
  const byFamily = new Map<string, number[]>()
  for (const spec of Object.values(CHAINS)) {
    if (spec.confirmations === 0) continue // SHARD is retired and never touches a chain.
    byFamily.set(spec.family, [...(byFamily.get(spec.family) ?? []), spec.confirmations])
  }
  for (const [family, depths] of byFamily) {
    if (depths.length < 2) continue
    assert.equal(
      new Set(depths).size,
      depths.length,
      `two ${family} assets credit at the same depth; a depth belongs to a chain, not a family`,
    )
  }
})

test('every spec alarms on a reorg strictly shallower than the one it credits at', () => {
  // The guarantee the whole estate rests on: a reorg deep enough to retract a CREDITED movement is
  // always deep enough to have halted the chain first. A new asset whose alarm depth is set at or
  // above its credit depth removes that quietly, so it is asserted over the registry rather than
  // per asset — a spec added without reading this still has to satisfy it.
  for (const spec of Object.values(CHAINS)) {
    if (spec.confirmations === 0) continue // SHARD is retired and never touches a chain.

    // XRP IS THE ONE EXEMPTION AND IT IS NOT AN OVERSIGHT — it was found by this test, which is the
    // reason the test is written over the registry rather than as five assertions.
    //
    // The ordering exists because on a probabilistic-finality chain "credited" and "reorganisable"
    // overlap, and the alarm has to fire in the gap. XRPL has no such gap: a validated ledger is
    // final, so `confirmations: 1` is not a shallow depth, it is the whole of finality. That leaves
    // nowhere below it to put an alarm. `reorgAlarmDepth: 1` therefore reads as "any reorg at all
    // is an alarm", which for a chain that is not supposed to have them is the strictest available
    // setting, not the weakest — and the alternative, 0, would mean never alarming.
    //
    // The general claim that this ordering holds estate-wide is therefore FALSE as written, and the
    // exemption belongs here where a new spec's author will read it, rather than in prose.
    if (spec.family === 'xrp') {
      assert.equal(spec.confirmations, 1, 'the XRP exemption is only sound at deterministic finality')
      assert.equal(spec.reorgAlarmDepth, 1)
      continue
    }

    assert.ok(
      spec.reorgAlarmDepth < spec.confirmations,
      `${spec.asset} alarms at ${spec.reorgAlarmDepth} but credits at ${spec.confirmations}`,
    )
  }
})

test('every asset carries a block time, and only an asset with no chain may carry none', () => {
  // The point of putting `blockSeconds` on the spec rather than in a consumer's own table: `CHAINS`
  // is `Readonly<Record<AssetCode, ChainSpec>>`, so an asset added to the union without a decision
  // here does not compile. The table this replaced — `BLOCK_SECONDS` in hub-api/src/nextactions.ts
  // — was a `Partial<Record<…>>`, which is the same shape with the compiler switched off: LTC, DOGE
  // and ETC were all missing from it and nothing said so, the deposit card simply stopped printing
  // how long the wait was. This test is that missing error, made explicit.
  for (const spec of Object.values(CHAINS)) {
    if (spec.blockSeconds === null) {
      assert.ok(
        isRetiredAsset(spec.asset),
        `${spec.asset} has no block time but is still issuable; null means "there is no chain"`,
      )
      continue
    }
    assert.ok(
      Number.isFinite(spec.blockSeconds) && spec.blockSeconds > 0,
      `${spec.asset} has a block time of ${spec.blockSeconds}`,
    )
    // A units check, not a value check. Every figure in the registry is in SECONDS; the failure
    // this catches is somebody pasting a chain's own constant in milliseconds — Solana publishes
    // `DEFAULT_MS_PER_SLOT`, Ethereum publishes `SLOT_DURATION_MS` — which would read as an hour
    // per slot and produce a deposit estimate in months.
    assert.ok(
      spec.blockSeconds >= 0.1 && spec.blockSeconds <= 3600,
      `${spec.asset}'s block time of ${spec.blockSeconds} is not plausibly a number of seconds`,
    )
  }
})

test('the longest wait in the estate is ETC, which is the asset that had no block time at all', () => {
  // The defect this field was added for, stated as arithmetic. ETC credits at 7,500 confirmations —
  // an anti-reorg depth, not a caution — so its deposit takes over a day, and it was one of the
  // three assets absent from the consumer's hand-typed table. The asset with the longest wait was
  // the asset whose wait could not be displayed.
  const waits = Object.values(CHAINS)
    .filter((spec) => spec.blockSeconds !== null && spec.confirmations > 0)
    .map((spec) => ({ asset: spec.asset, seconds: spec.confirmations * (spec.blockSeconds ?? 0) }))
    .sort((a, b) => b.seconds - a.seconds)

  assert.equal(waits[0]?.asset, 'ETC')
  assert.ok(
    (waits[0]?.seconds ?? 0) > 24 * 60 * 60,
    'ETC is meant to be the day-long one; if it is not, the depth changed and this is the wrong test',
  )
})

test('BLOCK TIME IS NOT A DEPTH — nothing may credit against it', () => {
  // `blockSecondsIsAdvisory` is a flag a reader trips over, not a switch. The property that makes
  // it true is asserted instead: `isConfirmed` takes a COUNT OF BLOCKS and answers from
  // `confirmations` alone, so no elapsed time — real or estimated — can move it.
  assert.equal(blockSecondsIsAdvisory, true)
  assert.equal(isConfirmed('ETC', 7499), false)
  assert.equal(isConfirmed('ETC', 7500), true)
  // And the same at a wall-clock time far past any estimate this field could produce: the answer
  // still comes from the count, because the count is the only argument there is.
  assert.equal(isConfirmed('DOGE', 29), false)
  assert.equal(isConfirmed('DOGE', 30), true)
})

test('LTC is Bitcoin-family, so the Bitcoin worker and the PSBT pin apply to it unchanged', () => {
  assert.equal(CHAINS.LTC.family, 'bitcoin')
  assert.equal(CHAINS.LTC.decimals, 8)
  // No chain id, like Bitcoin: the network binding is carried by the WIF and by the node's own
  // `getblockchaininfo.chain`, not by a number in the transaction.
  assert.equal(CHAINS.LTC.chainId, undefined)
})

test('LTC IS NOW AN ASSET THE LEDGER HOLDS BALANCES IN — the half-step closed', () => {
  // This test used to assert the opposite: `assert.ok(!ON_CHAIN_ASSETS.includes('LTC'))`, pinning
  // the deliberate half-step in which `chainSpec` answered for Litecoin so the indexer and custody
  // could work with it, while the ledger was not yet asked to reconcile a balance nothing could
  // create. It is INVERTED rather than deleted, because the property worth holding was never
  // "LTC is absent" — it was "these two halves move together". They have now both moved.
  assert.equal(chainSpec('LTC').name, 'Litecoin')
  assert.ok(ON_CHAIN_ASSETS.includes('LTC'))
})

test('DOGE AND ETC ARE ASSETS THE LEDGER MAY HOLD, AND THE PRICE LAYER MERGED FIRST', () => {
  // The half-step LTC passed through is deliberately NOT repeated here: both go into `CHAINS` and
  // into this list in one release, because the thing that made LTC's half-step useful — an indexer
  // and a custody path that could work with the spec while the ledger stayed out — does not exist
  // for either of these yet. `INDEXER_CHAINS` follows neither.
  assert.equal(chainSpec('DOGE').name, 'Dogecoin')
  assert.equal(chainSpec('ETC').name, 'Ethereum Classic')
  assert.ok(ON_CHAIN_ASSETS.includes('DOGE'))
  assert.ok(ON_CHAIN_ASSETS.includes('ETC'))

  // AND THE ORDERING, WHICH IS THE PART THAT IS NOT LOCAL TO THIS REPOSITORY. `micro-pricing`
  // derives `MARKET_ASSETS` from this array, so each name below became an asset its oracle claims
  // to quote at the instant it was added. Both were wired and measured at all four venues in a PR
  // that merged BEFORE this one — see the note above `ON_CHAIN_ASSETS`, items 2, 5 and 6. This
  // assertion cannot check another repository; it is here so that the next person to widen the
  // array reads the requirement while they are editing the line that triggers it.
  assert.equal(ON_CHAIN_ASSETS.length, 8)

  // Neither is retired and both may denominate something new — the property `assertIssuable`
  // guards, asserted for the new members specifically because `RETIRED_ASSETS` is hand-written and
  // a typo there is a silent, permanent refusal to credit.
  assert.equal(isRetiredAsset('DOGE'), false)
  assert.equal(isRetiredAsset('ETC'), false)
})

test('the two new alarm depths keep the relationships they were derived from', () => {
  // DOGE takes LTC's RATIO rather than LTC's number: LTC alarms at half its credit depth (6 of
  // 12), so 30 gives 15. What LTC's 6 encodes is a fraction, and copying it as an absolute would
  // have put the alarm a fifth of the way down instead of halfway.
  assert.equal(CHAINS.DOGE.reorgAlarmDepth, 15)
  assert.equal(CHAINS.DOGE.reorgAlarmDepth * 2, CHAINS.DOGE.confirmations)
  assert.equal(CHAINS.LTC.reorgAlarmDepth * 2, CHAINS.LTC.confirmations)

  // ETC takes NEITHER a ratio nor an absolute, and that is the interesting one. A quarter of 7,500
  // — ETH's ratio — is 1,875 blocks, which is over seven hours of a live 51% attack before anybody
  // is paged. The alarm is anchored on the attack history from the shallow end instead: 100 blocks
  // is the depth of the 2019 attack, ~23 minutes, far above ordinary one- and two-block noise and
  // ~27 hours before anything could be wrongly credited.
  assert.equal(CHAINS.ETC.reorgAlarmDepth, 100)
  assert.ok(
    CHAINS.ETC.reorgAlarmDepth * 4 < CHAINS.ETC.confirmations,
    'the ETC alarm has drifted towards its credit depth, which is where it stops being a warning',
  )
})

test('every member of ON_CHAIN_ASSETS is a chain this file actually knows the rules for', () => {
  // The generalisation of the test above, and the reason it can be inverted safely: the pairing of
  // "named in CHAINS" with "listed here" is now asserted for the whole set rather than for one
  // asset. A member added here without a spec, or with a spec that is a placeholder, fails.
  for (const asset of ON_CHAIN_ASSETS) {
    const spec = chainSpec(asset)
    assert.equal(spec.asset, asset)
    assert.ok(spec.name.length > 0, `${asset} has no chain name`)
    assert.ok(spec.confirmations >= 1, `${asset} would be credited before any block confirms it`)
    assert.ok(spec.reorgAlarmDepth >= 1, `${asset} would never alarm on a reorg`)
  }
  // And the retired asset stays out of it: SHARD is in CHAINS so `chainSpec` is total, which is
  // exactly why membership here has to be its own list rather than `Object.keys(CHAINS)`.
  assert.ok(!ON_CHAIN_ASSETS.includes('SHARD'))
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
  // THIS TEST USED TO NAME `DOGE` AS THE UNKNOWN ASSET, AND IT WENT GREEN-FOR-THE-WRONG-REASON THE
  // DAY DOGECOIN WAS ADDED — which is worth a comment, because it is a shape of rot that no
  // failure would have reported. `chainSpec('DOGE')` stopped throwing and started returning the
  // Dogecoin spec, so `assert.throws` was the thing that failed and the fix was visible. Had the
  // assertion been written the other way round it would simply have stopped testing anything.
  //
  // The replacement is a code chosen so that it cannot be adopted: `NOTACHAIN` is not a ticker
  // anybody could plausibly list. Picking a real coin's ticker for "the unknown one" is borrowing
  // against the estate's own roadmap — `docs/ecosystem/29-native-assets.md` §8 has BNB, TRX and
  // USDT-family assets queued, so ETH's neighbours are all candidates and none of them is safe.
  assert.throws(() => chainSpec('NOTACHAIN' as AssetCode), /unknown asset/)
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
  // hash was linked into the mainnet explorer, which cannot know it.
  //
  // AND THE DEFECT THE REPAIR INTRODUCED, WHICH IS WHY THIS ASSERTS THE WHOLE STRING AND NOT
  // `/testnet/`. The first fix pointed at `explorer.testnet.cloudsforge.online` — two labels —
  // which no longer resolves and never could under Cloudflare's one-label wildcard. A regex like
  // `/testnet/` passes on both the working host and the dead one, so it would have watched this
  // line break without noticing. `micro-deploy/cloudflared/config.testnet.public.yml` serves
  // `explorer-testnet.cloudsforge.online`, and that exact string is the assertion.
  assert.equal(
    explorerTxUrl('EMBER', 'testnet', '0xdead'),
    'https://explorer-testnet.cloudsforge.online/#/tx/0xdead',
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
  // EMBER's administered price is 0.25 USD (pricing/src/migrations.ts) = 250000 scaled.
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
