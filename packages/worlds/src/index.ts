/**
 * The Forge Worlds contract: the title-service protocol, in one spelling.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS PACKAGE EXISTS, AND WHY IT IS NOT SYMMETRY.**
 *
 * 11-data-and-contract-strategy §2 planned four packages that were never cut. Three of them are
 * still not cut, and `packages/README.md` in this repository records the duplication evidence that
 * decided each. This one is cut because the estate is **already broken in three independent ways
 * by the absence of it**, and every one of the three is a shape held in two repositories that
 * disagree.
 *
 *   1. **The achievement route does not exist.** `nda/src/worldsclient.ts` and
 *      `emberkin/src/worldsclient.ts` both `POST /internal/achievements`. `worlds/src/server.ts`
 *      defines 22 routes (–) and none of them is `/internal/achievements`; the route
 *      that unlocks an achievement is `POST /v1/titles/:id/achievements/unlock`. A 404 is
 *      a 4xx, so `HttpError.peerDecided` is true, so both clients raise `WorldsRefusedError`, which
 *      `nda/src/achievements.ts` records as the terminal outcome `'refused'` and never retries.
 *      Every cross-title badge in the estate is dropped, permanently and quietly.
 *
 *   2. **The scope is wrong.** Both clients declare `WORLDS_SCOPES = ['worlds:write']`
 *      (`nda/src/worldsclient.ts`, `emberkin/src/worldsclient.ts`). The unlock route demands
 *      `worlds:title` (`worlds/src/server.ts`, constant). Fixing (1) alone would
 *      turn a 404 into a 403 — still terminal, still silent.
 *
 *   3. **The identifier is a different kind of thing.** The clients send `titleSlug` in the body;
 *      `itemIdOf` (`worlds/src/server.ts`) refuses anything that is not a UUID and answers
 *      404. And the field is spelled `code` on the sending side and `key` on the serving side
 *      (`worlds/src/server.ts`).
 *
 * Two title services hold byte-identical 89-line copies of that client — `nda/src/worldsclient.ts`
 * and `emberkin/src/worldsclient.ts` differ in exactly one word of one comment — so the estate
 * duplicated the mistake rather than catching it. That is the test 11 §1 sets for a contract
 * package, met three times over.
 *
 * The provision half is the same story with a happier ending so far: `ProvisionRequest` /
 * `ProvisionResult` at `worlds/src/titleclient.ts` and `ProvisionInput` / `ProvisionOutcome`
 * at `aetherholm/src/provisioning.ts` are field-for-field the same seven and two fields under
 * two names in two repositories. They agree today because one author wrote both within a week.
 *
 * ## What this package deliberately does NOT own
 *
 * 11 §2 also assigns it `player_profile`, `inventory_item`, the `bound` flag and the season shapes.
 * Those are **not** here, because `worlds` is the only repository that has them: no other service
 * reads a profile or an inventory item over the wire today. A contract package with one consumer is
 * indirection, and the estate's preference against abstractions that exist only for symmetry is
 * explicit. They come here the day a second reader appears, which is additive and costs nothing.
 *
 * ## The guard
 *
 * A types-only package cannot catch any of the three defects above — all three are agreements about
 * **bytes**, and TypeScript never saw both halves. So every wire document here ships as a
 * `serialise` / `parse` **pair**, and `index.test.ts` drives the sender's output into the
 * receiver's parser and back. Break either half and the round-trip goes red. The field lists are
 * pinned besides, so a rename cannot land without a reader seeing the whole document change, and
 * `SCOPE_FOR` is checked against `@cloudsforge/contracts-auth`'s live registry so a scope that does
 * not exist cannot be named here.
 *
 * Zero runtime dependencies.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface Invalid {
  readonly ok: false
  /** Every problem found, not just the first — the same rule `contracts-events` follows. */
  readonly errors: readonly string[]
}

export type Validated<T> = { readonly ok: true; readonly value: T } | Invalid

function invalid(errors: readonly string[]): Invalid {
  return { ok: false, errors }
}

function asObject(body: unknown, what: string): Validated<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid([`${what}: expected a JSON object`])
  }
  return { ok: true, value: body as Record<string, unknown> }
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  errors: string[],
): string {
  const value = body[field]
  if (typeof value !== 'string') {
    errors.push(`${field}: expected a string, got ${typeof value}`)
    return ''
  }
  // An empty string is the shape a bug takes — an interpolation whose value was undefined, or a
  // form field that was never filled. It types correctly, so only a runtime check catches it.
  if (value.trim().length === 0) {
    errors.push(`${field}: is empty`)
    return ''
  }
  return value
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a title can be asked to do.
 *
 * A closed set rather than free text, for the reason `worlds/src/titles.ts` gives: these are
 * read by the provisioning bridge to decide whether a purchase can be delivered at all, so free
 * text turns a typo in a registration into a purchase that is accepted and never provisioned.
 *
 * The registry lives here rather than in `worlds` because the typo is made at the OTHER end.
 * `aetherholm/src/server.ts` builds its descriptor from a bare string literal —
 * `capabilities: Object.freeze(['private_world'])` — with nothing to check it against, which is
 * exactly the gap `worlds/src/conformance.ts` check 4 exists to notice after the fact.
 */
export type Capability = 'private_world' | 'cosmetics' | 'achievements' | 'seasons' | 'inventory'

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  'private_world',
  'cosmetics',
  'achievements',
  'seasons',
  'inventory',
])

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * The scope each operation's SERVER demands — taken from the server, never from the client.
 *
 * This map is the fix for defect 2 in the file header. Both title clients guessed `worlds:write`,
 * which is the scope a *player-facing* write needs; a title service acts under `worlds:title`
 * (`worlds/src/server.ts`), a separate authority precisely so that a title's credential cannot
 * edit a player's profile.
 *
 * Every value is checked against `@cloudsforge/contracts-auth`'s live registry by `index.test.ts`,
 * so a scope that does not exist — or one that has been deprecated out of `LIVE_SCOPE_NAMES` —
 * cannot be named here.
 */
export type WorldsScope = 'worlds:read' | 'worlds:write' | 'worlds:title' | 'worlds:admin'

/**
 * The operations that cross a repository boundary. Not every route worlds serves: only the ones a
 * second repository calls, which is the only set a contract can be wrong about.
 */
export type WorldsOperation =
  /** `PUT /v1/titles/:id/achievements` — a title declares an achievement it can award. */
  | 'defineAchievement'
  /** `POST /v1/titles/:id/achievements/unlock` — a title awards one. */
  | 'unlockAchievement'
  /** `POST /v1/titles` — registration. Held by an administrator, never by a title. */
  | 'registerTitle'

export const WORLDS_OPERATIONS: readonly WorldsOperation[] = Object.freeze([
  'defineAchievement',
  'unlockAchievement',
  'registerTitle',
])

export const SCOPE_FOR: Readonly<Record<WorldsOperation, WorldsScope>> = Object.freeze({
  // worlds/src/server.ts — `requireScope(principal, TITLE_SCOPE)`.
  defineAchievement: 'worlds:title',
  // worlds/src/server.ts — the same gate. NOT `worlds:write`; see the file header.
  unlockAchievement: 'worlds:title',
  // worlds/src/server.ts — the registry is an administrator's surface.
  registerTitle: 'worlds:admin',
})

/**
 * The scope worlds' own credential must carry when it calls a title.
 *
 * Read from the title's side: `aetherholm/src/server.ts` names `aetherholm:provision`, and a
 * title checks it rather than assuming it (`titlecontract.test.ts` contract 8/9). The scope is
 * therefore `<title slug>:provision`, derived rather than enumerated, because a title added
 * tomorrow must not need a release of this package to be callable.
 */
export function provisionScopeFor(titleSlug: string): string {
  return `${titleSlug}:provision`
}

// ---------------------------------------------------------------------------
// URNs
// ---------------------------------------------------------------------------

/**
 * `cf:<title>:<kind>:<id>` — what a title made, in a form anything in the estate can point at.
 *
 * `worlds/src/titleclient.ts` documents the shape and nothing validates it; a 2xx carrying a urn
 * of the wrong shape is recorded and pointed at for ever. `aetherholm/src/provisioning.ts`
 * builds one by template literal, which is correct today and unchecked.
 */
export interface TitleUrn {
  readonly title: string
  readonly kind: string
  readonly id: string
}

export function titleUrn(urn: TitleUrn): string {
  return `cf:${urn.title}:${urn.kind}:${urn.id}`
}

const URN_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/

export function parseTitleUrn(value: string): Validated<TitleUrn> {
  const parts = value.split(':')
  if (parts.length !== 4 || parts[0] !== 'cf') {
    return invalid([`urn: expected "cf:<title>:<kind>:<id>", got "${value}"`])
  }
  const [, title, kind, id] = parts as [string, string, string, string]
  const errors: string[] = []
  if (!URN_SEGMENT.test(title)) errors.push(`urn: "${title}" is not a title slug`)
  if (!URN_SEGMENT.test(kind)) errors.push(`urn: "${kind}" is not a kind`)
  if (id.length === 0) errors.push('urn: carries no id')
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: { title, kind, id } }
}

// ---------------------------------------------------------------------------
// The title descriptor — worlds calls the title
// ---------------------------------------------------------------------------

/** `GET /v1/title`. Public and unauthenticated: a descriptor is a capability statement. */
export const TITLE_DESCRIPTOR_PATH = '/v1/title'

export interface TitleDescriptor {
  readonly slug: string
  readonly name: string
  readonly capabilities: readonly Capability[]
}

export const TITLE_DESCRIPTOR_FIELDS: readonly string[] = Object.freeze([
  'slug',
  'name',
  'capabilities',
])

export function serialiseTitleDescriptor(descriptor: TitleDescriptor): Record<string, unknown> {
  return {
    slug: descriptor.slug,
    name: descriptor.name,
    capabilities: [...descriptor.capabilities],
  }
}

/**
 * Read a descriptor, and refuse a capability the registry does not know.
 *
 * This is the check that makes a typo'd capability a failed registration rather than a purchase
 * that is accepted and never delivered. `worlds/src/titleclient.ts` accepts any string
 * array today.
 */
export function parseTitleDescriptor(body: unknown): Validated<TitleDescriptor> {
  const object = asObject(body, 'descriptor')
  if (!object.ok) return object
  const errors: string[] = []
  const slug = requiredString(object.value, 'slug', errors)
  const name = requiredString(object.value, 'name', errors)
  if (slug !== '' && !URN_SEGMENT.test(slug)) {
    errors.push(`slug: "${slug}" is not a title slug — lowercase, digits, dash and underscore`)
  }
  const raw = object.value['capabilities']
  const capabilities: Capability[] = []
  if (!Array.isArray(raw)) {
    errors.push('capabilities: expected an array')
  } else {
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        errors.push('capabilities: every entry must be a string')
        continue
      }
      // Not ignored the way an unknown FIELD is ignored. An unknown field is a producer running
      // ahead, which AD-02 makes safe; an unknown capability is a claim to sell something, and
      // accepting it is how the purchase gets taken.
      if (!isCapability(entry)) {
        errors.push(`capabilities: "${entry}" is not a registered capability`)
        continue
      }
      capabilities.push(entry)
    }
  }
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: { slug, name, capabilities } }
}

// ---------------------------------------------------------------------------
// Provisioning — worlds calls the title
// ---------------------------------------------------------------------------

/** `POST /v1/provision`. Service token only, scope `<slug>:provision`. */
export const PROVISION_PATH = '/v1/provision'

/**
 * The bridge's request. Seven fields, and the entitlement id is the idempotency key.
 *
 * `worlds/src/titleclient.ts` and `aetherholm/src/provisioning.ts` are this interface
 * under two names in two repositories.
 */
export interface ProvisionRequest {
  /** The idempotency key of the whole bridge. Stable across redelivery, retry and replica. */
  readonly entitlementId: string
  readonly subject: string
  readonly userId: string
  readonly sku: string
  readonly scope: string
  /** Whatever billing carried on the grant — a world name, a season length, a player cap. */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Carried as the request id header, not in the body. See `serialiseProvisionRequest`. */
  readonly correlationId: string
}

/**
 * The wire fields, pinned — and `correlationId` is deliberately not one of them.
 *
 * `worlds/src/titleclient.ts` sends six body fields and passes the correlation id as the
 * request id header instead. A receiver that made `correlationId` a required body field would 400
 * every real request from the bridge, and would pass every test written from the interface.
 */
export const PROVISION_REQUEST_FIELDS: readonly string[] = Object.freeze([
  'entitlementId',
  'subject',
  'userId',
  'sku',
  'scope',
  'metadata',
])

export function serialiseProvisionRequest(request: ProvisionRequest): Record<string, unknown> {
  return {
    entitlementId: request.entitlementId,
    subject: request.subject,
    userId: request.userId,
    sku: request.sku,
    scope: request.scope,
    metadata: { ...request.metadata },
  }
}

/**
 * The idempotency key, in one place.
 *
 * Sent in the `Idempotency-Key` header AND repeated in the body, for the two different reasons
 * `worlds/src/titleclient.ts` gives: the header is what makes a POST retriable at all, the
 * body field is what the title stores and dedupes on. A title that derives its key from anything
 * else raises a second world for one purchase.
 */
export function provisionIdempotencyKey(request: Pick<ProvisionRequest, 'entitlementId'>): string {
  return request.entitlementId
}

/**
 * Read a provision request. `correlationId` comes from the request id header, which the caller
 * passes here because it is not on the wire in the body.
 */
export function parseProvisionRequest(
  body: unknown,
  correlationId: string,
): Validated<ProvisionRequest> {
  const object = asObject(body, 'provision')
  if (!object.ok) return object
  const errors: string[] = []
  const entitlementId = requiredString(object.value, 'entitlementId', errors)
  const subject = requiredString(object.value, 'subject', errors)
  const userId = requiredString(object.value, 'userId', errors)
  const sku = requiredString(object.value, 'sku', errors)
  const scope = requiredString(object.value, 'scope', errors)
  const metadata = object.value['metadata']
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    errors.push('metadata: expected a JSON object')
  }
  if (correlationId.trim().length === 0) errors.push('correlationId: is empty')
  if (errors.length > 0) return invalid(errors)
  return {
    ok: true,
    value: {
      entitlementId,
      subject,
      userId,
      sku,
      scope,
      metadata: metadata as Record<string, unknown>,
      correlationId,
    },
  }
}

export interface ProvisionResult {
  /** `cf:<title>:<kind>:<id>`. */
  readonly urn: string
  /** True when the title recognised the key and returned what it had already made. */
  readonly replayed: boolean
}

export const PROVISION_RESULT_FIELDS: readonly string[] = Object.freeze(['urn', 'replayed'])

export function serialiseProvisionResult(result: ProvisionResult): Record<string, unknown> {
  return { urn: result.urn, replayed: result.replayed }
}

/**
 * Read a provision result.
 *
 * A 2xx with no urn is a title claiming a success it cannot name, and is treated as an outage
 * rather than a success — `worlds/src/titleclient.ts` already does this, for the reason
 * that recording `provisioned` with no urn would break `provisions_provisioned_is_complete`
 * anyway. The urn's SHAPE is checked here too, which is new: an ill-formed urn is stored and
 * pointed at for ever.
 *
 * `replayed` defaults to false when absent, and is false for anything that is not literally `true`.
 * That direction is the safe one: treating an unknown value as "already existed" would let a title
 * that returned garbage suppress the first real provision.
 */
export function parseProvisionResult(body: unknown): Validated<ProvisionResult> {
  const object = asObject(body, 'provision result')
  if (!object.ok) return object
  const errors: string[] = []
  const urn = requiredString(object.value, 'urn', errors)
  if (urn !== '') {
    const parsed = parseTitleUrn(urn)
    if (!parsed.ok) errors.push(...parsed.errors)
  }
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: { urn, replayed: object.value['replayed'] === true } }
}

/**
 * The title asked for something it does not sell: 422, code `unsupported`.
 *
 * An ANSWER, not a fault. `worlds/src/titleclient.ts` treats it as terminal and stops
 * retrying, which is right: retrying is guaranteed to fail again, and burning the attempt budget on
 * it hides the case an operator needs to see — a customer paid for something that cannot be
 * delivered, which is a catalogue mistake and a refund.
 */
export const UNSUPPORTED_STATUS = 422
export const UNSUPPORTED_CODE = 'unsupported'

// ---------------------------------------------------------------------------
// Achievements — the title calls worlds
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The title's id is a **UUID in the path**, not a slug in the body.
 *
 * `worlds/src/server.ts` answers 404 to anything else, before the handler runs. Both title
 * clients send `titleSlug` in the body and address a route that does not exist; a title that
 * adopts this package gets a local, named failure instead of a 404 it will record as permanent.
 */
export function isTitleId(value: string): boolean {
  return UUID.test(value)
}

/** `PUT /v1/titles/:id/achievements` — a title declares an achievement it can award. */
export function achievementDefinePath(titleId: string): string {
  return `/v1/titles/${titleId}/achievements`
}

/** `POST /v1/titles/:id/achievements/unlock` — a title awards one. */
export function achievementUnlockPath(titleId: string): string {
  return `/v1/titles/${titleId}/achievements/unlock`
}

/**
 * An achievement a title can award.
 *
 * It must be DEFINED before it can be unlocked: `worlds/src/rewards.ts` looks it up by
 * `(titleId, key)` and refuses when there is none. Both title clients send `name` and `points` on
 * the unlock instead, which is a client that believes worlds will create the achievement for it.
 * Two calls, two documents, and this is the first of them.
 */
export interface AchievementDefinition {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly points: number
  /** Money is `bigint`. On the wire it is a decimal string; see `parseShards`. */
  readonly rewardShards: bigint
}

export const ACHIEVEMENT_DEFINITION_FIELDS: readonly string[] = Object.freeze([
  'key',
  'name',
  'description',
  'points',
  'rewardShards',
])

export function serialiseAchievementDefinition(
  definition: AchievementDefinition,
): Record<string, unknown> {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    points: definition.points,
    // A string, never a number: `rewardShards` is a bigint and `JSON.stringify` throws on one,
    // while `Number(shards)` silently loses precision above 2^53.
    rewardShards: definition.rewardShards.toString(),
  }
}

/**
 * Read Shards off the wire.
 *
 * **`BigInt('')` is `0n`**, and that is the whole reason this function exists rather than a bare
 * cast. An empty string is what a missing field, an unset form input and a failed interpolation all
 * look like, and every one of them would become a legitimate-looking reward of zero. So is a bare
 * `-`, which `BigInt` also rejects but only by throwing.
 */
export function parseShards(value: unknown, field: string): Validated<bigint> {
  if (typeof value !== 'string') return invalid([`${field}: expected a decimal string`])
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return invalid([`${field}: "${value}" is not a non-negative decimal integer`])
  }
  return { ok: true, value: BigInt(value) }
}

export function parseAchievementDefinition(body: unknown): Validated<AchievementDefinition> {
  const object = asObject(body, 'achievement')
  if (!object.ok) return object
  const errors: string[] = []
  const key = requiredString(object.value, 'key', errors)
  const name = requiredString(object.value, 'name', errors)
  const description = object.value['description']
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description: expected a string')
  }
  const points = object.value['points']
  if (typeof points !== 'number' || !Number.isInteger(points) || points < 0) {
    errors.push('points: expected a non-negative integer')
  }
  const reward = parseShards(object.value['rewardShards'] ?? '0', 'rewardShards')
  if (!reward.ok) errors.push(...reward.errors)
  if (errors.length > 0) return invalid(errors)
  return {
    ok: true,
    value: {
      key,
      name,
      description: typeof description === 'string' ? description : '',
      points: points as number,
      rewardShards: reward.ok ? reward.value : 0n,
    },
  }
}

/**
 * The unlock. Two fields, and the title is in the path.
 *
 * `worlds/src/server.ts` reads exactly `userId` and `key`; the title comes from
 * `itemIdOf(ctx)`. The clients spell the second field `code`.
 */
export interface AchievementUnlock {
  readonly userId: string
  readonly key: string
}

export const ACHIEVEMENT_UNLOCK_FIELDS: readonly string[] = Object.freeze(['userId', 'key'])

export function serialiseAchievementUnlock(unlock: AchievementUnlock): Record<string, unknown> {
  return { userId: unlock.userId, key: unlock.key }
}

export function parseAchievementUnlock(body: unknown): Validated<AchievementUnlock> {
  const object = asObject(body, 'unlock')
  if (!object.ok) return object
  const errors: string[] = []
  const userId = requiredString(object.value, 'userId', errors)
  const key = requiredString(object.value, 'key', errors)
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: { userId, key } }
}

/**
 * The unlock's idempotency key.
 *
 * Derived from `(titleId, userId, key)` and from nothing else — never from a job id, a row id or a
 * timestamp. A job that is retried, redelivered or run by a different replica must present the same
 * key, or worlds records the badge twice. `nda/src/achievements.ts` derives its own from
 * `(slug, userId, achId)`, which is the same intent with a different alphabet; one spelling is the
 * point of putting it here.
 */
export function achievementIdempotencyKey(unlock: AchievementUnlock & { titleId: string }): string {
  return `${unlock.titleId}:achievement:${unlock.userId}:${unlock.key}`
}

/**
 * What worlds answers.
 *
 * **201 on a fresh unlock, 200 on one that had already happened** (`worlds/src/server.ts`).
 * A title re-evaluating its achievements every tick can tell the difference from the status alone,
 * which is why `unlocked` is not the only signal — and why a client that treats any 2xx as "new
 * badge" will announce the same badge on every tick.
 */
export interface AchievementUnlockResult {
  readonly unlocked: boolean
  readonly key: string
}

export function parseAchievementUnlockResult(body: unknown): Validated<AchievementUnlockResult> {
  const object = asObject(body, 'unlock result')
  if (!object.ok) return object
  const achievement = object.value['achievement']
  if (typeof achievement !== 'object' || achievement === null || Array.isArray(achievement)) {
    return invalid(['achievement: expected a JSON object'])
  }
  const errors: string[] = []
  const key = requiredString(achievement as Record<string, unknown>, 'key', errors)
  if (typeof object.value['unlocked'] !== 'boolean') errors.push('unlocked: expected a boolean')
  if (errors.length > 0) return invalid(errors)
  return { ok: true, value: { unlocked: object.value['unlocked'] === true, key } }
}

/**
 * The status a fresh unlock carries, and the one a repeat carries.
 *
 * Exported as constants because both halves of the estate had to agree on them and neither wrote
 * them down: a receiver that only accepts 201 loses every replay, and one that treats 200 as new
 * announces every replay.
 */
export const UNLOCK_CREATED_STATUS = 201
export const UNLOCK_REPLAYED_STATUS = 200
