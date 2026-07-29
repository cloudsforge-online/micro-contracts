/**
 * Identity shapes: users, profiles, sessions, devices, MFA factors, organisations, token claims
 * and the closed set of service scopes.
 *
 * **Types and validation only. No I/O, no jose, no network, no environment.** JWKS fetching and
 * signature verification live in the runtime `@cloudsforge/auth`; this package is the vocabulary
 * both ends agree on. The separation is not tidiness — this is imported by frontends, by CI
 * schema checks and by twenty-two services, and a contract package that opens a socket is a
 * contract package that cannot be imported by any of them.
 *
 * Four live defects in the estate motivated what is here:
 *
 * 1. **Email matching is inconsistent.** Register and login match the address verbatim while
 *    forgot-password matches `lower(email)`, so an account created as `Sam@example.com` can be
 *    reset by someone who typed it in lowercase but cannot be logged into by them. There is
 *    exactly one normalisation function in this file and every write path uses it.
 * 2. **Sessions and devices do not exist.** There are `refresh_tokens` rows and nothing that
 *    names or surfaces them, so "sign out everywhere" and "where am I signed in" are both
 *    unanswerable. 04-domain-model section 1.4 gives them shapes; this gives them types.
 * 3. **Service credentials are one shared bearer.** `PAY_SERVICE_TOKEN` and
 *    `KEYVAULT_SERVICE_TOKEN` are handed to every caller, so nothing can be scoped, rotated or
 *    revoked per service. AD-17 retires them for short-TTL RS256 tokens with explicit scopes,
 *    and the scope registry below is that closed set. There is no wildcard scope, deliberately.
 * 4. **Full IP addresses.** A session row holding a complete address is personal data with no
 *    retention story attached; `truncateIp` keeps the risk signal and drops the identifier.
 *
 * Validation is hand-written. A contract package with a schema-library dependency forces that
 * library's major version on every one of its consumers, and the rules here are a page of code.
 */

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FieldError {
  readonly field: string
  /** Stable, machine-readable. APIs branch on this; `message` is for humans and may be reworded. */
  readonly code: string
  readonly message: string
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  /** Every failing field, so a form can mark all of them in one round trip. */
  | { readonly ok: false; readonly errors: readonly FieldError[] }

function fieldError(field: string, code: string, message: string): FieldError {
  return { field, code, message }
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * Platform roles only.
 *
 * Product permissions are entitlements (billing) or organisation roles, never a role on the user.
 * 04-domain-model section 1.1 is explicit about this: the moment a product permission becomes a
 * platform role, every service has to understand every product's authorisation model.
 */
export type Role = 'player' | 'admin'

export type UserStatus = 'active' | 'suspended' | 'locked' | 'pending_deletion' | 'deleted'

/**
 * What identity returns about the authenticated user, to that user.
 *
 * "Public" means free of secrets — never a password hash, an MFA secret or a token. It is not the
 * shape other users see; that is `Profile`, which carries a `visibility` and no email.
 */
export interface PublicUser {
  readonly id: string
  readonly email: string
  readonly emailVerifiedAt: string | null
  readonly handle: string
  readonly status: UserStatus
  readonly roles: readonly Role[]
  readonly createdAt: string
  readonly lastSeenAt: string | null
}

export type ProfileVisibility = 'public' | 'members' | 'private'

export interface ProfileLink {
  readonly label: string
  readonly url: string
}

/**
 * Split from the user record because it is read by every product and written rarely.
 *
 * This is what makes "one identity" true across products. Today the only identity a product can
 * render for another user is a handle.
 */
export interface Profile {
  readonly userId: string
  readonly displayName: string | null
  readonly avatarAssetUrn: string | null
  readonly bio: string | null
  readonly links: readonly ProfileLink[]
  readonly country: string | null
  readonly locale: string | null
  readonly timezone: string | null
  readonly visibility: ProfileVisibility
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export interface ScopeSpec {
  /** The service that enforces it. Only that service should ever check for this scope. */
  readonly service: string
  readonly description: string
}

/**
 * The closed set of service scopes (AD-05, AD-17).
 *
 * Closed is the operative word. This replaces two shared bearer tokens that were, in effect, one
 * unbounded scope: any holder of `PAY_SERVICE_TOKEN` could do anything Pay could do, and there
 * was no way to say that Forge Hub's BFF may read a balance but may not post to the ledger.
 *
 * The three custody scopes are separated **by purpose, not by verb**, because that is what
 * custody's purpose gate already enforces internally and the token must not be able to express
 * something the gate would refuse. A single `custody:sign` would let a service that only ever
 * sweeps deposits ask for a treasury signature.
 */
export const SCOPES = Object.freeze({
  'ledger:read': Object.freeze({
    service: 'ledger',
    description: 'Read accounts, balances and journal entries.',
  }),
  'ledger:post': Object.freeze({
    service: 'ledger',
    description: 'Write a balanced journal entry. Every posting records the calling service.',
  }),
  'ledger:reserve': Object.freeze({
    service: 'ledger',
    description: 'Move funds between available and reserved. Held by market and trade.',
  }),
  'wallet:read': Object.freeze({
    service: 'wallet',
    description: 'Read the wallet registry, deposit assignments and withdrawal state.',
  }),
  'wallet:provision': Object.freeze({
    service: 'wallet',
    description: 'Create a managed wallet and assign a deposit address.',
  }),
  'custody:sign:deposit': Object.freeze({
    service: 'custody',
    description: 'Sign a sweep out of a deposit address. Held by settlement alone.',
  }),
  'custody:sign:treasury': Object.freeze({
    service: 'custody',
    description: 'Sign a treasury spend. Gated additionally by the treasury pin.',
  }),
  'custody:sign:deployer': Object.freeze({
    service: 'custody',
    description: 'Sign a contract deployment paying gas from the platform deployer.',
  }),
  'billing:grant': Object.freeze({
    service: 'billing',
    description: 'Grant or revoke an entitlement.',
  }),
  'billing:read': Object.freeze({
    service: 'billing',
    description: 'Ask whether a subject holds an entitlement. Today no service can ask at all.',
  }),
  'pricing:read': Object.freeze({
    service: 'pricing',
    description: 'Read a quote or an administered rate.',
  }),
  'indexer:read': Object.freeze({
    service: 'indexer',
    description: 'Read blocks, transactions, address activity and observed balances.',
  }),
  'notify:send': Object.freeze({
    service: 'notify',
    description: 'Enqueue a notification or a developer webhook delivery.',
  }),
  'policy:decide': Object.freeze({
    service: 'policy',
    description: 'Submit a decision request and receive allow, deny, challenge or review.',
  }),
} as const satisfies Readonly<Record<string, ScopeSpec>>)

export type Scope = keyof typeof SCOPES

export const SCOPE_NAMES: readonly Scope[] = Object.freeze(Object.keys(SCOPES) as Scope[])

export function isScope(value: string): value is Scope {
  return Object.hasOwn(SCOPES, value)
}

export function scopeSpec(scope: Scope): ScopeSpec {
  return SCOPES[scope]
}

/**
 * Exact match only. There is no `custody:*`, no `ledger:write` covering `ledger:post`, and no
 * implication ordering between scopes.
 *
 * Hierarchy is how a shared token comes back: someone grants a prefix "temporarily" and a year
 * later the audit cannot say what a caller was allowed to do. If a service needs two capabilities
 * it is granted two scopes, and the token says so.
 */
export function grantsScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required)
}

export function grantsAllScopes(granted: readonly string[], required: readonly Scope[]): boolean {
  return required.every((scope) => grantsScope(granted, scope))
}

/** Drops anything not in the registry. A token carrying an unknown scope carries nothing. */
export function knownScopes(granted: readonly string[]): readonly Scope[] {
  return granted.filter(isScope)
}

// ---------------------------------------------------------------------------
// Token claims
// ---------------------------------------------------------------------------

/** How the subject proved who they were. Recorded so a step-up can be demanded later. */
export type AuthMethod = 'pwd' | 'totp' | 'webauthn' | 'recovery_code' | 'sso'

export interface BaseClaims {
  readonly iss: string
  readonly aud: string | readonly string[]
  readonly sub: string
  /** Seconds since the epoch, as JWT requires. Not milliseconds, and not an ISO string. */
  readonly iat: number
  readonly exp: number
  /** Unique per token, so a single credential can be revoked without revoking a family. */
  readonly jti: string
}

export interface UserClaims extends BaseClaims {
  readonly typ: 'user'
  /** `sub` is the user id. */
  readonly roles: readonly Role[]
  /** The session, so revoking a session revokes every access token minted under it. */
  readonly sid: string
  readonly amr: readonly AuthMethod[]
}

export interface ServiceClaims extends BaseClaims {
  readonly typ: 'service'
  /** `sub` is the service name, e.g. `settlement`. */
  readonly scopes: readonly Scope[]
}

export type Claims = UserClaims | ServiceClaims

/**
 * `typ` is the discriminant and it must be checked before anything else.
 *
 * A service token accepted where a user token was expected makes `sub` — a service name — look
 * like a user id, and every downstream lookup then runs against a user that does not exist or,
 * worse, one whose id happens to collide. The two token types are never interchangeable.
 */
export function isUserClaims(claims: Claims): claims is UserClaims {
  return claims.typ === 'user'
}

export function isServiceClaims(claims: Claims): claims is ServiceClaims {
  return claims.typ === 'service'
}

export function hasScope(claims: Claims, scope: Scope): boolean {
  return isServiceClaims(claims) && grantsScope(claims.scopes, scope)
}

export function hasRole(claims: Claims, role: Role): boolean {
  return isUserClaims(claims) && claims.roles.includes(role)
}

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

/**
 * The factor kinds this contract admits.
 *
 * 04-domain-model section 1.3 also lists `sms`, and it is deliberately absent here: SIM-swap
 * makes it a weaker factor than the password it is meant to strengthen, and a kind that is not in
 * the union is a kind no service can accidentally accept. Adding it later is an additive change
 * to this union and a major one to any consumer that exhaustively switches — which is the
 * conversation that should happen before it is added, not after.
 */
export type MfaKind = 'totp' | 'webauthn' | 'recovery_code'

export type MfaStatus = 'pending' | 'active' | 'revoked'

export interface MfaFactor {
  readonly id: string
  readonly userId: string
  readonly kind: MfaKind
  /** User-supplied. Never the secret, never a partial secret. */
  readonly label: string
  readonly status: MfaStatus
  readonly lastUsedAt: string | null
  readonly createdAt: string
}

/**
 * Removing the last active factor is a different operation from removing any other one.
 *
 * It is modelled as a distinct case rather than a boolean flag so a caller cannot forget it: the
 * result is a union, and the branch that would silently drop a user to password-only does not
 * type-check unless it is written. 04-domain-model section 1.3 requires re-authentication and a
 * notification, and both obligations travel with the case.
 */
export type FactorRemoval =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_revoked' }
  | { readonly kind: 'ordinary'; readonly remainingActive: number }
  | {
      readonly kind: 'last_active'
      readonly requires: readonly ['reauthentication', 'notification']
    }

export function activeFactors(factors: readonly MfaFactor[]): readonly MfaFactor[] {
  return factors.filter((factor) => factor.status === 'active')
}

export function classifyFactorRemoval(
  factors: readonly MfaFactor[],
  factorId: string,
): FactorRemoval {
  const target = factors.find((factor) => factor.id === factorId)
  if (!target) return { kind: 'not_found' }
  if (target.status !== 'active') return { kind: 'already_revoked' }
  const remaining = activeFactors(factors).filter((factor) => factor.id !== factorId).length
  if (remaining === 0) {
    return { kind: 'last_active', requires: ['reauthentication', 'notification'] }
  }
  return { kind: 'ordinary', remainingActive: remaining }
}

// ---------------------------------------------------------------------------
// Sessions and devices
// ---------------------------------------------------------------------------

export interface Device {
  readonly id: string
  readonly userId: string
  /** A hash, never the raw fingerprint. The raw value is a tracking identifier. */
  readonly fingerprintHash: string
  /** Family only — "Firefox", "iOS". A full user-agent string is a fingerprint by itself. */
  readonly userAgentFamily: string | null
  readonly osFamily: string | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly trustedAt: string | null
  readonly label: string | null
}

export type SessionStatus = 'active' | 'expired' | 'revoked' | 'superseded'

export interface Session {
  readonly id: string
  readonly userId: string
  readonly deviceId: string | null
  /**
   * Exactly one refresh-token family per session.
   *
   * This is what makes "sign out everywhere" a single operation and the device list truthful: a
   * family that outlives its session is a credential nothing surfaces and nothing can revoke.
   */
  readonly refreshFamilyId: string
  /**
   * Truncated to a /24 or a /48 by `truncateIp`. **Never a full address**, in the column, in a
   * log line, or in a response.
   */
  readonly ipPrefix: string | null
  readonly createdAt: string
  readonly lastActiveAt: string
  readonly revokedAt: string | null
  readonly revokeReason: string | null
}

function parseIpv4(text: string): readonly number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    // A leading zero is rejected rather than tolerated: parsers disagree about whether `010` is
    // ten or eight, and an address that means two things is an access-control bug in waiting.
    if (part.length > 1 && part.startsWith('0')) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function parseIpv6(text: string): readonly number[] | null {
  let body = text
  if (body.includes('.')) {
    const lastColon = body.lastIndexOf(':')
    if (lastColon < 0) return null
    const embedded = parseIpv4(body.slice(lastColon + 1))
    if (!embedded) return null
    const [a = 0, b = 0, c = 0, d = 0] = embedded
    body = `${body.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const headText = halves[0] ?? ''
  const head = headText === '' ? [] : headText.split(':')
  const tailText = halves.length === 2 ? (halves[1] ?? '') : null
  const tail = tailText === null ? null : tailText === '' ? [] : tailText.split(':')

  for (const group of [...head, ...(tail ?? [])]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
  }
  let groups: string[]
  if (tail === null) {
    if (head.length !== 8) return null
    groups = head
  } else {
    const zeros = 8 - head.length - tail.length
    if (zeros < 1) return null
    groups = [...head, ...Array<string>(zeros).fill('0'), ...tail]
  }
  return groups.map((group) => Number.parseInt(group, 16))
}

/**
 * Reduce an address to the network it came from: a /24 for IPv4, a /48 for IPv6.
 *
 * The reason to keep any of it is risk: "a sign-in from a network this account has never used" is
 * a real signal, and a /24 or /48 carries it. The reason to drop the rest is that a full address
 * is a personal identifier, it ends up in a table nobody has written a retention policy for, and
 * it is of no operational use once the prefix is known.
 *
 * Returns `null` for anything that is not an address, so a malformed forwarded header stores
 * nothing rather than storing a fragment that looks like a network.
 */
export function truncateIp(address: string): string | null {
  let text = address.trim()
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return null
    text = text.slice(1, close)
  }
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (text === '') return null

  const v4 = parseIpv4(text)
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`

  const v6 = parseIpv6(text)
  if (!v6) return null
  // Node behind a proxy hands back IPv4-mapped addresses. Truncating one as though it were IPv6
  // would keep all thirty-two IPv4 bits inside the /48 — the exact opposite of the intent.
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
    const high = v6[6] ?? 0
    const low = v6[7] ?? 0
    return `${high >> 8}.${high & 0xff}.${low >> 8}.0/24`
  }
  const prefix = [v6[0] ?? 0, v6[1] ?? 0, v6[2] ?? 0].map((group) => group.toString(16))
  return `${prefix.join(':')}::/48`
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

export type OrganisationKind = 'personal' | 'team' | 'project'

export type OrganisationStatus = 'active' | 'suspended' | 'closed'

export type OrganisationRole = 'owner' | 'admin' | 'member' | 'billing' | 'read'

export const ORGANISATION_ROLES: readonly OrganisationRole[] = Object.freeze([
  'owner',
  'admin',
  'member',
  'billing',
  'read',
])

export interface Organisation {
  readonly id: string
  readonly slug: string
  readonly name: string
  /**
   * Every user gets a `personal` organisation at registration, so there is no code path anywhere
   * that has to handle "this subject has no organisation".
   */
  readonly kind: OrganisationKind
  readonly status: OrganisationStatus
  readonly createdAt: string
}

export interface Membership {
  readonly organisationId: string
  readonly userId: string
  readonly role: OrganisationRole
  readonly invitedBy: string | null
  /** Null while the invitation is outstanding. An unaccepted owner is not yet an owner. */
  readonly acceptedAt: string | null
}

export type MembershipShape = Pick<Membership, 'userId' | 'role' | 'acceptedAt'>

/** Accepted owners only. An invitation nobody has answered cannot be the thing keeping an org alive. */
export function ownersOf(memberships: readonly MembershipShape[]): readonly MembershipShape[] {
  return memberships.filter((m) => m.role === 'owner' && m.acceptedAt !== null)
}

export interface MembershipChange {
  readonly userId: string
  /** `null` removes the membership entirely. */
  readonly nextRole: OrganisationRole | null
}

/**
 * Would this change leave the organisation with no owner?
 *
 * The invariant is that an organisation always has at least one owner, which means the last owner
 * can neither leave nor be demoted — the same rule the estate already enforces for the last
 * platform admin, applied where billing, developer projects and market team verification all
 * depend on there being someone answerable.
 *
 * Written as a question about the *resulting* set rather than as a check on the departing member,
 * because "demote the last owner" and "remove the last owner" are the same fault and a check
 * written per-operation catches only the one it was written for.
 */
export function wouldOrphanOrganisation(
  memberships: readonly MembershipShape[],
  change: MembershipChange,
): boolean {
  const others = memberships.filter((m) => m.userId !== change.userId)
  const existing = memberships.find((m) => m.userId === change.userId)
  const next: MembershipShape[] = [...others]
  if (change.nextRole !== null) {
    next.push({
      userId: change.userId,
      role: change.nextRole,
      acceptedAt: existing?.acceptedAt ?? null,
    })
  }
  return ownersOf(next).length === 0
}

// ---------------------------------------------------------------------------
// Registration and login validation
// ---------------------------------------------------------------------------

export const HANDLE_MIN_LENGTH = 3
export const HANDLE_MAX_LENGTH = 20
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const EMAIL_MAX_LENGTH = 254

const HANDLE_PATTERN = /^[a-zA-Z0-9_-]+$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

/**
 * The single normalisation. Trim, then lowercase.
 *
 * This exists because the estate has three different answers today: register and login compare
 * the address exactly as typed, forgot-password compares `lower(email)`. The result is an account
 * that can be reset by an address it cannot be logged in with. Normalise **on write** and every
 * read is a plain equality against a column that only ever holds one spelling.
 *
 * The local part is lowercased along with the domain. RFC 5321 permits a case-sensitive local
 * part; no mail provider anyone here uses honours that, and treating `Sam@` and `sam@` as two
 * accounts is a registration-collision and support problem rather than a correctness win.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The uniqueness key for a handle. Display casing is kept on the user row; comparison is not.
 *
 * Without this, `Alice` and `alice` are two accounts, and the second exists only to be mistaken
 * for the first.
 */
export function normaliseHandle(handle: string): string {
  return handle.trim().toLowerCase()
}

export function validateEmail(value: unknown, field = 'email'): Validated<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, errors: [fieldError(field, 'required', 'An email address is required.')] }
  }
  const normalised = normaliseEmail(value)
  if (normalised.length > EMAIL_MAX_LENGTH) {
    return {
      ok: false,
      errors: [fieldError(field, 'too_long', `An email address may be at most ${EMAIL_MAX_LENGTH} characters.`)],
    }
  }
  if (!EMAIL_PATTERN.test(normalised)) {
    return { ok: false, errors: [fieldError(field, 'invalid', 'That is not an email address.')] }
  }
  return { ok: true, value: normalised }
}

export function validateHandle(value: unknown, field = 'handle'): Validated<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, errors: [fieldError(field, 'required', 'A handle is required.')] }
  }
  const handle = value.trim()
  const errors: FieldError[] = []
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) {
    errors.push(
      fieldError(
        field,
        'length',
        `A handle must be between ${HANDLE_MIN_LENGTH} and ${HANDLE_MAX_LENGTH} characters.`,
      ),
    )
  }
  if (!HANDLE_PATTERN.test(handle)) {
    errors.push(
      fieldError(field, 'charset', 'A handle may contain letters, numbers, underscores and hyphens.'),
    )
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: handle }
}

export interface PasswordContext {
  readonly handle?: string
  readonly email?: string
}

/**
 * Shortest identifier worth searching for inside a password.
 *
 * Caught by a test: without this floor, an account at `a@b.co` has an email local part of `a`,
 * and "the password must not contain the local part" then rejects every password containing the
 * letter A. A validator that locks its own users out of registration is worse than the weak
 * password it was defending against. Three characters is where the check starts telling the truth
 * — and the handle minimum is three anyway, so nothing real is lost.
 */
const MIN_IDENTIFIER_MATCH_LENGTH = 3

function containsIdentifier(loweredPassword: string, identifier: string | undefined): boolean {
  if (identifier === undefined) return false
  if (identifier.length < MIN_IDENTIFIER_MATCH_LENGTH) return false
  return loweredPassword.includes(identifier)
}

/**
 * Reject the obvious. Nothing here is a strength score.
 *
 * A real breach-corpus check — the k-anonymity range query against a compromised-password service
 * — belongs in the identity service, because it needs network I/O and this package has none. What
 * can be decided from the input alone is decided here: length, a password that is one character
 * repeated, and a password that is the user's own handle or email local part. Those three are
 * what people actually type, and they are the ones a corpus check would flag anyway.
 *
 * Length is counted in **code points**, not UTF-16 units, so a passphrase of emoji or of any
 * non-BMP script is not silently held to half the stated limit.
 */
export function checkPassword(
  value: unknown,
  context: PasswordContext = {},
  field = 'password',
): Validated<string> {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, errors: [fieldError(field, 'required', 'A password is required.')] }
  }
  const errors: FieldError[] = []
  const codePoints = [...value]
  if (codePoints.length < PASSWORD_MIN_LENGTH) {
    errors.push(
      fieldError(field, 'too_short', `A password must be at least ${PASSWORD_MIN_LENGTH} characters.`),
    )
  }
  if (codePoints.length > PASSWORD_MAX_LENGTH) {
    errors.push(
      fieldError(field, 'too_long', `A password may be at most ${PASSWORD_MAX_LENGTH} characters.`),
    )
  }
  if (new Set(codePoints).size === 1) {
    errors.push(fieldError(field, 'repetitive', 'A password cannot be one character repeated.'))
  }

  const lowered = value.toLowerCase()
  const handle = context.handle?.trim().toLowerCase()
  if (containsIdentifier(lowered, handle)) {
    errors.push(fieldError(field, 'contains_handle', 'A password cannot contain your handle.'))
  }
  const localPart = context.email === undefined ? undefined : normaliseEmail(context.email).split('@')[0]
  if (containsIdentifier(lowered, localPart)) {
    errors.push(
      fieldError(field, 'contains_email', 'A password cannot contain the first part of your email address.'),
    )
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}

export interface RegistrationInput {
  /** Already normalised. This is the value that must be written. */
  readonly email: string
  /** As typed, for display. */
  readonly handle: string
  /** Lowercased. This is the value the uniqueness index is on. */
  readonly handleKey: string
  readonly password: string
}

/**
 * Validate a registration body.
 *
 * The password is checked **last and with the other two fields as context**, so "your password
 * contains your handle" is only reported when there is a handle to contain. Reporting it against
 * a rejected handle would be noise on a form that already has an error on that field.
 */
export function validateRegistration(input: unknown): Validated<RegistrationInput> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: [fieldError('body', 'invalid', 'Expected an object.')] }
  }
  const body = input as Record<string, unknown>
  const errors: FieldError[] = []

  const email = validateEmail(body['email'])
  if (!email.ok) errors.push(...email.errors)
  const handle = validateHandle(body['handle'])
  if (!handle.ok) errors.push(...handle.errors)

  const context: PasswordContext = {
    ...(handle.ok ? { handle: handle.value } : {}),
    ...(email.ok ? { email: email.value } : {}),
  }
  const password = checkPassword(body['password'], context)
  if (!password.ok) errors.push(...password.errors)

  if (!email.ok || !handle.ok || !password.ok) return { ok: false, errors }
  return {
    ok: true,
    value: {
      email: email.value,
      handle: handle.value,
      handleKey: normaliseHandle(handle.value),
      password: password.value,
    },
  }
}

export interface LoginInput {
  /** Normalised for lookup: an email is lowercased, a handle is lowercased to its uniqueness key. */
  readonly identifier: string
  readonly identifierKind: 'email' | 'handle'
  readonly password: string
}

/**
 * Validate a login body.
 *
 * The identifier goes through exactly the same normalisation as registration did. That equality
 * is the whole point: an account created from `Sam@Example.com` must be reachable by every path
 * that address can be typed into, and the reason it is not today is that three code paths each
 * normalised differently.
 *
 * The password is checked for presence only. Applying strength rules at login would reject users
 * whose password predates the rules, and would tell an attacker which candidate passwords are
 * worth trying.
 */
export function validateLogin(input: unknown): Validated<LoginInput> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: [fieldError('body', 'invalid', 'Expected an object.')] }
  }
  const body = input as Record<string, unknown>
  const errors: FieldError[] = []

  const raw = body['identifier']
  let identifier = ''
  let identifierKind: 'email' | 'handle' = 'handle'
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(fieldError('identifier', 'required', 'An email address or handle is required.'))
  } else if (raw.includes('@')) {
    identifierKind = 'email'
    const email = validateEmail(raw, 'identifier')
    if (!email.ok) errors.push(...email.errors)
    else identifier = email.value
  } else {
    const handle = validateHandle(raw, 'identifier')
    if (!handle.ok) errors.push(...handle.errors)
    else identifier = normaliseHandle(handle.value)
  }

  const password = body['password']
  if (typeof password !== 'string' || password === '') {
    errors.push(fieldError('password', 'required', 'A password is required.'))
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { identifier, identifierKind, password: password as string } }
}
