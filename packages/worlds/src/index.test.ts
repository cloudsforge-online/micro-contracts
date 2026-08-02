import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACHIEVEMENT_DEFINITION_FIELDS,
  ACHIEVEMENT_UNLOCK_FIELDS,
  CAPABILITIES,
  PROVISION_PATH,
  PROVISION_REQUEST_FIELDS,
  PROVISION_RESULT_FIELDS,
  SCOPE_FOR,
  TITLE_DESCRIPTOR_FIELDS,
  TITLE_DESCRIPTOR_PATH,
  UNLOCK_CREATED_STATUS,
  UNLOCK_REPLAYED_STATUS,
  UNSUPPORTED_CODE,
  UNSUPPORTED_STATUS,
  WORLDS_OPERATIONS,
  achievementDefinePath,
  achievementIdempotencyKey,
  achievementUnlockPath,
  isCapability,
  isTitleId,
  parseAchievementDefinition,
  parseAchievementUnlock,
  parseAchievementUnlockResult,
  parseProvisionRequest,
  parseProvisionResult,
  parseShards,
  parseTitleDescriptor,
  parseTitleUrn,
  provisionIdempotencyKey,
  provisionScopeFor,
  serialiseAchievementDefinition,
  serialiseAchievementUnlock,
  serialiseProvisionRequest,
  serialiseProvisionResult,
  serialiseTitleDescriptor,
  titleUrn,
  type AchievementDefinition,
  type AchievementUnlock,
  type ProvisionRequest,
  type TitleDescriptor,
} from './index.ts'

const errorsOf = (result: { ok: boolean; errors?: readonly string[] }) => result.errors ?? []

/* ------------------------------------------------------------------ the inventories, pinned */

/**
 * The same property the scope and topic registries buy: a capability can be added or removed only
 * by editing this list in the same commit, so no widening lands without a reader seeing the whole
 * set change. It is also the one place that states, in one screen, what a title may be asked for.
 */
test('the capability registry is a closed, enumerated set', () => {
  assert.deepEqual([...CAPABILITIES].sort(), [
    'achievements',
    'cosmetics',
    'inventory',
    'private_world',
    'seasons',
  ])
  assert.equal(isCapability('private_world'), true)
  assert.equal(isCapability('private_worlds'), false)
})

test('every cross-repository operation names the scope its server demands', () => {
  assert.deepEqual([...WORLDS_OPERATIONS].sort(), [
    'defineAchievement',
    'registerTitle',
    'unlockAchievement',
  ])
  // The map is TOTAL over the operation union — a new operation without a scope does not typecheck,
  // and this asserts the runtime half of that.
  for (const operation of WORLDS_OPERATIONS) {
    assert.ok(SCOPE_FOR[operation], `${operation} names no scope`)
  }
  // Defect 2 from the file header, as an assertion rather than a comment: both title clients
  // declared `worlds:write` (nda/src/worldsclient.ts:15, emberkin/src/worldsclient.ts:15) and the
  // route demands `worlds:title` (worlds/src/server.ts:777).
  assert.equal(SCOPE_FOR.unlockAchievement, 'worlds:title')
  assert.equal(SCOPE_FOR.defineAchievement, 'worlds:title')
  assert.equal(SCOPE_FOR.registerTitle, 'worlds:admin')
})

/**
 * The scopes named here must be scopes the estate actually has.
 *
 * `contracts-auth`'s registry is the estate's inventory of them, and it distinguishes LIVE from
 * DEPRECATED — a deprecated scope still resolves, so `isScope` alone would accept one that grants
 * nothing. Reading it from disk rather than restating it is the whole point: a scope renamed or
 * deprecated over there turns this red, which is the direction that fails silently otherwise.
 *
 * A sibling package in the same repository, imported by path deliberately: this is one repository
 * and one build, so there is no version to skew. The rule 11 §1 states — never a path import — is
 * about crossing a REPOSITORY boundary, which this does not.
 */
test('every scope named here is live in contracts-auth', async () => {
  const auth = await import('../../auth/src/index.ts')
  for (const operation of WORLDS_OPERATIONS) {
    const scope = SCOPE_FOR[operation]
    assert.equal(auth.isScope(scope), true, `${scope} is not in the auth registry at all`)
    assert.equal(
      auth.LIVE_SCOPE_NAMES.includes(scope),
      true,
      `${scope} is registered but deprecated — granting it opens nothing`,
    )
  }
  // The provision scope is DERIVED, so it cannot be pinned; the one title that exists is checked
  // instead, which is what makes the derivation rule true rather than plausible.
  assert.equal(provisionScopeFor('aetherholm'), 'aetherholm:provision')
  assert.equal(auth.LIVE_SCOPE_NAMES.includes('aetherholm:provision'), true)
})

/* ------------------------------------------------------------------ the descriptor */

test('a descriptor round-trips, and the wire fields are exactly the pinned three', () => {
  const descriptor: TitleDescriptor = {
    slug: 'aetherholm',
    name: 'Aetherholm',
    capabilities: ['private_world'],
  }
  const wire = serialiseTitleDescriptor(descriptor)
  assert.deepEqual(Object.keys(wire).sort(), [...TITLE_DESCRIPTOR_FIELDS].sort())
  const parsed = parseTitleDescriptor(wire)
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, descriptor)
})

test('a capability the registry does not know is refused, not carried', () => {
  // The typo'd capability. `aetherholm/src/server.ts:110` builds this array from a bare literal
  // with nothing to check it against, and worlds accepts any string array today
  // (worlds/src/titleclient.ts:120-125) — so a purchase is taken for something nothing sells.
  const parsed = parseTitleDescriptor({
    slug: 'aetherholm',
    name: 'Aetherholm',
    capabilities: ['private_worlds'],
  })
  assert.equal(parsed.ok, false)
  assert.match(errorsOf(parsed).join('; '), /"private_worlds" is not a registered capability/)
})

test('a descriptor with no slug, or a slug that is not one, is refused', () => {
  assert.equal(parseTitleDescriptor({ name: 'X', capabilities: [] }).ok, false)
  const upper = parseTitleDescriptor({ slug: 'Aetherholm', name: 'X', capabilities: [] })
  assert.equal(upper.ok, false)
  assert.match(errorsOf(upper).join('; '), /is not a title slug/)
  // Every problem, not just the first — a caller fixing a descriptor should need one round.
  const both = parseTitleDescriptor({ slug: '', name: '', capabilities: 3 })
  assert.equal(both.ok, false)
  assert.equal(errorsOf(both).length, 3)
})

test('an unknown field is ignored — a producer running ahead is safe, AD-02', () => {
  const parsed = parseTitleDescriptor({
    slug: 'aetherholm',
    name: 'Aetherholm',
    capabilities: [],
    releasedAt: '2026-08-01',
  })
  assert.ok(parsed.ok)
  assert.deepEqual(Object.keys(parsed.value).sort(), ['capabilities', 'name', 'slug'])
})

/* ------------------------------------------------------------------ provisioning */

const provisionRequest: ProvisionRequest = {
  entitlementId: '4f1c6d5e-8b2a-4c33-9f77-0d1e2a3b4c5d',
  subject: 'user:11111111-2222-3333-4444-555555555555',
  userId: '11111111-2222-3333-4444-555555555555',
  sku: 'private_skerry',
  scope: 'aetherholm',
  metadata: { name: 'The Long Quiet' },
  correlationId: 'req-abc',
}

/**
 * THE GUARD. The sender's bytes are driven into the receiver's parser.
 *
 * Every one of the three defects in the file header is an agreement about bytes that TypeScript
 * never saw, because the two halves live in two repositories and no build sees both. This is the
 * check that would have seen all three: a rename on either side moves the keys, the pin catches it,
 * and the round-trip catches anything the pin misses.
 */
test('a provision request round-trips through the receiver parser', () => {
  const wire = serialiseProvisionRequest(provisionRequest)
  assert.deepEqual(Object.keys(wire).sort(), [...PROVISION_REQUEST_FIELDS].sort())
  const parsed = parseProvisionRequest(wire, provisionRequest.correlationId)
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, provisionRequest)
})

/**
 * `correlationId` is NOT a body field, and a receiver that made it one would 400 every real
 * request from the bridge while passing every test written from the interface.
 * `worlds/src/titleclient.ts:137-149` sends six body fields and the correlation id as `requestId`.
 */
test('the correlation id travels as the request id, never in the body', () => {
  const wire = serialiseProvisionRequest(provisionRequest)
  assert.equal('correlationId' in wire, false)
  assert.equal(PROVISION_REQUEST_FIELDS.includes('correlationId'), false)
  const missing = parseProvisionRequest(wire, '   ')
  assert.equal(missing.ok, false)
  assert.match(errorsOf(missing).join('; '), /correlationId: is empty/)
})

test('the idempotency key is the entitlement id, and nothing else', () => {
  assert.equal(provisionIdempotencyKey(provisionRequest), provisionRequest.entitlementId)
})

test('an empty entitlement id is refused — it is what a failed interpolation looks like', () => {
  const parsed = parseProvisionRequest({ ...serialiseProvisionRequest(provisionRequest), entitlementId: '' }, 'req-1')
  assert.equal(parsed.ok, false)
  assert.match(errorsOf(parsed).join('; '), /entitlementId: is empty/)
})

test('metadata must be an object — an array or a string is refused', () => {
  for (const metadata of [[], 'name=x', 7, null]) {
    const parsed = parseProvisionRequest(
      { ...serialiseProvisionRequest(provisionRequest), metadata },
      'req-1',
    )
    assert.equal(parsed.ok, false, `metadata ${JSON.stringify(metadata)} was accepted`)
  }
})

test('a provision result round-trips, and an ill-formed urn is refused', () => {
  const result = { urn: 'cf:aetherholm:skerry:abc-123', replayed: true }
  const wire = serialiseProvisionResult(result)
  assert.deepEqual(Object.keys(wire).sort(), [...PROVISION_RESULT_FIELDS].sort())
  const parsed = parseProvisionResult(wire)
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, result)

  // A 2xx with no urn is a title claiming a success it cannot name.
  assert.equal(parseProvisionResult({ replayed: false }).ok, false)
  // And one with a urn of the wrong shape is stored and pointed at for ever.
  assert.equal(parseProvisionResult({ urn: 'aetherholm/skerry/1', replayed: false }).ok, false)
})

test('replayed is true only for literal true — the safe direction', () => {
  for (const replayed of ['true', 1, {}, undefined, null]) {
    const parsed = parseProvisionResult({ urn: 'cf:a:b:c', replayed })
    assert.ok(parsed.ok)
    assert.equal(parsed.value.replayed, false, `${JSON.stringify(replayed)} was read as replayed`)
  }
})

test('the two paths and the unsupported answer are stated once', () => {
  assert.equal(TITLE_DESCRIPTOR_PATH, '/v1/title')
  assert.equal(PROVISION_PATH, '/v1/provision')
  assert.equal(UNSUPPORTED_STATUS, 422)
  assert.equal(UNSUPPORTED_CODE, 'unsupported')
})

/* ------------------------------------------------------------------ urns */

test('a urn round-trips and refuses every shape that is not one', () => {
  const urn = { title: 'aetherholm', kind: 'skerry', id: 'abc-123' }
  const parsed = parseTitleUrn(titleUrn(urn))
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, urn)

  for (const bad of ['cf:aetherholm:skerry', 'aetherholm:skerry:1', 'cf:Aetherholm:skerry:1', 'cf:a:b:']) {
    assert.equal(parseTitleUrn(bad).ok, false, `${bad} was accepted`)
  }
})

/* ------------------------------------------------------------------ achievements */

test('the title is a uuid in the path, not a slug in the body', () => {
  // Defect 3. `worlds/src/server.ts:968-972` answers 404 before the handler runs, so a title
  // sending its slug gets a permanent refusal it will never diagnose.
  assert.equal(isTitleId('7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b'), true)
  assert.equal(isTitleId('aetherholm'), false)
  assert.equal(
    achievementUnlockPath('7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b'),
    '/v1/titles/7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b/achievements/unlock',
  )
  assert.equal(
    achievementDefinePath('7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b'),
    '/v1/titles/7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b/achievements',
  )
  // The unlock path is the define path plus a suffix, which is how worlds' router distinguishes
  // them — asserted so a change to one that forgets the other cannot pass.
  const id = '7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b'
  assert.equal(achievementUnlockPath(id), `${achievementDefinePath(id)}/unlock`)
})

test('an achievement definition round-trips, Shards as a decimal string', () => {
  const definition: AchievementDefinition = {
    key: 'dex_complete',
    name: 'Dex Complete',
    description: 'Every Kin recorded.',
    points: 50,
    rewardShards: 1_000_000_000_000_000_000n,
  }
  const wire = serialiseAchievementDefinition(definition)
  assert.deepEqual(Object.keys(wire).sort(), [...ACHIEVEMENT_DEFINITION_FIELDS].sort())
  // A string, never a number: JSON.stringify throws on a bigint, and Number() loses precision here.
  assert.equal(wire['rewardShards'], '1000000000000000000')
  const parsed = parseAchievementDefinition(wire)
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, definition)
})

/**
 * `BigInt('')` is `0n`.
 *
 * The estate's standing trap. An empty string is what a missing field, an unset input and a failed
 * interpolation all look like, and a bare cast turns every one of them into a legitimate-looking
 * reward of zero that nobody ever queries.
 */
test('an empty string is not zero Shards', () => {
  assert.equal(BigInt(''), 0n) // the trap itself, stated so the test is not taken on faith
  const parsed = parseShards('', 'rewardShards')
  assert.equal(parsed.ok, false)
  assert.match(errorsOf(parsed).join('; '), /is not a non-negative decimal integer/)

  for (const bad of ['-1', '1.5', ' 7', '0x10', '007', 7, null, undefined]) {
    assert.equal(parseShards(bad, 'x').ok, false, `${JSON.stringify(bad)} was accepted`)
  }
  assert.deepEqual(parseShards('0', 'x'), { ok: true, value: 0n })
})

test('an unlock carries exactly userId and key — the achievement must already be defined', () => {
  const unlock: AchievementUnlock = {
    userId: '11111111-2222-3333-4444-555555555555',
    key: 'dex_complete',
  }
  const wire = serialiseAchievementUnlock(unlock)
  assert.deepEqual(Object.keys(wire).sort(), [...ACHIEVEMENT_UNLOCK_FIELDS].sort())
  const parsed = parseAchievementUnlock(wire)
  assert.ok(parsed.ok, errorsOf(parsed).join('; '))
  assert.deepEqual(parsed.value, unlock)

  // `worlds/src/rewards.ts:215-216` refuses an unlock for an achievement that was never defined,
  // so name and points on the unlock are a client that believes worlds will create it. They are
  // not wire fields here; they belong to the definition document.
  assert.equal(ACHIEVEMENT_UNLOCK_FIELDS.includes('name'), false)
  assert.equal(ACHIEVEMENT_UNLOCK_FIELDS.includes('points'), false)
  assert.equal(ACHIEVEMENT_UNLOCK_FIELDS.includes('titleSlug'), false)
})

test('the unlock idempotency key is derived from the three stable facts', () => {
  const key = achievementIdempotencyKey({
    titleId: '7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    userId: 'u1',
    key: 'dex_complete',
  })
  assert.equal(key, '7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b:achievement:u1:dex_complete')
  // Same inputs, same key, on every replica and every retry. Nothing time-derived, nothing random.
  assert.equal(
    key,
    achievementIdempotencyKey({
      titleId: '7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      userId: 'u1',
      key: 'dex_complete',
    }),
  )
})

test('the unlock answer distinguishes a fresh badge from a replay', () => {
  assert.equal(UNLOCK_CREATED_STATUS, 201)
  assert.equal(UNLOCK_REPLAYED_STATUS, 200)
  const fresh = parseAchievementUnlockResult({ unlocked: true, achievement: { key: 'dex_complete' } })
  assert.ok(fresh.ok, errorsOf(fresh).join('; '))
  assert.deepEqual(fresh.value, { unlocked: true, key: 'dex_complete' })

  const replay = parseAchievementUnlockResult({ unlocked: false, achievement: { key: 'dex_complete' } })
  assert.ok(replay.ok)
  assert.equal(replay.value.unlocked, false)

  // A body with no `achievement` object is not a result a caller can act on.
  assert.equal(parseAchievementUnlockResult({ unlocked: true }).ok, false)
  assert.equal(parseAchievementUnlockResult({ achievement: { key: 'x' } }).ok, false)
})
