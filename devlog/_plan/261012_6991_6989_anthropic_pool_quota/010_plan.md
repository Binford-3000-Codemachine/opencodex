# 010 — Anthropic pool quota exhaustion: terminal usage limit (#6991) and fresh-read recovery (#6989)

Base: origin/dev dc45bb2ca9. Branch: codex/6989-6991-anthropic-pool-quota-261012.

## Evidence on dev

- #6991. Local pool refusals become a retryable 429 `rate_limit_error` / `rate_limit_exceeded` at four sites:
  `src/server/responses/request-transport.ts:786-793` (pool-enabled initial selection, `all-cooled`),
  `src/server/responses/adapter-dispatch.ts:528-530` and `:788-790` (`AnthropicAccountCooldownError` after pacing / on the recovery leg),
  `src/server/responses/passthrough-dispatch.ts:951-953`. `formatErrorResponse` (`src/bridge/errors.ts:19`) classifies every 429 as
  `rate_limit_exceeded` (`src/lib/errors.ts:448-458`) and has no slot for `resets_at`. The first exhausted request returns the upstream
  429 as `Provider error 429: ...` with `rate_limit_exceeded` (`adapter-dispatch.ts:1679-1722`) after `rotateAnthropicAccountOnRefusal`
  finds no replacement (`src/oauth/anthropic-routing.ts:1062-1073`).
- Codex (openai/codex 6c372fbe, `codex-api/src/api_bridge.rs:181-218`) treats HTTP 429 with `error.type == "usage_limit_reached"` as
  non-retryable `UsageLimitReached` and reads `resets_at` as integer epoch seconds; a wrapped WebSocket `error` frame reuses the same
  classifier (`responses_websocket.rs:591-662`). OpenCodex's WS bridge keeps the nested error object (`src/server/ws-bridge.ts:369-403`).
  Without `plan_type` Codex prints its generic usage-limit copy; a ChatGPT plan type would print ChatGPT upgrade copy, so none is sent.
- #6989. `captureAnthropicCooldownRecovery` and `settleAnthropicCooldownRecovery` (`anthropic-routing.ts:379-412`) only claim
  `cooldownSource === "reset-derived"`. A shared-quota 429 that carries Retry-After records source `retry-after` (`:1131-1141`), so a fresh
  usage read showing headroom never lifts it. #6953 already records `refusedQuotaWindows` for every 429 regardless of deadline source and
  its reset-grant admission documents this gap (`src/providers/anthropic-reset-admission.ts:4-8`).

## Classification rule (#6991)

`recordAnthropicAccountRefusal` only records a 429 health entry for a `shared-quota` classification; transient throttles become admission
pauses and family-only rejections become family evidence. For each account the pool would otherwise consider (same filter as
`getAnthropicPoolRetryAfterSeconds`, including route/fallback expansion), collect its blocks:

| Block | Until | Quota? |
|---|---|---|
| live health entry, refusalStatus 429 | cooldownUntil | yes (shared-quota by construction, any deadline source) |
| live health entry, refusalStatus 403 | cooldownUntil | no (entitlement) |
| admission pause (transient Retry-After) | pause until | no |
| family exclusion, not revalidating | family retry time | yes |
| family exclusion, revalidation in flight (busy) | now + 1 s | no |

The account is quota-held when its latest block is a quota block (ties favor transient). The pool answers `usage_limit_reached` only when
no route candidate is eligible and every blocked account is quota-held. `resets_at` (epoch seconds) is computed apart from the
admission order: per account, the latest upstream window reset over all its quota holds (unknown if any rejected window lacks a
reset header or a family has no reset), then the earliest across accounts, omitted when any held account is unknown. Retry-After
stays the admission deadline. Anything else keeps today's `rate_limit_error` / `rate_limit_exceeded` with Retry-After.

## Recovery rule (#6989)

A cooldown is claimable by a fresh usage read when it is live, `refusalStatus === 429`, and either source is `reset-derived` (unchanged) or
the refusal named at least one rejected window (`refusedQuotaWindows`). Settlement requires the same generation, `quota.updatedAt >=
claimedAt` (unchanged stale-read fence) and `percent < 100` for every window in `rejectedQuotaWindows` if present, else
`refusedQuotaWindows`. 403 refusals and windowless non-reset-derived 429s are never claimed; a reset-derived aggregate refusal stays
claimable as before but is always retained. Claimed probes already force a fresh dispatch
(`requiresFreshDispatch`), so a cached or joined older read cannot settle.

## Changes

1. `src/oauth/anthropic-routing.ts`: `AnthropicAccountCooldownError` gains `usageLimitResetsAt: number | null` and a usage-limit message
   that names the provider and the ISO reset. New instance method `anthropicPoolCooldownError(now, decision, model)` (classification above);
   `getAnthropicPoolRetryAfterSeconds` delegates to it; `resolveAnthropicDispatchAccountId` throws it. Add
   `anthropicPoolUsageLimitAfterRefusal(now, decision, model)` returning the error only when no route candidate is eligible and the verdict is
   a usage limit. Recovery claim/settle widened as above.
2. `src/bridge/errors.ts`: `formatUsageLimitReachedResponse(message, resetsAtMs, retryAfterSeconds)` building
   `{error:{message,type:"usage_limit_reached",code:"usage_limit_reached",resets_at}}` + Retry-After.
3. `src/server/responses/core-errors.ts`: `anthropicPoolCooldownResponse(err, comboAttempt)` — usage limit for direct requests, the existing
   `rate_limit_error` for combo children (combo failure handling rebuilds the body and `isAnthropicPoolLocalRefusal` deliberately keeps a
   short target cooldown; a `usage_limit_reached` code would stretch it to the 10-minute exhaustion fallback).
4. Use it at the four sites; at the final non-combo upstream 429 in `adapter-dispatch.ts` answer the usage limit only when
   `anthropicPoolUsageLimitAfterRefusal` proves it. Set `logCtx.errorCode = "usage_limit_reached"` where the usage limit is answered.
5. Native Messages keeps Anthropic `rate_limit_error`; its message now carries the usage-limit wording automatically.
6. `src/providers/anthropic-reset-admission.ts` comment, `structure/providers/anthropic-account-pool.md` (classified 429 admission +
   recovery), `structure/transports/responses-failover.md` local-cooldown sentence, docs-site providers guide if it states the old rule.

## Out of scope

Codex-account cooldown path (`src/codex/auth-context.ts`); dashboard reason label for retry-after quota cooldowns
(`src/oauth/health.ts:224`); combo final-error identity (`core-combo-failure.ts:109`); #6962 API-key billing pool (different file set).

## Tests (new file tests/oauth/anthropic-pool-quota-exhaustion.test.ts)

- all accounts 429 quota-held (reset-derived and retry-after sources) -> error has usageLimitResetsAt = earliest; HTTP builder yields
  `usage_limit_reached`, integer `resets_at`, Retry-After.
- one account transient-paused, or a 403 cooldown, or busy family -> rate-limit classification.
- server-level: pool-enabled Responses request with all accounts quota-held -> 429 `usage_limit_reached`; combo child keeps
  `rate_limit_exceeded`; first exhausted upstream 429 with no replacement -> `usage_limit_reached`.
- #6989: retry-after quota cooldown cleared by fresh read with headroom; retained when one rejected window still 100; superseded by a stale
  read (updatedAt < claimedAt); 403 and no-window 429 not claimed; default-source quota cooldown claimable.
- no account id or token in error bodies or warn logs.

## Verification

`bun run typecheck`, focused files above plus existing `tests/oauth/oauth-anthropic-instance-health.test.ts`,
`tests/adapters/anthropic/anthropic-instance-quota.test.ts`, `tests/adapters/anthropic/anthropic-instance-pool-parity.test.ts`,
`tests/routing/always-on-429-failover.test.ts`, `tests/adapters/anthropic/anthropic-429-policy.test.ts`, `bun run test:changed`,
`bun run structure:check`, `bun run privacy:scan`, `git diff --check`.

## Audit r1 (Sol, FAIL) resolution

1. Major, reset vs admission deadline — folded. 429 entries record `quotaResetAt` from the reset headers even when
   Retry-After set the deadline; family holds report the family window reset. `resets_at` is the earliest known reset and is
   omitted when any held account's reset is unknown; Retry-After stays the admission deadline. Busy-family uses a new accessor
   `anthropicFamilyHoldState`. Tests: unequal Retry-After/reset, missing reset, family.

## Audit r2 (Sol, FAIL) resolution

1. Partial reset headers — folded: `rejectedWindowsResetAt` requires a usable reset for every rejected window. Test added.
2. Reset vs admission winner — folded: `anthropicAccountHold` computes the quota reset over all quota holds independently of which
   hold wins admission. Test: shared Retry-After 10 min/reset 3 h plus family 30 min/reset 1 h reports 3 h.
3. Web-search sidecar — folded: `sidecar-execution.ts` replaces the loop's first-iteration 429 with the usage limit when
   `anthropicPoolUsageLimitAfterRefusal` proves exhaustion (non-combo). Server test fails without the hook. Image bridge,
   empty-completion continuation and Chat Completions remain documented boundaries.
4. Existing `anthropic-cooldown-recovery.test.ts` expectation — updated to the #6989 contract, with negative cases for windowless
   Retry-After and 403.
5. Plan text — reconciled above.
2. Minor, race coverage — added a read that starts before a Retry-After refusal and completes after it (stays cooled), stale
   claim, newer-refusal generation; existing credential-replacement and uncovered-reset tests continue to run.
3. Major, other surfaces — rebutted as scope: web-search/image sidecar terminals (only with an Anthropic sidecar backend), opt-in
   empty-completion continuations and Chat Completions translation are not the Codex Responses main path the issue reports.
   They keep today's rate-limit identity; documented as a boundary in structure and the PR. Compaction and WebSocket forward the
   response unchanged (`compact.ts:1486`, `ws-bridge.ts:369`).
4. Major, combo prose — folded. Combo children get `retryableMessage`, byte-identical to the old body; test asserts equality.
5. Minor, hook guards — the verdict requires no eligible route candidate (fallback expansion via `routeCandidates`), 429,
   non-combo, OAuth Anthropic instance; tests cover a throttled sibling, both instances and a model-scoped family.
6. Minor, #6962 overlap — the shared files are adapter-dispatch.ts, request-transport.ts (imports only here) and passthrough-dispatch;
   billing recovery is untouched. After rebase, run the billing send-budget/boundary tests if #6962 has landed.
7. Minor, tests/docs — layout tables registered; docs-site providers reference and two structure docs updated.
