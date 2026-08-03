import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASSWORD_MAX_LENGTH,
  SCOPES,
  SCOPE_NAMES,
  activeFactors,
  checkPassword,
  classifyFactorRemoval,
  grantsAllScopes,
  grantsScope,
  hasRole,
  hasScope,
  isDeprecatedScope,
  isScope,
  isServiceClaims,
  isUserClaims,
  knownScopes,
  LIVE_SCOPE_NAMES,
  normaliseEmail,
  normaliseHandle,
  ownersOf,
  scopeSpec,
  truncateIp,
  validateEmail,
  validateHandle,
  validateLogin,
  validateRegistration,
  wouldOrphanOrganisation,
  type Claims,
  type MembershipShape,
  type MfaFactor,
} from './index.ts'

const codes = (result: { ok: boolean; errors?: readonly { code: string }[] }) =>
  (result.errors ?? []).map((e) => e.code)

// --- scopes ----------------------------------------------------------------

test('the scope registry is a closed, enumerated set — every widening is deliberate', () => {
  // This test used to claim the list was "exactly the closed set of AD-17". AD-17 says scoped
  // service tokens and no shared bearer secrets — a principle; it enumerates no scopes. The list
  // below is the REGISTRY's own inventory, pinned so a scope can only be added by editing this
  // file in the same commit — which is the property that matters. The 2026-08-02 audit found the
  // estate's services gating on 39 scopes this registry lacked (identity therefore could not mint
  // a token for most service-to-service surfaces, and every suite was green off fake principals);
  // all 39 are registered below with their gate citations, and micro-org's service-ci.yml now
  // derives every repository's demands and fails its build if one is missing here — so this list
  // grows in the same commit as the gate that needs it, or that repository's CI goes red.
  //
  // It only ever GROWS: this package is additive-only (AD-02) and the compat job refuses a removal,
  // because narrowing `Scope` narrows every union built from it in twenty-two consumers. A scope
  // the estate turns out not to demand is therefore marked `deprecated` and drops out of
  // `LIVE_SCOPE_NAMES` — see the two below — rather than disappearing from this list.
  assert.deepEqual([...SCOPE_NAMES].sort(), [
    'admin:audit:write',
    'admin:read',
    'aetherholm:provision',
    'aetherholm:read',
    'aetherholm:write',
    'analytics:admin',
    'analytics:ingest',
    'analytics:read',
    'beacon:gate',
    'beacon:read',
    'beacon:write',
    'billing:grant',
    'billing:read',
    'community:execute',
    'community:write',
    'custody:address:create',
    'custody:sign:deployer',
    'custody:sign:deposit',
    'custody:sign:treasury',
    'custody:treasury:read',
    'devplatform:admin',
    'devplatform:introspect',
    'emberkin:write',
    'faucet:read',
    'identity:admin',
    'indexer:read',
    'indexer:write',
    'lantern:read',
    'ledger:post',
    'ledger:read',
    'ledger:reserve',
    'market:admin',
    'market:read',
    'market:write',
    'mint:read',
    'mint:write',
    'nda:write',
    'notify:read',
    'notify:send',
    'policy:decide',
    'pricing:admin',
    'pricing:read',
    'settlement:read',
    'settlement:register',
    'studio:read',
    'studio:write',
    'trade:admin',
    'trade:read',
    'trade:write',
    'wallet:money',
    'wallet:provision',
    'wallet:read',
    'wallet:write',
    'worlds:admin',
    'worlds:read',
    'worlds:title',
    'worlds:write',
  ])
})

/**
 * The reverse direction of the audit, which no repository's CI can run.
 *
 * `service-ci.yml` proves **demands ⊆ registry** for one service at a time — a gate asking for an
 * unregistered scope fails that repository's build. Nothing proves the other direction, because no
 * single checkout can see every gate in the estate: a scope here that no gate anywhere demands is
 * invisible to every build and to this file's own inventory pin, which was written from the
 * registry rather than from the gates. Both entries below were exactly that, and the pin was
 * protecting them.
 *
 * A dead scope is not inert. identity mints tokens from this list, so it is a credential that can
 * be granted, audited and rotated while opening nothing — and the next reader takes it as evidence
 * that a capability exists somewhere.
 */
test('the two scopes no gate in the estate demands are marked dead, not granted', () => {
  // notify/src/server.ts:417 — /ingest is MAC-only. The signature over the raw bytes IS the
  // authentication; no bearer is read, so no scope can gate it. notify had already deleted its own
  // `notify:ingest` constant on this reasoning and recorded it at notify/src/server.ts:99.
  assert.equal(isDeprecatedScope('notify:send'), true)
  // wallet/src/server.ts:132 — read / write / money, three authorities, deliberately. Creating a
  // wallet (:464) and assigning a deposit address (:605) are both `wallet:write`.
  assert.equal(isDeprecatedScope('wallet:provision'), true)

  // Neither is a scope to grant...
  assert.equal(LIVE_SCOPE_NAMES.includes('notify:send'), false)
  assert.equal(LIVE_SCOPE_NAMES.includes('wallet:provision'), false)
  // ...and both still resolve, because AD-02 forbids narrowing a published union. A consumer
  // pinned to an older copy of this package keeps compiling; it simply grants nothing.
  assert.equal(isScope('notify:send'), true)
  assert.equal(isScope('wallet:provision'), true)

  // The gates those surfaces really use are live, so this is not passing by amputation.
  assert.equal(isDeprecatedScope('notify:read'), false)
  assert.equal(isDeprecatedScope('wallet:write'), false)
  assert.equal(LIVE_SCOPE_NAMES.length, SCOPE_NAMES.length - 2)
})

test('a dead scope says why, at the length of a decision rather than a label', () => {
  for (const scope of SCOPE_NAMES) {
    if (!isDeprecatedScope(scope)) continue
    const reason = scopeSpec(scope).deprecated ?? ''
    assert.ok(
      reason.length > 80,
      `${scope} is deprecated without saying what gate replaced it — that is a hole, not a decision`,
    )
  }
})

test('every scope names the service that enforces it and says what it permits', () => {
  for (const scope of SCOPE_NAMES) {
    assert.notEqual(SCOPES[scope].service, '')
    assert.notEqual(SCOPES[scope].description, '')
  }
})

test('the scope registry cannot be mutated at runtime', () => {
  assert.throws(() => {
    // @ts-expect-error frozen and readonly; this is the runtime half
    SCOPES['ledger:post'] = undefined
  })
})

test('there is no wildcard scope — the shared bearer token does not come back by prefix', () => {
  assert.equal(isScope('custody:*'), false)
  assert.equal(isScope('*'), false)
  assert.equal(grantsScope(['custody:*'], 'custody:sign:treasury'), false)
  assert.equal(grantsScope(['ledger'], 'ledger:post'), false)
})

test('custody signing is separated by purpose, so a sweeper cannot ask for a treasury signature', () => {
  const settlement = ['custody:sign:deposit']
  assert.equal(grantsScope(settlement, 'custody:sign:deposit'), true)
  assert.equal(grantsScope(settlement, 'custody:sign:treasury'), false)
})

test('grantsAllScopes requires every scope, not any', () => {
  assert.equal(grantsAllScopes(['ledger:read', 'ledger:post'], ['ledger:read', 'ledger:post']), true)
  assert.equal(grantsAllScopes(['ledger:read'], ['ledger:read', 'ledger:post']), false)
})

test('an unknown scope on a token carries nothing', () => {
  assert.deepEqual(knownScopes(['ledger:read', 'ledger:delete']), ['ledger:read'])
})

// --- claims ----------------------------------------------------------------

const userClaims: Claims = {
  typ: 'user',
  iss: 'https://identity.cloudsforge.online',
  aud: 'hub-api',
  sub: 'user-1',
  iat: 1,
  exp: 2,
  jti: 'jti-1',
  roles: ['player'],
  sid: 'session-1',
  amr: ['pwd', 'totp'],
}

const serviceClaims: Claims = {
  typ: 'service',
  iss: 'https://identity.cloudsforge.online',
  aud: 'ledger',
  sub: 'settlement',
  iat: 1,
  exp: 2,
  jti: 'jti-2',
  scopes: ['ledger:post'],
}

test('typ discriminates the two token kinds', () => {
  assert.equal(isUserClaims(userClaims), true)
  assert.equal(isServiceClaims(userClaims), false)
  assert.equal(isServiceClaims(serviceClaims), true)
})

test('a user token grants no scope and a service token holds no role', () => {
  assert.equal(hasScope(userClaims, 'ledger:post'), false)
  assert.equal(hasRole(serviceClaims, 'admin'), false)
  assert.equal(hasScope(serviceClaims, 'ledger:post'), true)
  assert.equal(hasRole(userClaims, 'player'), true)
})

// --- MFA -------------------------------------------------------------------

const factor = (id: string, status: MfaFactor['status'], kind: MfaFactor['kind'] = 'totp'): MfaFactor => ({
  id,
  userId: 'user-1',
  kind,
  label: id,
  status,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
})

test('removing the last active factor is a distinct case, not a flag', () => {
  const result = classifyFactorRemoval([factor('a', 'active')], 'a')
  assert.equal(result.kind, 'last_active')
  if (result.kind !== 'last_active') return
  assert.deepEqual(result.requires, ['reauthentication', 'notification'])
})

test('removing one of several factors is ordinary and reports what remains', () => {
  const result = classifyFactorRemoval([factor('a', 'active'), factor('b', 'active', 'webauthn')], 'a')
  assert.equal(result.kind, 'ordinary')
  if (result.kind !== 'ordinary') return
  assert.equal(result.remainingActive, 1)
})

test('a revoked or pending factor does not keep the account covered', () => {
  const factors = [factor('a', 'active'), factor('b', 'revoked'), factor('c', 'pending')]
  assert.equal(activeFactors(factors).length, 1)
  assert.equal(classifyFactorRemoval(factors, 'a').kind, 'last_active')
})

test('removing a factor that is already revoked is not a last-factor event', () => {
  assert.equal(classifyFactorRemoval([factor('a', 'revoked')], 'a').kind, 'already_revoked')
})

test('an unknown factor id is reported rather than treated as a removal', () => {
  assert.equal(classifyFactorRemoval([factor('a', 'active')], 'zzz').kind, 'not_found')
})

// --- IP truncation ---------------------------------------------------------

test('an IPv4 address is reduced to its /24 and the host octet never survives', () => {
  assert.equal(truncateIp('203.0.113.57'), '203.0.113.0/24')
  assert.ok(!truncateIp('203.0.113.57')?.includes('57'))
})

test('an IPv6 address is reduced to its /48', () => {
  assert.equal(truncateIp('2001:db8:1234:5678:9abc:def0:1234:5678'), '2001:db8:1234::/48')
})

test('a compressed IPv6 address is expanded before it is truncated', () => {
  assert.equal(truncateIp('2001:db8::1'), '2001:db8:0::/48')
  assert.equal(truncateIp('::1'), '0:0:0::/48')
})

test('an IPv4-mapped address is truncated as IPv4, not as a /48 that keeps every IPv4 bit', () => {
  const result = truncateIp('::ffff:203.0.113.57')
  assert.equal(result, '203.0.113.0/24')
})

test('a bracketed address and a zone id are handled', () => {
  assert.equal(truncateIp('[2001:db8:1234::1]'), '2001:db8:1234::/48')
  assert.equal(truncateIp('fe80::1%eth0'), 'fe80:0:0::/48')
})

test('anything that is not an address stores nothing rather than a fragment', () => {
  for (const bad of ['', '  ', 'localhost', '203.0.113', '203.0.113.999', '1.2.3.4.5', 'zzzz::1', '1::2::3']) {
    assert.equal(truncateIp(bad), null, `${bad} should not truncate`)
  }
})

test('an octet with a leading zero is refused rather than parsed two ways', () => {
  assert.equal(truncateIp('203.0.113.010'), null)
})

// --- organisations ---------------------------------------------------------

const member = (userId: string, role: MembershipShape['role'], accepted = true): MembershipShape => ({
  userId,
  role,
  acceptedAt: accepted ? '2026-01-01T00:00:00.000Z' : null,
})

test('the last owner cannot leave', () => {
  const org = [member('a', 'owner'), member('b', 'admin')]
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: null }), true)
})

test('the last owner cannot be demoted — the same fault by another route', () => {
  const org = [member('a', 'owner'), member('b', 'admin')]
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: 'admin' }), true)
})

test('one of two owners may leave or be demoted', () => {
  const org = [member('a', 'owner'), member('b', 'owner')]
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: null }), false)
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: 'read' }), false)
})

test('removing a non-owner never orphans an organisation', () => {
  const org = [member('a', 'owner'), member('b', 'billing')]
  assert.equal(wouldOrphanOrganisation(org, { userId: 'b', nextRole: null }), false)
})

test('an owner who has not accepted the invitation is not yet keeping the org alive', () => {
  const org = [member('a', 'owner'), member('b', 'owner', false)]
  assert.deepEqual(ownersOf(org).map((m) => m.userId), ['a'])
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: null }), true)
})

test('promoting someone to owner rescues an organisation that would otherwise be orphaned', () => {
  const org = [member('a', 'admin')]
  assert.equal(wouldOrphanOrganisation(org, { userId: 'a', nextRole: 'owner' }), false)
})

// --- email and handle ------------------------------------------------------

test('email is lowercased and trimmed on write — the live register/forgot inconsistency', () => {
  assert.equal(normaliseEmail('  Sam@Example.COM '), 'sam@example.com')
})

test('registration returns the normalised email, so the column only ever holds one spelling', () => {
  const result = validateRegistration({
    email: 'Sam@Example.COM',
    handle: 'Sam_Forge',
    password: 'correct-horse-battery',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.email, 'sam@example.com')
})

test('login normalises the identifier exactly as registration did', () => {
  const result = validateLogin({ identifier: ' Sam@Example.COM ', password: 'x' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.identifier, 'sam@example.com')
  assert.equal(result.value.identifierKind, 'email')
})

test('a handle identifier is lowercased to its uniqueness key', () => {
  const result = validateLogin({ identifier: 'Sam_Forge', password: 'x' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.identifier, 'sam_forge')
  assert.equal(result.value.identifierKind, 'handle')
})

test('display casing is kept while the uniqueness key is not', () => {
  const result = validateRegistration({ email: 'a@b.co', handle: 'Alice', password: 'a-good-passphrase' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.handle, 'Alice')
  assert.equal(result.value.handleKey, 'alice', 'Alice and alice must not be two accounts')
  assert.equal(normaliseHandle('ALICE'), 'alice')
})

test('an address without a dotted domain is not an email address', () => {
  for (const bad of ['sam', 'sam@', '@example.com', 'sam@example', 'sam @example.com']) {
    assert.equal(validateEmail(bad).ok, false, `${bad} should be refused`)
  }
})

test('a handle outside 3 to 20 characters is refused', () => {
  assert.deepEqual(codes(validateHandle('ab')), ['length'])
  assert.deepEqual(codes(validateHandle('a'.repeat(21))), ['length'])
  assert.equal(validateHandle('abc').ok, true)
  assert.equal(validateHandle('a'.repeat(20)).ok, true)
})

test('a handle is letters, numbers, underscore and hyphen only', () => {
  assert.deepEqual(codes(validateHandle('sam forge')), ['charset'])
  assert.deepEqual(codes(validateHandle('sam.forge')), ['charset'])
  assert.equal(validateHandle('Sam_Forge-1').ok, true)
})

// --- passwords -------------------------------------------------------------

test('a password shorter than 8 or longer than 128 is refused', () => {
  assert.deepEqual(codes(checkPassword('short12')), ['too_short'])
  assert.deepEqual(codes(checkPassword('a1'.repeat(65))), ['too_long'])
})

test('length is counted in code points, so a non-BMP passphrase is not held to half the limit', () => {
  const astral = Array.from({ length: PASSWORD_MAX_LENGTH }, (_, i) =>
    String.fromCodePoint(0x20000 + i),
  ).join('')
  assert.equal(astral.length, PASSWORD_MAX_LENGTH * 2, 'the UTF-16 length is double, as intended')
  assert.equal(checkPassword(astral).ok, true)
  assert.deepEqual(codes(checkPassword(astral + String.fromCodePoint(0x20000 + 999))), ['too_long'])
})

test('one character repeated is not a password', () => {
  assert.deepEqual(codes(checkPassword('aaaaaaaaaaaa')), ['repetitive'])
})

test('a password containing the handle is refused, whatever the casing', () => {
  assert.deepEqual(codes(checkPassword('xxSamForgeyy', { handle: 'samforge' })), ['contains_handle'])
  assert.deepEqual(codes(checkPassword('samforge123', { handle: 'SamForge' })), ['contains_handle'])
})

test('a password containing the email local part is refused', () => {
  assert.deepEqual(codes(checkPassword('sam-is-here', { email: 'Sam@example.com' })), [
    'contains_email',
  ])
})

test('a one or two character email local part does not reject every password containing that letter', () => {
  // Regression: the containment check had no length floor, so an account at a@b.co could not
  // register any password containing the letter A.
  assert.equal(checkPassword('a-good-passphrase', { email: 'a@b.co' }).ok, true)
  assert.equal(checkPassword('the-quick-brown-fox', { email: 'jo@b.co' }).ok, true)
})

test('the email domain is not treated as a forbidden substring', () => {
  assert.equal(checkPassword('example-and-more', { email: 'sam@example.com' }).ok, true)
})

// --- registration ----------------------------------------------------------

test('registration reports every bad field at once, not just the first', () => {
  const result = validateRegistration({ email: 'nope', handle: 'a b', password: 'x' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const fields = new Set(result.errors.map((e) => e.field))
  assert.deepEqual([...fields].sort(), ['email', 'handle', 'password'])
})

test('the handle rule is only applied to the password once the handle itself is valid', () => {
  const result = validateRegistration({
    email: 'sam@example.com',
    handle: 'sam forge',
    password: 'a-good-passphrase',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(codes(result), ['charset'], 'no password noise on a form that already failed')
})

test('a non-object body is a validation failure, not a crash', () => {
  assert.equal(validateRegistration(null).ok, false)
  assert.equal(validateRegistration('sam').ok, false)
  assert.equal(validateLogin(undefined).ok, false)
})

test('login checks the password for presence only — strength rules there leak information', () => {
  const result = validateLogin({ identifier: 'sam@example.com', password: 'a' })
  assert.equal(result.ok, true, 'an old password must still be able to sign in')
})

test('login without an identifier or a password says which is missing', () => {
  const result = validateLogin({})
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map((e) => e.field).sort(), ['identifier', 'password'])
})
