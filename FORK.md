# Afreetoid Wanderlog MCP Fork

## Branch and deployment model

`main` is the only long-lived production branch. The local runtime at `/Users/afreetoid/workspace/wanderlog-mcp` tracks `origin/main`, and Hermes launches `dist/index.js` from that checkout.

- `origin`: `afreetoid/wanderlog-mcp`, the deployed fork.
- `upstream`: `shaikhspeare/wanderlog-mcp`, fetch-only source authority.
- `main`: customized, deployable, and the fork's default branch.
- `feature/*` and `fix/*`: short-lived branches created from `main`, reviewed and merged back into `main`, then deleted.
- `chore/upstream-YYYYMMDD`: short-lived integration branches that merge reviewed upstream changes into customized `main`.

There is no `prod` branch and no automated fork-sync workflow. Never move `main` automatically to `upstream/main`; upstream changes must be reviewed, reconciled, tested, and merged through an integration branch.

For changes intended for the original project, branch from `upstream/main` rather than customized `main`, then submit that clean branch upstream.

## Upstream base

The current customization is reconciled on upstream `main` commit `09b19e98ef0c2fe3f2976603ad40a352776ff865` (`Uplift add-note function to allow notes to be added in the Non-Itinerary section`).

That upstream change added named-section support to `add_note`. This fork preserves its useful cases while retaining the stricter shared destination architecture:

- `day` and `section` remain mutually exclusive instead of silently letting `section` override `day`.
- section resolution uses the shared ambiguity-aware resolver.
- destination selection and operation construction occur inside the per-trip lock from a fresh snapshot.
- note block insertion and rich-text insertion are submitted atomically.

## Keeper behavior

The fork keeps named custom-section targeting and scoping on top of upstream:

- `add_place`, `add_note`, and `add_checklist` accept one of `day` or `section`; omitting both preserves the upstream default destination.
- `edit_note`, `remove_note`, and `annotate_place` can be scoped to one day or named section.
- Duplicate headings require ordinal references such as `2nd Food` or `last Food`.
- Section lookup and mutation construction happen from the freshest cached snapshot inside the per-trip submit lock.
- Every production mutator that derives an array-backed JSON0 path—including itinerary, budget, and journal tools—builds that path inside the same per-trip lock; only low-level helper tests call `submitOp` directly.
- Custom rename/delete operations only allow mutable `normal` + `placeList` sections and protect days, the default list, text-only sections, system sections, and unknown future types.
- New and renamed headings must be non-empty, distinct, and must not begin with ordinal-reference syntax.
- Related JSON0 components are submitted atomically, including place metadata and rich-text replacement.
- Settled per-trip lock tails are identity-checked and evicted, including failed validation for bogus trip keys.
- If a remote ShareDB op arrives while a local submit is awaiting its acknowledgement, the acknowledged cache entry and pooled subscription are discarded instead of applying the untransformed original local operation; the next queued/read operation subscribes from a fresh server snapshot.
- Rate-limit retries abort with `stale_rate_limit_retry` if the remote document advances before resubmission.

## v0.4.0 contract

This fork intentionally tightens these pre-1.0 input contracts:

1. `day` and `section` are mutually exclusive. Existing callers that send both must choose one destination or scope; callers may still omit both where the default list is supported.
2. New custom-section headings and custom-section rename headings must contain non-whitespace text. Callers must validate or replace empty values before invoking `add_section` or `update_section`.

`rename_day` is unchanged from upstream; its existing empty-heading reset behavior remains supported.

The package minor version is `0.4.0` to signal these pre-1.0 breaking contracts.

## Development and release workflow

For a local feature:

1. Fetch `origin` and require clean `main`.
2. Create a short-lived branch from exact `origin/main`.
3. Implement with focused tests, then run the full non-credentialed validation suite.
4. Obtain independent security/correctness review.
5. Merge the reviewed branch into `main` without rewriting published `main` history.
6. Build and test `main`, push it, then update the live checkout to exact `origin/main` and rebuild `dist/`.
7. Verify Hermes MCP discovery and a read-only Wanderlog call before deleting the feature branch.

For an upstream update:

1. Fetch both remotes and inspect `main...upstream/main`.
2. Create `chore/upstream-YYYYMMDD` from current `main`.
3. Merge `upstream/main` into the integration branch; never auto-sync or force-reset customized `main`.
4. Reconcile keeper behavior by intent, update this file's upstream base, and run all validation.
5. Review and merge the integration branch into `main`, deploy exact `origin/main`, then delete the integration branch.

## Validation

Run without credentials or live mutating integration tests:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run lint
git diff --check
```

Do **not** run `npm run test:integration` as routine replay or release validation; it requires credentials and may mutate live Wanderlog data.

After deployment, run `hermes mcp test wanderlog` as a secret-safe fresh-process discovery check. Use only a read-only account call when live verification is necessary.

## Recovery

The pre-migration deployed `prod` commit is preserved locally by:

- `refs/heads/recovery/pre-single-main-20260823T084845Z`
- `refs/tags/recovery/pre-single-main-20260823T084845Z` (annotated tag)

These refs are historical rollback evidence only. Do not recreate a long-lived `prod` branch or automated clean-main sync topology.
