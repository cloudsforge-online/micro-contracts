import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACCOUNT_PURPOSES,
  ENTRY_KINDS,
  type Entitlement,
  type JournalEntry,
  type LedgerAssetCode,
  type Payout,
  type Posting,
  accountKey,
  addMoney,
  applyPosting,
  applyPostings,
  assertBalanced,
  assetDecimals,
  balanceEntry,
  chainSubject,
  chainTokenAssetCode,
  communitySubject,
  compareMoney,
  computeDrift,
  ENGAGEMENT_GRANT_KIND,
  ENGAGEMENT_TREASURY,
  EXCHANGE,
  engagementAccount,
  engagementSubject,
  formatMoney,
  freezesWithdrawals,
  increasesBalance,
  isAccountSubject,
  isChainAsset,
  isEntitlementActive,
  isEntryKind,
  isPayoutConsistent,
  isTokenAsset,
  money,
  moneyForShards,
  movePostings,
  normalBalance,
  organisationSubject,
  parseAccountKey,
  parseChainTokenAsset,
  parseAccountSubject,
  parseMoney,
  payoutNet,
  permitsOverdraft,
  reconciliationStatus,
  releasePostings,
  reservePostings,
  reverseEntry,
  shardsForMoney,
  shardsForUsdCents,
  subscriptionConfersAccess,
  subtractMoney,
  userSubject,
  withinTolerance,
  wouldOverdraw,
} from './index.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function posting(
  accountId: string,
  direction: 'debit' | 'credit',
  amount: bigint,
  assetCode: LedgerAssetCode,
  sequence: number,
): Posting {
  return { accountId, direction, amount, assetCode, sequence }
}

const entry: JournalEntry = {
  id: 'entry-1',
  kind: 'deposit_credited',
  originatingService: 'wallet',
  actor: 'service:indexer',
  correlationId: 'corr-1',
  idempotencyKey: 'deposit:0xabc:0',
  occurredAt: '2026-07-30T09:00:00.000Z',
  recordedAt: '2026-07-30T09:00:03.000Z',
  metadata: { txHash: '0xabc' },
  postings: [
    posting('custody-ember', 'debit', 5_000n, 'EMBER', 0),
    posting('user-ember-available', 'credit', 5_000n, 'EMBER', 1),
  ],
}

/**
 * A 64-bit LCG. Deterministic, seeded, and integer-only — a `Math.random`-based generator would
 * make a property failure unreproducible, which is the one thing a property test must not be.
 */
function makeRng(seed: bigint): (bound: bigint) => bigint {
  const mask = (1n << 64n) - 1n
  let state = seed & mask
  return (bound: bigint): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask
    return (state >> 17n) % bound
  }
}

const GENERATED_ASSETS: readonly LedgerAssetCode[] = [
  'SHARD',
  'EMBER',
  'BTC',
  'USD',
  'TOKEN:cf:mint:token:0192aa',
]

/** A random posting set that balances per asset by construction. */
function generateBalanced(rng: (bound: bigint) => bigint): Posting[] {
  const postings: Posting[] = []
  const chosen = new Set<LedgerAssetCode>()
  const assetCount = Number(rng(3n)) + 1
  let sequence = 0

  for (let a = 0; a < assetCount; a += 1) {
    const assetCode = GENERATED_ASSETS[Number(rng(BigInt(GENERATED_ASSETS.length)))]!
    if (chosen.has(assetCode)) continue
    chosen.add(assetCode)

    const debitCount = Number(rng(3n)) + 1
    const creditCount = Number(rng(3n)) + 1

    let total = 0n
    for (let d = 0; d < debitCount; d += 1) {
      const amount = rng(1_000_000n) + 16n
      total += amount
      postings.push(posting(`dr-${assetCode}-${d}`, 'debit', amount, assetCode, sequence))
      sequence += 1
    }

    // Split the same total across the credit side, every part at least one.
    let remaining = total
    for (let c = 0; c < creditCount; c += 1) {
      const isLast = c === creditCount - 1
      const partsAfter = BigInt(creditCount - 1 - c)
      const amount = isLast ? remaining : rng(remaining - partsAfter) + 1n
      remaining -= amount
      postings.push(posting(`cr-${assetCode}-${c}`, 'credit', amount, assetCode, sequence))
      sequence += 1
    }
  }
  return postings
}

// ---------------------------------------------------------------------------
// subjects
// ---------------------------------------------------------------------------

test('typed subject constructors round-trip through the parser', () => {
  assert.deepEqual(parseAccountSubject(userSubject('0192aa')), { kind: 'user', id: '0192aa' })
  assert.deepEqual(parseAccountSubject(communitySubject('c1')), { kind: 'community', id: 'c1' })
  assert.deepEqual(parseAccountSubject(organisationSubject('o1')), {
    kind: 'organisation',
    id: 'o1',
  })
  assert.deepEqual(parseAccountSubject('platform'), { kind: 'platform' })
  assert.deepEqual(parseAccountSubject('custody'), { kind: 'custody' })
  assert.deepEqual(parseAccountSubject('clearing'), { kind: 'clearing' })
})

test('an id containing the subject separator is refused — it could forge another subject', () => {
  assert.throws(() => userSubject('a:b'), RangeError)
  assert.throws(() => userSubject(''), RangeError)
  assert.throws(() => communitySubject('a|b'), RangeError)
})

test('rubbish is not a subject', () => {
  assert.equal(isAccountSubject('user:1'), true)
  assert.equal(isAccountSubject('admin:1'), false)
  assert.equal(isAccountSubject('platform'), true)
  assert.equal(isAccountSubject('user:'), false)
})

// The engagement-treasury grammar — docs/ecosystem/21 §4, spelled exactly as the document's tree
// spells it. These are the account names every engagement Shard moves through, so the spellings
// are pinned here the way topic names are pinned in contracts-events: a rename is a coordinated
// release, never a typo.
test('the engagement treasury and per-service engagement accounts parse — 21 §4', () => {
  assert.equal(ENGAGEMENT_TREASURY, 'platform:engagement-treasury')
  assert.deepEqual(parseAccountSubject('platform:engagement-treasury'), {
    kind: 'engagement-treasury',
  })
  assert.deepEqual(parseAccountSubject(engagementSubject('foresight')), {
    kind: 'engagement',
    service: 'foresight',
  })
  // The doc's six services, every one of them expressible.
  for (const service of ['foresight', 'market', 'worlds', 'aetherholm', 'emberkin', 'trade']) {
    assert.equal(isAccountSubject(`engagement:${service}`), true)
  }
})

test('an engagement service name obeys the id rule — no separator, no key delimiter, no blank', () => {
  assert.throws(() => engagementSubject(''), RangeError)
  assert.throws(() => engagementSubject('a:b'), RangeError)
  assert.throws(() => engagementSubject('a|b'), RangeError)
  assert.equal(isAccountSubject('engagement:'), false)
  // And the treasury spelling is EXACT: 'platform:<anything else>' stays refused, so the
  // singleton cannot be approximated into a family of platform-prefixed subjects.
  assert.equal(isAccountSubject('platform:treasury'), false)
  assert.equal(isAccountSubject('platform:engagement'), false)
})

// The grant primitive — 21 §4/§5. These are the spellings three services must agree on, so they
// are pinned here rather than trusted to three code reviews.
test('an engagement grant debits the service treasury, spelled once for every service', () => {
  // Every call here names its asset, because the parameter no longer has a default. It used to
  // default to 'SHARD', which meant these cases asserted the spelling of an account nobody in the
  // test had chosen the denomination of — and 'SHARD' is retired. The values are unchanged: these
  // are the accounts market and worlds really post against today, so the assertions still pin the
  // live spelling rather than a tidier one.
  assert.deepEqual(engagementAccount('market', 'SHARD'), {
    subject: 'engagement:market',
    assetCode: 'SHARD',
    purpose: 'treasury',
    type: 'equity',
  })
  // `equity` is load-bearing: the ledger's overdraft trigger exempts `clearing` and `suspense`,
  // NOT `equity` — so an engagement account cannot be spent before it is funded.
  assert.equal(engagementAccount('worlds', 'SHARD').type, 'equity')
  assert.equal(engagementAccount('worlds', 'SHARD').purpose, 'treasury')
  // The account key is (subject, assetCode, purpose), so a second spelling would be a second
  // account and would split one programme's ledger in half.
  assert.equal(
    accountKey(engagementAccount('market', 'SHARD')),
    accountKey({ subject: 'engagement:market', assetCode: 'SHARD', purpose: 'treasury' }),
  )
  // The asset does not change the subject, and a service granting in a live asset gets the same
  // account grammar — micro-tessera passes 'EMBER' here today.
  assert.equal(engagementAccount('tessera', 'EMBER').subject, 'engagement:tessera')
  assert.throws(() => engagementAccount('a:b', 'SHARD'), RangeError)
})

test('the grant kind is one the LEDGER will actually accept', () => {
  // The kind vocabulary is a CHECK constraint in micro-ledger's schema. foresight shipped
  // `foresight.settlement_fee`, which was not in it, and posted nothing for months — so this
  // asserts membership rather than merely spelling.
  assert.equal(ENGAGEMENT_GRANT_KIND, 'treasury_spend')
  assert.ok(isEntryKind(ENGAGEMENT_GRANT_KIND), 'the grant kind must be in the closed vocabulary')
  assert.ok(ENTRY_KINDS.includes(ENGAGEMENT_GRANT_KIND))
})

test('a chain clearing subject parses — the spelling foresight fee reports already use', () => {
  assert.deepEqual(parseAccountSubject(chainSubject('ember')), { kind: 'chain', id: 'ember' })
  assert.equal(isAccountSubject('chain:ember'), true)
  assert.throws(() => chainSubject('a:b'), RangeError)
  assert.equal(isAccountSubject('chain:'), false)
})

// micro-org#372. The literal is asserted, not just the constant: micro-trade wrote `'exchange'`
// by hand in `transferPostings` and the wire type for a subject is `string`, so nothing in the
// compiler stood between that spelling and a RangeError at the ledger's `ensureAccount`. What has
// to hold is that the STRING parses — a test that only exercised `EXCHANGE` would still pass if
// the constant were renamed to something trade does not write.
test('the exchange omnibus escrow parses — the spelling micro-trade already writes', () => {
  assert.equal(EXCHANGE, 'exchange')
  assert.deepEqual(parseAccountSubject('exchange'), { kind: 'exchange' })
  assert.equal(isAccountSubject('exchange'), true)
  // A singleton, so a prefixed form is not another exchange — it is nothing.
  assert.equal(isAccountSubject('exchange:trade'), false)
  assert.throws(() => parseAccountSubject('exchange:trade'), RangeError)
})

// ---------------------------------------------------------------------------
// the chart of accounts
// ---------------------------------------------------------------------------

test('the account key is (subject, assetCode, purpose) and nothing else', () => {
  const subject = userSubject('u1')
  const available = accountKey({ subject, assetCode: 'SHARD', purpose: 'available' })
  const reserved = accountKey({ subject, assetCode: 'SHARD', purpose: 'reserved' })
  const otherAsset = accountKey({ subject, assetCode: 'EMBER', purpose: 'available' })
  const otherUser = accountKey({ subject: userSubject('u2'), assetCode: 'SHARD', purpose: 'available' })

  assert.equal(available, accountKey({ subject, assetCode: 'SHARD', purpose: 'available' }))
  assert.equal(new Set([available, reserved, otherAsset, otherUser]).size, 4)
})

test('the key round-trips even for a token asset whose urn is full of colons', () => {
  const identity = {
    subject: communitySubject('c1'),
    assetCode: 'TOKEN:cf:mint:token:0192aa' as LedgerAssetCode,
    purpose: 'treasury' as const,
  }
  assert.deepEqual(parseAccountKey(accountKey(identity)), identity)
})

test('a key with a bad purpose or subject does not parse', () => {
  assert.throws(() => parseAccountKey('user:1|SHARD|wallet'), RangeError)
  assert.throws(() => parseAccountKey('admin:1|SHARD|available'), RangeError)
  assert.throws(() => parseAccountKey('user:1|SHARD'), RangeError)
})

test('an asset code containing the key delimiter is refused', () => {
  assert.throws(
    () =>
      accountKey({
        subject: 'platform',
        assetCode: 'TOKEN:a|b' as LedgerAssetCode,
        purpose: 'available',
      }),
    RangeError,
  )
})

test('a user liability may not go negative; suspense may', () => {
  const userAvailable = { type: 'liability' as const, purpose: 'available' as const }
  assert.equal(wouldOverdraw(userAvailable, -1n), true, 'we cannot owe a user less than nothing')
  assert.equal(wouldOverdraw(userAvailable, 0n), false)
  assert.equal(wouldOverdraw({ type: 'liability', purpose: 'suspense' }, -1n), false)
  assert.equal(wouldOverdraw({ type: 'clearing', purpose: 'available' }, -1n), false)
  assert.equal(
    wouldOverdraw({ type: 'liability', purpose: 'available', overdraftAllowed: true }, -1n),
    false,
  )
  assert.equal(permitsOverdraft({ purpose: 'available' }), false)
})

// ---------------------------------------------------------------------------
// entry kinds
// ---------------------------------------------------------------------------

test('the entry kinds are the closed set from the domain model, in order', () => {
  assert.deepEqual(
    [...ENTRY_KINDS],
    [
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
      'item_issue',
      'liquidity_seed',
    ],
  )
  assert.equal(isEntryKind('deposit_credited'), true)
  assert.equal(isEntryKind('topup'), false)
  assert.equal(ACCOUNT_PURPOSES.length, 8)
})

test('inventory is a purpose, because the exchange desk sells out of a stock it can exhaust', () => {
  // micro-org#495 §1. `micro-wallet`'s `convert()` posted both counter-legs to `clearing`, and
  // `ledger_assert_no_overdraft` returns early for `type = 'clearing'` BEFORE it reads
  // `overdraft_allowed` — so a user converting into EMBER received EMBER the platform never had,
  // and the counter-account simply went further negative with nothing anywhere refusing.
  //
  // The desk is `exchange`/`inventory`/`equity`. `equity` falls through to the overdraft check, so
  // the refusal is Postgres's, inside the entry's transaction, serialised on the balance row —
  // which is what makes it hold against two conversions racing for the last of a coin. The
  // TypeScript pre-check in `micro-wallet` exists so the ordinary case gets a named 409 rather
  // than a constraint violation; it is not what makes the invariant true.
  assert.equal(ACCOUNT_PURPOSES.includes('inventory'), true)
  // Appended, like every entry kind above, because each tuple index is a published path to the
  // additive-evolution check.
  assert.equal(ACCOUNT_PURPOSES.at(-1), 'inventory')
  // It is not overdraft-exempt, and that is the entire point of choosing it over `clearing`.
  assert.equal(permitsOverdraft({ purpose: 'inventory' }), false)
  assert.equal(wouldOverdraw({ type: 'equity', purpose: 'inventory' }, -1n), true)
  assert.equal(wouldOverdraw({ type: 'equity', purpose: 'inventory' }, 0n), false)
})

test('item_issue is in the set, because micro-tessera posts it on every object activation', () => {
  // Added by the same change as micro-ledger's migration 16. It was written into
  // `tessera/src/ledgerclient.ts` before it existed anywhere else, so every issuance micro-tessera
  // attempted was answered `400 invalid_entry` and no object was ever brought into the ledger.
  // The two halves must land together: this constant is what micro-ledger validates against, and
  // the CHECK constraint is what the database enforces. micro-ledger's `migrations.test.ts`
  // asserts the two lists are equal, so a change to one alone turns that test red.
  assert.equal(isEntryKind('item_issue'), true)
  // It sits AFTER `reversal`, not next to `reward_granted` where it reads best. Each tuple index
  // is a published path to the additive-evolution check, so an insertion renames every kind after
  // it and is reported as twelve breaking changes. New kinds are appended.
  assert.equal(ENTRY_KINDS.indexOf('item_issue'), 20)
})

test('liquidity_seed is in the set, because seeding an AMM pool is neither a spend nor a transfer', () => {
  // Forge Exchange phase F (docs/ecosystem/39 §6) puts EMBER the estate mined into a Hearth V2
  // pair. The gate on that phase is that the estate's own solvency reporting books it, and no
  // existing kind says what happened. It is not a `treasury_spend` — nothing left the estate, and
  // the position is recoverable in full by burning the LP tokens the estate holds. It is not a
  // `transfer` — a transfer moves value between two subjects who each still hold it afterwards,
  // whereas here the counter-asset is minted and the pair's reserves move on every stranger's
  // swap. It is not a `conversion` — no asset was exchanged for another at a rate.
  //
  // What it is: the project's own EMBER moving from unbooked mining income into a position it
  // still owns but no longer controls the price of. So it posts DEBIT platform/EMBER/reserved
  // (asset) against CREDIT platform/EMBER/treasury (equity), and deliberately NOT against
  // anything with subject 'custody' — `ledger/src/reconcile.ts` sums exactly that subject against
  // the indexer's watched addresses, EMBER's drift tolerance is zero, and an AMM reserve that
  // moves whenever a stranger trades would freeze every EMBER withdrawal in the estate the first
  // time someone swapped. docs/ecosystem/35 calls that failure "an invented insolvency".
  assert.equal(isEntryKind('liquidity_seed'), true)
  assert.equal(ENTRY_KINDS.at(-1), 'liquidity_seed')
})

// ---------------------------------------------------------------------------
// the balancing invariant — the most important tests in the repository
// ---------------------------------------------------------------------------

test('a two-sided entry balances and reports what moved', () => {
  const result = balanceEntry(entry.postings)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.totals.get('EMBER'), 5_000n)
  assert.equal(result.totals.size, 1)
})

test('an entry with no postings is not an entry', () => {
  const result = balanceEntry([])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.problems, [{ code: 'empty_entry' }])
})

test('a single-sided posting set is rejected — this is the shape of the table being replaced', () => {
  const result = balanceEntry([posting('user-shards', 'credit', 100n, 'SHARD', 0)])
  assert.equal(result.ok, false, 'a delta with no counter-account must not be postable')
  if (result.ok) return
  assert.deepEqual(result.problems, [
    { code: 'single_sided', assetCode: 'SHARD', direction: 'credit', amount: 100n },
  ])
})

test('an unbalanced entry names the asset and the difference', () => {
  const result = balanceEntry([
    posting('custody', 'debit', 5_000n, 'EMBER', 0),
    posting('user', 'credit', 4_999n, 'EMBER', 1),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.problems, [
    { code: 'unbalanced', assetCode: 'EMBER', debits: 5_000n, credits: 4_999n, difference: 1n },
  ])
})

test('a zero amount is not a posting', () => {
  const result = balanceEntry([
    posting('a', 'debit', 0n, 'SHARD', 0),
    posting('b', 'credit', 0n, 'SHARD', 1),
  ])
  assert.equal(result.ok, false, 'zero-for-zero must not be allowed to balance')
  if (result.ok) return
  assert.equal(result.problems.length, 2)
  assert.equal(result.problems[0]?.code, 'non_positive_amount')
})

test('mixed signs are diagnosed as a ported delta column, not as a generic bad amount', () => {
  const result = balanceEntry([
    posting('a', 'debit', -100n, 'SHARD', 0),
    posting('b', 'credit', 100n, 'SHARD', 1),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.problems.some((p) => p.code === 'mixed_sign'))
  assert.ok(result.problems.some((p) => p.code === 'non_positive_amount'))
})

test('a duplicated sequence is rejected — a posting needs a stable identity', () => {
  const result = balanceEntry([
    posting('a', 'debit', 10n, 'SHARD', 0),
    posting('b', 'credit', 10n, 'SHARD', 0),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.problems, [{ code: 'duplicate_sequence', sequence: 0 }])
})

test('a non-integer sequence is rejected', () => {
  const result = balanceEntry([
    posting('a', 'debit', 10n, 'SHARD', Number.NaN),
    posting('b', 'credit', 10n, 'SHARD', 1),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problems[0]?.code, 'invalid_sequence')
})

test('a multi-asset entry must balance each asset independently', () => {
  // A conversion: EMBER out, Shards in. The two totals have no arithmetic relationship, and
  // summing across them would make this nonsense entry balance.
  const conversion = [
    posting('user-ember', 'debit', 1_000n, 'EMBER', 0),
    posting('custody-ember', 'credit', 1_000n, 'EMBER', 1),
    posting('platform-shards', 'debit', 42n, 'SHARD', 2),
    posting('user-shards', 'credit', 42n, 'SHARD', 3),
  ]
  const result = balanceEntry(conversion)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.totals.get('EMBER'), 1_000n)
  assert.equal(result.totals.get('SHARD'), 42n)
})

test('one asset out in a multi-asset entry fails, and only that asset is reported', () => {
  const result = balanceEntry([
    posting('user-ember', 'debit', 1_000n, 'EMBER', 0),
    posting('custody-ember', 'credit', 999n, 'EMBER', 1),
    posting('platform-shards', 'debit', 42n, 'SHARD', 2),
    posting('user-shards', 'credit', 42n, 'SHARD', 3),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problems.length, 1)
  assert.equal(result.problems[0]?.code, 'unbalanced')
  assert.equal(
    result.problems[0]?.code === 'unbalanced' ? result.problems[0].assetCode : null,
    'EMBER',
  )
})

test('an asset that appears on one side only fails even when another asset balances', () => {
  const result = balanceEntry([
    posting('user-ember', 'debit', 1_000n, 'EMBER', 0),
    posting('custody-ember', 'credit', 1_000n, 'EMBER', 1),
    posting('user-shards', 'credit', 42n, 'SHARD', 2),
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.problems, [
    { code: 'single_sided', assetCode: 'SHARD', direction: 'credit', amount: 42n },
  ])
})

test('property: a generated balanced entry always balances, for any shape', () => {
  const rng = makeRng(0x5eed_1234_abcd_0001n)
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const postings = generateBalanced(rng)
    const result = balanceEntry(postings)
    assert.equal(result.ok, true, `iteration ${iteration}: ${JSON.stringify(postings, replacer)}`)
    if (!result.ok) return
    for (const [assetCode, total] of result.totals) {
      const debits = postings
        .filter((p) => p.assetCode === assetCode && p.direction === 'debit')
        .reduce((sum, p) => sum + p.amount, 0n)
      assert.equal(total, debits)
    }
  }
})

test('property: perturbing any single amount by one always breaks the entry', () => {
  const rng = makeRng(0x5eed_1234_abcd_0002n)
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const postings = generateBalanced(rng)
    const index = Number(rng(BigInt(postings.length)))
    const target = postings[index]!
    const delta = rng(2n) === 0n || target.amount === 1n ? 1n : -1n
    const perturbed = postings.map((p, i) =>
      i === index ? { ...p, amount: p.amount + delta } : p,
    )

    const result = balanceEntry(perturbed)
    assert.equal(
      result.ok,
      false,
      `iteration ${iteration}: a one-unit error must never pass — ${JSON.stringify(perturbed, replacer)}`,
    )
    if (result.ok) return
    assert.ok(
      result.problems.some(
        (p) => p.code === 'unbalanced' && p.assetCode === target.assetCode && (p.difference === delta || p.difference === -delta),
      ),
      `iteration ${iteration}: the out-of-balance asset must be named`,
    )
  }
})

test('assertBalanced throws a description a human can act on', () => {
  assert.throws(
    () => assertBalanced([posting('a', 'credit', 100n, 'SHARD', 0)]),
    /SHARD has only credit postings totalling 100/,
  )
})

// ---------------------------------------------------------------------------
// the sign convention
// ---------------------------------------------------------------------------

test('a credit increases a liability — we owe the user more', () => {
  assert.equal(normalBalance('liability'), 'credit')
  const credit = posting('user-shards', 'credit', 100n, 'SHARD', 0)
  assert.equal(applyPosting(0n, credit, 'liability'), 100n)
  const debit = posting('user-shards', 'debit', 40n, 'SHARD', 1)
  assert.equal(applyPosting(100n, debit, 'liability'), 60n)
})

test('a debit increases an asset — coin arriving in custody', () => {
  assert.equal(normalBalance('asset'), 'debit')
  const debit = posting('custody-btc', 'debit', 100n, 'BTC', 0)
  assert.equal(applyPosting(0n, debit, 'asset'), 100n)
  const credit = posting('custody-btc', 'credit', 30n, 'BTC', 1)
  assert.equal(applyPosting(100n, credit, 'asset'), 70n)
})

test('revenue and equity are credit-normal, expense is debit-normal', () => {
  assert.equal(normalBalance('revenue'), 'credit')
  assert.equal(normalBalance('equity'), 'credit')
  assert.equal(normalBalance('clearing'), 'credit')
  assert.equal(normalBalance('expense'), 'debit')
  assert.equal(increasesBalance('debit', 'expense'), true)
  assert.equal(increasesBalance('credit', 'expense'), false)
})

test('a deposit increases both sides at once — the point of the convention', () => {
  const [custodyPosting, userPosting] = [entry.postings[0]!, entry.postings[1]!]
  assert.equal(applyPosting(0n, custodyPosting, 'asset'), 5_000n, 'custody holds more coin')
  assert.equal(applyPosting(0n, userPosting, 'liability'), 5_000n, 'we owe the user more')
})

test('applyPosting refuses a non-positive amount rather than quietly subtracting', () => {
  assert.throws(() => applyPosting(0n, posting('a', 'credit', 0n, 'SHARD', 0), 'liability'), RangeError)
  assert.throws(() => applyPosting(0n, posting('a', 'credit', -5n, 'SHARD', 0), 'liability'), RangeError)
})

test('replaying postings rebuilds a balance — the projection is derived, never authoritative', () => {
  const history = [
    posting('user-shards', 'credit', 1_000n, 'SHARD', 0),
    posting('user-shards', 'debit', 250n, 'SHARD', 1),
    posting('user-shards', 'credit', 75n, 'SHARD', 2),
  ]
  assert.equal(applyPostings(0n, history, 'liability'), 825n)
})

// ---------------------------------------------------------------------------
// reversal
// ---------------------------------------------------------------------------

test('a reversal mirrors every posting and still balances', () => {
  const reversal = reverseEntry(entry, {
    id: 'entry-2',
    idempotencyKey: 'reversal:entry-1',
    recordedAt: '2026-07-30T10:00:00.000Z',
  })
  assert.equal(reversal.kind, 'reversal')
  assert.equal(reversal.reversesEntryId, 'entry-1')
  assert.equal(reversal.postings[0]?.direction, 'credit')
  assert.equal(reversal.postings[1]?.direction, 'debit')
  assert.equal(reversal.postings[0]?.amount, 5_000n, 'amounts stay positive; only direction flips')
  assert.equal(balanceEntry(reversal.postings).ok, true)
})

test('reversing a reversal returns to the original postings', () => {
  const first = reverseEntry(entry, {
    id: 'entry-2',
    idempotencyKey: 'reversal:entry-1',
    recordedAt: '2026-07-30T10:00:00.000Z',
  })
  const second = reverseEntry(first, {
    id: 'entry-3',
    idempotencyKey: 'reversal:entry-2',
    recordedAt: '2026-07-30T11:00:00.000Z',
  })
  assert.notDeepEqual(first.postings, entry.postings, 'the first reversal must actually mirror')
  assert.deepEqual(second.postings, entry.postings, 'an operator mis-click must be recoverable')
  assert.equal(second.reversesEntryId, 'entry-2')
})

test('a reversal must carry its own idempotency key and id, or it is swallowed as a replay', () => {
  assert.throws(
    () =>
      reverseEntry(entry, {
        id: 'entry-2',
        idempotencyKey: entry.idempotencyKey,
        recordedAt: '2026-07-30T10:00:00.000Z',
      }),
    RangeError,
  )
  assert.throws(
    () =>
      reverseEntry(entry, {
        id: entry.id,
        idempotencyKey: 'other',
        recordedAt: '2026-07-30T10:00:00.000Z',
      }),
    RangeError,
  )
})

test('a reversal is not back-dated into the period it corrects', () => {
  const reversal = reverseEntry(entry, {
    id: 'entry-2',
    idempotencyKey: 'reversal:entry-1',
    recordedAt: '2026-08-01T00:00:00.000Z',
  })
  assert.equal(reversal.occurredAt, '2026-08-01T00:00:00.000Z')
  assert.notEqual(reversal.occurredAt, entry.occurredAt)
})

test("a reversal does not inherit the original's metadata", () => {
  const reversal = reverseEntry(entry, {
    id: 'entry-2',
    idempotencyKey: 'reversal:entry-1',
    recordedAt: '2026-07-30T10:00:00.000Z',
  })
  assert.equal(reversal.metadata, undefined, 'copying the external reference makes it look like a duplicate')
  assert.equal(reversal.originatingService, 'wallet')
  assert.equal(reversal.correlationId, 'corr-1')
})

// ---------------------------------------------------------------------------
// reservations
// ---------------------------------------------------------------------------

test('reserving is a balanced posting pair, not a column update', () => {
  const pair = reservePostings({
    availableAccountId: 'u1-shard-available',
    reservedAccountId: 'u1-shard-reserved',
    assetCode: 'SHARD',
    amount: 500n,
  })
  assert.equal(pair[0].direction, 'debit')
  assert.equal(pair[0].accountId, 'u1-shard-available')
  assert.equal(pair[1].direction, 'credit')
  assert.equal(pair[1].accountId, 'u1-shard-reserved')
  assert.equal(balanceEntry([...pair]).ok, true)
})

test('reserve then release nets to zero on both accounts — nothing is lost', () => {
  const move = {
    availableAccountId: 'u1-shard-available',
    reservedAccountId: 'u1-shard-reserved',
    assetCode: 'SHARD' as LedgerAssetCode,
    amount: 500n,
  }
  const all = [...reservePostings(move), ...releasePostings({ ...move, startSequence: 2 })]
  const available = all.filter((p) => p.accountId === move.availableAccountId)
  const reserved = all.filter((p) => p.accountId === move.reservedAccountId)

  assert.equal(applyPostings(1_000n, available, 'liability'), 1_000n)
  assert.equal(applyPostings(0n, reserved, 'liability'), 0n)
  assert.equal(balanceEntry(all).ok, true)
})

test('reserving reduces available and increases reserved by the same amount', () => {
  const pair = reservePostings({
    availableAccountId: 'a',
    reservedAccountId: 'r',
    assetCode: 'SHARD',
    amount: 500n,
  })
  assert.equal(applyPosting(1_000n, pair[0], 'liability'), 500n)
  assert.equal(applyPosting(0n, pair[1], 'liability'), 500n)
})

test('a reservation of nothing, or against itself, is refused', () => {
  assert.throws(
    () =>
      reservePostings({
        availableAccountId: 'a',
        reservedAccountId: 'r',
        assetCode: 'SHARD',
        amount: 0n,
      }),
    RangeError,
  )
  assert.throws(
    () => movePostings('a', 'a', { assetCode: 'SHARD', amount: 5n }),
    RangeError,
  )
})

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

test('money arithmetic refuses to mix assets', () => {
  const shards = money(100n, 'SHARD')
  assert.equal(addMoney(shards, money(50n, 'SHARD')).amount, 150n)
  assert.equal(subtractMoney(shards, money(50n, 'SHARD')).amount, 50n)
  assert.equal(compareMoney(shards, money(150n, 'SHARD')), -1)
  assert.throws(() => addMoney(shards, money(50n, 'EMBER')), RangeError)
  assert.throws(() => compareMoney(shards, money(50n, 'USD')), RangeError)
})

test('decimals come from contracts-chain, USD is cents, and a token must declare its own', () => {
  assert.equal(assetDecimals('EMBER'), 18)
  assert.equal(assetDecimals('BTC'), 8)
  assert.equal(assetDecimals('SHARD'), 0)
  assert.equal(assetDecimals('USD'), 2)
  assert.throws(() => assetDecimals('TOKEN:cf:mint:token:1'), RangeError)
  assert.equal(assetDecimals('TOKEN:cf:mint:token:1', 6), 6)
})

// ---------------------------------------------------------------------------
// chain token asset codes — the deployment is the identity, never the brand
// ---------------------------------------------------------------------------

// The real Tether and Circle deployments on Ethereum mainnet. Written out because the whole point
// of the rule is that these two are DIFFERENT assets that a brand code would have merged, and a
// test using `0xaa…` twice would not demonstrate that.
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

test('a chain token asset is named by its deployment, and a brand name is refused', () => {
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  assert.equal(usdt, `TOKEN:eth:mainnet:${USDT_ETH}`)

  // THE RULE. `settlement/src/sweeps.ts` — "NOTHING HERE MAY EVER WRITE `USDT`." A brand name
  // has no chain, no network and no contract, so it cannot pass the shape at all.
  for (const brand of ['USDT', 'USDC', 'usdt', 'Tether']) {
    assert.throws(() => chainTokenAssetCode({ chain: brand, network: 'mainnet', contract: '' }), RangeError)
  }
  assert.throws(() => chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: 'USDT' }), RangeError)
})

test('one brand at two deployments is two ledger assets, permanently', () => {
  // Same brand, same decimals, same chain — different contracts. If these ever compared equal, the
  // ledger would hold Tether and Circle balances in one account and reconcile neither.
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  const usdc = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDC_ETH })
  assert.notEqual(usdt, usdc)

  // Same brand, same contract, different NETWORK. A testnet deposit is not mainnet money.
  const testnet = chainTokenAssetCode({ chain: 'eth', network: 'testnet', contract: USDT_ETH })
  assert.notEqual(usdt, testnet)
})

test('a checksummed address and a lower-cased one are one asset, not two', () => {
  const checksummed = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  assert.equal(
    chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: checksummed }),
    chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH }),
  )
})

test('decimals are not in the code, so the six-decimal case must still be declared', () => {
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  // The defect this guards: guessing 18 for a six-decimal stablecoin is a balance wrong by 10^12.
  assert.throws(() => assetDecimals(usdt), RangeError)
  assert.equal(assetDecimals(usdt, 6), 6)
  assert.equal(parseMoney('1.5', usdt, 6).amount, 1_500_000n)
})

test('parseChainTokenAsset answers only for a deployment, and null for anything else', () => {
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  assert.deepEqual(parseChainTokenAsset(usdt), {
    chain: 'eth',
    network: 'mainnet',
    contract: USDT_ETH,
  })

  // A tessera fired object is a `TOKEN:` asset too, and is not a chain deployment. Null, not throw:
  // asking "is this a chain token" is a legitimate question with a legitimate negative answer.
  assert.equal(parseChainTokenAsset('TOKEN:cf:tessera:object:abc'), null)
  assert.equal(parseChainTokenAsset('USDT' as LedgerAssetCode), null)
  assert.equal(parseChainTokenAsset('EMBER'), null)
  // A network the estate does not run. The shape matches; the network does not.
  assert.equal(parseChainTokenAsset(`TOKEN:eth:devnet:${USDT_ETH}` as LedgerAssetCode), null)
})

test('the code round-trips through the parser without changing', () => {
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  const parsed = parseChainTokenAsset(usdt)
  assert.ok(parsed)
  assert.equal(chainTokenAssetCode(parsed), usdt)
})

test('a chain token asset code is still a token asset to every existing consumer', () => {
  const usdt = chainTokenAssetCode({ chain: 'eth', network: 'mainnet', contract: USDT_ETH })
  assert.equal(isTokenAsset(usdt), true)
  assert.equal(isChainAsset(usdt), false)
})

test('formatting and parsing round-trip without ever becoming a float', () => {
  assert.equal(parseMoney('1.5', 'EMBER').amount, 1_500_000_000_000_000_000n)
  assert.equal(formatMoney(money(1_500_000_000_000_000_000n, 'EMBER')), '1.5')
  assert.equal(parseMoney('12.34', 'USD').amount, 1_234n)
  assert.equal(formatMoney(money(1_234n, 'USD')), '12.34')
  assert.equal(parseMoney('1.5', 'TOKEN:cf:mint:token:1', 6).amount, 1_500_000n)
  assert.throws(() => parseMoney('0.001', 'USD'), RangeError)
})

test('conversion delegates to contracts-chain rather than rounding a second time', () => {
  const oneEth = money(10n ** 18n, 'ETH')
  const usdPerEthScaled = 2_000_000_000n // 2000.00 USD at RATE_SCALE
  assert.deepEqual(shardsForMoney(oneEth, usdPerEthScaled), { amount: 200_000n, assetCode: 'SHARD' })
  assert.deepEqual(moneyForShards(200_000n, 'ETH', usdPerEthScaled), {
    amount: 10n ** 18n,
    assetCode: 'ETH',
  })
  assert.throws(() => shardsForMoney(money(1n, 'SHARD'), usdPerEthScaled), RangeError)
  assert.throws(() => shardsForMoney(money(1n, 'USD'), usdPerEthScaled), RangeError)
})

test('shards for USD cents floors rather than minting an unbacked Shard', () => {
  assert.equal(shardsForUsdCents(1_234n), 1_234n)
  assert.equal(shardsForUsdCents(1n), 1n)
  assert.equal(shardsForUsdCents(0n), 0n)
  assert.throws(() => shardsForUsdCents(-1n), RangeError)
})

test('there is not a floating-point number anywhere in the module', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const banned of ['parseFloat', 'toFixed', 'Math.round', 'Math.floor', 'Math.ceil', 'Number(']) {
    assert.equal(code.includes(banned), false, `${banned} has no business in a money package`)
  }
  const decimalLiteral = code.match(/(?<![\w.])\d+\.\d+/)
  assert.equal(decimalLiteral, null, `found a decimal literal: ${decimalLiteral?.[0]}`)
})

test('every amount a constructor produces is a bigint', () => {
  const values: unknown[] = [
    ...reservePostings({
      availableAccountId: 'a',
      reservedAccountId: 'r',
      assetCode: 'SHARD',
      amount: 5n,
    }).map((p) => p.amount),
    money(1n, 'SHARD').amount,
    parseMoney('1.5', 'EMBER').amount,
    shardsForMoney(money(10n ** 18n, 'ETH'), 2_000_000_000n).amount,
    shardsForUsdCents(100n),
    applyPosting(0n, posting('a', 'credit', 1n, 'SHARD', 0), 'liability'),
    computeDrift(2n, 1n),
    payoutNet(10n, 1n),
  ]
  for (const value of values) assert.equal(typeof value, 'bigint')
})

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

test('drift is ledger minus chain, and the sign is the diagnosis', () => {
  assert.equal(computeDrift(1_000n, 900n), 100n, 'the ledger claims coin the chain does not show')
  assert.equal(computeDrift(900n, 1_000n), -100n, 'the chain holds coin the ledger has not credited')
  assert.equal(computeDrift(1_000n, 1_000n), 0n)
})

test('tolerance is per asset and both directions are bounded', () => {
  const tolerance = { EMBER: 1_000n, BTC: 0n }
  assert.equal(withinTolerance({ assetCode: 'EMBER', drift: 1_000n }, tolerance), true)
  assert.equal(withinTolerance({ assetCode: 'EMBER', drift: -1_000n }, tolerance), true)
  assert.equal(withinTolerance({ assetCode: 'EMBER', drift: 1_001n }, tolerance), false)
  assert.equal(
    withinTolerance({ assetCode: 'EMBER', drift: -1_001n }, tolerance),
    false,
    'coin the ledger has not credited is a smaller problem, not an unbounded one',
  )
  assert.equal(withinTolerance({ assetCode: 'BTC', drift: 1n }, tolerance), false)
  assert.equal(withinTolerance({ assetCode: 'BTC', drift: -1n }, tolerance), false)
})

test('an asset with no configured tolerance gets zero, not infinity', () => {
  assert.equal(
    withinTolerance({ assetCode: 'SOL', drift: 1n }, { EMBER: 1_000n }),
    false,
    'a missing config must not silently exempt an asset from the only check that guards it',
  )
  assert.equal(withinTolerance({ assetCode: 'SOL', drift: 0n }, {}), true)
  assert.throws(() => withinTolerance({ assetCode: 'SOL', drift: 0n }, { SOL: -1n }), RangeError)
})

test('exceeding tolerance freezes withdrawals for that asset', () => {
  const tolerance = { EMBER: 10n }
  assert.equal(reconciliationStatus({ assetCode: 'EMBER', drift: 0n }, tolerance), 'clean')
  assert.equal(
    reconciliationStatus({ assetCode: 'EMBER', drift: 5n }, tolerance),
    'drift_within_tolerance',
  )
  assert.equal(
    reconciliationStatus({ assetCode: 'EMBER', drift: 11n }, tolerance),
    'drift_exceeded',
  )
  assert.equal(
    reconciliationStatus({ assetCode: 'EMBER', drift: -11n }, tolerance),
    'drift_exceeded',
  )
  assert.equal(freezesWithdrawals('drift_exceeded'), true)
  assert.equal(freezesWithdrawals('failed'), true)
  assert.equal(freezesWithdrawals('drift_within_tolerance'), false)
  assert.equal(freezesWithdrawals('clean'), false)
})

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

const seasonPass: Entitlement = {
  id: 'ent-1',
  subject: userSubject('u1'),
  productId: 'prod-1',
  sku: 'season-pass',
  scope: 'title:crucible',
  source: 'purchase',
  grantedAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
  quantity: 1n,
}

test('an entitlement expires — the reason a season pass can end', () => {
  assert.equal(isEntitlementActive(seasonPass, '2026-08-01T00:00:00.000Z'), true)
  assert.equal(isEntitlementActive(seasonPass, '2026-10-01T00:00:00.000Z'), false)
  assert.equal(isEntitlementActive(seasonPass, '2026-06-01T00:00:00.000Z'), false)
})

test('revocation removes what the payment bought, from the moment of the refund', () => {
  const refunded: Entitlement = { ...seasonPass, revokedAt: '2026-08-01T00:00:00.000Z' }
  assert.equal(isEntitlementActive(refunded, '2026-07-15T00:00:00.000Z'), true)
  assert.equal(isEntitlementActive(refunded, '2026-08-01T00:00:00.000Z'), false)
  assert.equal(isEntitlementActive(refunded, '2026-09-01T00:00:00.000Z'), false)
})

test('a zero-quantity entitlement confers nothing, and a bad instant is an error', () => {
  assert.equal(isEntitlementActive({ ...seasonPass, quantity: 0n }, '2026-08-01T00:00:00.000Z'), false)
  assert.throws(() => isEntitlementActive(seasonPass, 'yesterday'), RangeError)
})

test('the scope carries the product dimension a service needs to ask about a title', () => {
  assert.equal(seasonPass.scope, 'title:crucible')
  const platformWide: Entitlement = { ...seasonPass, scope: 'platform' }
  assert.equal(platformWide.scope, 'platform')
})

test('a subscription confers access while trialing, active or past due — and not after', () => {
  assert.equal(subscriptionConfersAccess('trialing'), true)
  assert.equal(subscriptionConfersAccess('active'), true)
  assert.equal(subscriptionConfersAccess('past_due'), true)
  assert.equal(subscriptionConfersAccess('paused'), false)
  assert.equal(subscriptionConfersAccess('cancelled'), false)
  assert.equal(subscriptionConfersAccess('expired'), false)
})

test('a payout nets exactly, and an inconsistent one is caught', () => {
  const payout: Payout = {
    id: 'pay-1',
    subject: userSubject('u1'),
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    assetCode: 'SHARD',
    gross: 10_000n,
    platformFee: 1_500n,
    net: payoutNet(10_000n, 1_500n),
    status: 'pending',
    journalEntryId: 'entry-9',
  }
  assert.equal(payout.net, 8_500n)
  assert.equal(isPayoutConsistent(payout), true)
  assert.equal(isPayoutConsistent({ ...payout, net: 8_501n }), false)
  assert.throws(() => payoutNet(100n, 101n), RangeError)
  assert.throws(() => payoutNet(-1n, 0n), RangeError)
})

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
