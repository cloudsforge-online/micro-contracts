# The four packages that were planned, and what was decided about each

[11-data-and-contract-strategy.md](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/11-data-and-contract-strategy.md)
§2 lists eight contract packages. Four were cut — `-auth`, `-chain`, `-events`, `-money`. Four were
not: `-market`, `-worlds`, `-create`, `-devplatform`. `18-build-status.md` records the second
group as "not yet cut", which reads as a backlog item and had been read that way for months.

It is not a backlog item. Three of the four should not be cut, and this file is the evidence that
decided each, so the question is not reopened by the next reader of that table.

## The test

§1 of doc 11 states the rule a contract package exists to serve: a contract is a **published,
versioned artifact**, and the cost it buys off is a shape held in two places that drift. So the test
applied here is **do two or more repositories currently hold the same shape** — and a package with
one consumer is indirection, not a contract. This estate's standing preference is against
abstractions that exist only for symmetry, and four packages cut so that a table reads complete
would be exactly that.

Every claim below was re-checked against source on 2026-08-03 and is cited `path:line`.

---

## `contracts-worlds` — **CUT**

Three shapes, each held in two or more repositories, and **all three are wrong today**. This is the
only one of the four where the absence of the package has already cost the estate a working feature.

| Shape | Held in | Held in |
| --- | --- | --- |
| The provision request/result | `worlds/src/titleclient.ts` (`ProvisionRequest`, `ProvisionResult`) | `aetherholm/src/provisioning.ts` (`ProvisionInput`, `ProvisionOutcome`) — field for field |
| The achievement post | `nda/src/worldsclient.ts` | `emberkin/src/worldsclient.ts` — 89 lines each, differing in **one word of one comment** |
| The capability vocabulary | `worlds/src/titles.ts` (a closed union) | `aetherholm/src/server.ts` (a bare string literal, unchecked) |

The achievement path is broken in three independent ways, and the duplication is why nobody noticed:

1. **The route does not exist.** Both clients `POST /internal/achievements`
   (`nda/src/worldsclient.ts`, `emberkin/src/worldsclient.ts`). `worlds/src/server.ts` defines
   22 routes (–) and none of them is that one; the unlock route is
   `POST /v1/titles/:id/achievements/unlock`. A 404 is a 4xx, so `HttpError.peerDecided` is
   true, so the client raises `WorldsRefusedError`, which `nda/src/achievements.ts` records as
   the terminal outcome `'refused'` and never retries. Every cross-title badge is dropped, quietly.
2. **The scope is wrong.** Both clients declare `WORLDS_SCOPES = ['worlds:write']` ( in each).
   The route demands `worlds:title` (`worlds/src/server.ts`, constant). Fixing (1)
   alone turns a 404 into a 403 — still terminal, still silent.
3. **The identifier is a different kind of thing.** The clients send `titleSlug` in the body;
   `itemIdOf` (`worlds/src/server.ts`) refuses anything that is not a UUID before the
   handler runs. The field is spelled `code` by the senders and `key` by the server.

**The guard.** All three defects are agreements about *bytes* that no build ever saw both halves of,
so a types-only package would have caught none of them. Every wire document in `worlds/` therefore
ships as a `serialise`/`parse` **pair**, and `index.test.ts` drives the sender's output into the
receiver's parser and back — a rename on either side moves the keys and the round-trip goes red. The
field lists are pinned besides, and `SCOPE_FOR` is checked against `contracts-auth`'s
`LIVE_SCOPE_NAMES` read from disk, so a scope that does not exist, or one deprecated out of the live
set, cannot be named here. Each of those five guards was broken deliberately and observed failing
before this landed.

**Scope deliberately narrowed.** Doc 11 §2 also assigns this package `player_profile`,
`inventory_item`, the `bound` flag and the season shapes. They are **not** included: `worlds` is the
only repository that has them, so they fail the two-repository test. They come here the day a second
reader appears, which is additive and costs nothing.

---

## `contracts-market` — **NOT CUT**

One repository holds the listing, offer, order and dispute shapes: `market`. Nothing else in the
estate has a copy, and no service has a market client at all (`ls */src/*client*.ts` returns 25
files; none is `marketclient.ts`).

The four other repositories that mention market touch only the **topic name**, which
`contracts-events` already owns:

* `activity/src/classify.ts` — `'market.listing.sold'`
* `analytics/src/catalogue.ts` — the same topic
* `beacon/src/estate.ts` — a catalogue entry
* `community/src/outbox.ts` — the topic in a worked example, in a comment

The only second copy of the shapes is `market-web/src/lib/market.ts`, a **frontend**, and it
already cites the serving line it was written from (`` `ListingStatus` — `listings.ts` ``). Doc 11
§2 is explicit about that case: the product registry moves to `@cloudsforge/ui` rather than to a
contracts package "because its consumers are frontends and CI, not services". The same reasoning
applies here, and the `verifiedAt` citation discipline `micro-sdk` uses is the mechanism the estate
already chose for a frontend reading a service's vocabulary.

Cutting this package would produce one publisher, one consumer and a release ceremony between them.

---

## `contracts-create` — **NOT CUT**

Its four planned contents each fail the test, three of them for different reasons.

* **`SUPPORTED_CHAINS` is already `contracts-chain`.** `mint/src/chains.ts` says so in
  terms — "Every chain id comes from `@cloudsforge/contracts-chain` and nothing here redefines one"
  — and imports `chainSpec`, `AssetCode`, `ChainFamily` and `Network` from it. The local
  `ChainId` is a deliberately *different* thing (this service's URL slug, which disagrees
  with custody's chain name on exactly one of five values) and is documented as such.
* **Token order and deployment lifecycle live only in `mint`.** No second repository has them.
* **Brand kit lives only in `studio`.** `mint/src/tokens.ts` holds `brandKitId` as an opaque
  `string | null` — a reference, never the shape, which is the pattern doc 11 §7 prescribes.
* **Asset kind and spec live only in `studio`, and the three repositories that read them read the
  source rather than copying it.** `brand`, `emberkin-assets` and `aetherholm-assets` each import
  `../studio/src/specs.ts` (`brand/prompts.ts`, `emberkin-assets/generate.ts`,
  `aetherholm-assets/generate.ts`). That is a path import across a repository boundary, which §1
  forbids — but all three are **build-time asset generators, not deployables**: they ship PNGs and a
  provenance manifest, they are `private: true`, they have no `node_modules` of their own, and every
  one of them documents the arrangement and its consequence in a `_noDependencies` block in its
  `package.json`. There is one copy of the knowledge, which is what the rule is for. Publishing
  `studio`'s verified FLUX endpoint facts as a versioned artifact would add a release ceremony
  between a service and three scripts that already read its source and cannot skew from it.

Three homonyms are worth naming so the next grep does not read them as duplication: `AssetKind` in
`market/src/listings.ts` (what kind of thing is listed), in `indexer/src/store.ts`
(`'native' | 'token'`) and in `sdk/packages/sdk/src/types.ts` (`string`) are three unrelated
types that share a name.

---

## `contracts-devplatform` — **NOT CUT**

Its largest planned content is **already contracted, in `contracts-events`**. The webhook signature
scheme — `t=<unix>,v1=<hex>` over `<unix>.<body>`, with `SIGNATURE_HEADER` — is `signDelivery` /
`verifyDelivery` in `contracts/packages/events`, and both services that send third-party webhooks
import it rather than reimplementing it: `notify/src/webhook.ts` and `devplatform/src/outbox.ts`
(`signEvent` and `verifyEventSignature` are thin adapters over it). That
is the duplication a contracts package exists to prevent, already prevented.

The remainder has one consumer:

* API key and OAuth client shapes — `devplatform` only.
* Quota and usage records — `devplatform` only. Nothing else in the estate reads
  `DEVPLATFORM_URL`, and the "gateway" doc 11 §9 names as a key-validation consumer does not exist
  as a repository.
* The public REST surface is explicitly **not** this package's (doc 11 §2, "that is
  `cloudsforge-sdk`, generated from OpenAPI"), and `micro-sdk` has **zero runtime dependencies** by
  design — a public package cannot `link:` a private one — so it could not consume this even if it
  were cut.

The one live claim in the estate that this package is needed is
`devplatform/src/scopes.ts`, which argues the *public* scope vocabulary is a different, smaller
set from `contracts-auth`'s service scopes and belongs here. That argument is correct about the two
sets being different, and it stays correct with the vocabulary where it is: `devplatform` is the only
service that issues, stores or checks a public scope, and `devportal-web/src/lib/devplatform.ts` is a
frontend, which is the `market-web` case above. The comment should be re-pointed at this file rather
than at a package that is not coming; that is a change in a repository this session does not own, so
it is reported rather than made.

---

## What `18-build-status.md` should now say

> `micro-contracts` — Five packages built (`-chain`, `-events`, `-money`, `-auth`, `-worlds`).
> `-market`, `-create` and `-devplatform` were assessed and **deliberately not cut**: each has one
> consuming service, and `-devplatform`'s webhook signature scheme is already in `-events`. The
> evidence is in `contracts/packages/README.md`. The plan's eight-package figure is superseded.

`micro-docs` is not owned by this session, so that correction is reported rather than made.
