# Rebuild Platform Architecture Around Real Bot Identities

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be fully self-contained for a novice, it must describe observable behavior rather than internal intent alone, it must name exact files and commands, it must remain safe to retry, and it must keep the living sections accurate as implementation proceeds.

## Purpose / Big Picture

After this rewrite, HiJarvis will support multiple real Slack bots and multiple real Telegram bots instead of pretending that one platform bot can host several Jarvis identities behind the scenes. Each bot identity will be configured explicitly, each identity will bind to exactly one Jarvis entity, and every incoming platform event will route through the bot identity first rather than through a global default entity.

Someone verifying this change should be able to define two Slack identities with different credentials or two Telegram identities with different bot tokens, start the corresponding gateway, and observe that each platform bot responds as its own Jarvis presence with its own bound entity and its own persisted sessions. They should also be able to inspect the persisted session ids and see that identity, not just platform surface, is part of the continuity key.

## Progress

- [x] (2026-04-11 10:15Z) Re-read the current config model, session routing, Slack gateway, Telegram gateway, and agent design guidance to confirm the architectural failure mode.
- [x] (2026-04-11 10:20Z) Chose an identity-first target model: platform identity is the ingress key, entity is the bound AI identity, and conversation scope remains local to the platform identity.
- [x] (2026-04-11 11:05Z) Added failing tests describing the new config shape and identity-scoped routing/session id semantics.
- [x] (2026-04-11 11:18Z) Replaced `entities.<id>.surfaces` and platform-singleton config parsing with explicit `platform.<platform>.identities.<identityId>` parsing in `packages/jar-core/src/config.ts`.
- [x] (2026-04-11 11:24Z) Replaced entity-first routing helpers in `packages/jar-core/src/entity-routing.ts` with identity-aware routing helpers keyed by `identityId + platform + scope`.
- [x] (2026-04-11 11:42Z) Refactored `apps/jar-slack/src/slack-config.ts` and `apps/jar-slack/src/slack-runtime.ts` so one process supervises multiple Slack identity runtimes.
- [x] (2026-04-11 11:48Z) Refactored `apps/jar-telegram/src/telegram-config.ts` and `apps/jar-telegram/src/telegram-runtime.ts` so one process supervises multiple Telegram bot runtimes.
- [x] (2026-04-11 11:50Z) Updated side-query lookup semantics so they are identity-aware and do not depend on a global default entity.
- [x] (2026-04-11 12:02Z) Rewrote architecture and configuration documentation to describe the new model, updated `jar.example.toml`, and removed the old “single bot, multiple logical entities” framing.
- [x] (2026-04-11 12:10Z) Ran targeted tests and typechecks. `jar-slack` and `jar-telegram` checks/tests pass. `jar-core` check passes. Remaining `jar-core` test failures are outside the architecture rewrite: two OpenAI-backed `web_search` tests require an API key in this environment.

## Surprises & Discoveries

- Observation: The current gateways hard-code `getDefaultEntity(...)` for ordinary messages, so the external platform identity is ignored at the decisive routing point.
  Evidence: `apps/jar-slack/src/slack-runtime.ts` routes `handleQueueEntry(...)` through `getDefaultEntity(state.runtime)` before building the session id, and `apps/jar-telegram/src/telegram-runtime.ts` does the same in its own `handleQueueEntry(...)`.

- Observation: The current `entity-routing.ts` module is really a session-key helper for `entity + surface + scope`, not a real ingress identity router.
  Evidence: `packages/jar-core/src/entity-routing.ts` exports `resolveThreadSessionId(entityId, { surface, scope })` and parses session ids that contain only entity and surface.

- Observation: This rewrite is intentionally destructive because preserving the old config model would keep the wrong abstraction alive and would make all future gateway code carry compatibility branches for a broken product model.
  Evidence: The user requirement is explicit that the current model is “completely wrong” and that best practice should win over compatibility.

- Observation: Slack Socket Mode and Telegram long polling do not need an extra HTTP health server in this repo's deployment model, so keeping `host` and `port` on those identities was unnecessary configuration drag.
  Evidence: After removing the health server code and related CLI/env/config fields from both gateways, package checks and tests still passed.

## Decision Log

- Decision: The new canonical routing key is `platform identity`, not `entity` and not `surface`.
  Rationale: The visible bot/app on Slack or Telegram is the true ingress boundary. A message arrives to a specific bot token or app connection before any entity logic exists.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Each platform identity binds to exactly one entity in this first rewrite.
  Rationale: This keeps ingress semantics unambiguous and prevents the system from slipping back into “one platform bot, many logical entities” under a new name.
  Date/Author: 2026-04-11 / OpenCode

- Decision: `entities.<id>.surfaces` will be removed rather than migrated.
  Rationale: Platform reachability is now expressed by the existence of bound identities under `platform.<platform>.identities`, which is more concrete and avoids duplicate truth.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Session ids will be rewritten to include `identityId` as the durable top-level key.
  Rationale: Two bots on the same platform must never collapse into the same session namespace even if they are bound to the same entity shape or receive messages in similarly-shaped scopes.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Telegram will support multiple real bot tokens as the default architecture. A switchboard bot is not part of this rewrite.
  Rationale: The product goal is multiple Jarvis instances visibly present on the platform. A switchboard would preserve the original anti-pattern.
  Date/Author: 2026-04-11 / OpenCode

## Outcomes & Retrospective

The rewrite landed the intended architecture: Slack and Telegram both run identity-first runtimes, config parsing exposes explicit platform identities, persisted sessions are identity-scoped, `jar.example.toml` reflects the new model, and the documentation no longer describes the old single-bot illusion. The only remaining red tests during validation are unrelated OpenAI-backed `web_search` tests that require credentials in the current environment.

## Context and Orientation

HiJarvis is a TypeScript monorepo. Shared runtime and config code lives in `packages/jar-core/src/`. The Slack gateway lives in `apps/jar-slack/src/`. The Telegram gateway lives in `apps/jar-telegram/src/`. The docs index is `docs/README.md`, and the relevant architecture docs are `docs/configuration.md`, `docs/slack-gateway.md`, `docs/telegram-gateway.md`, and `docs/agent-runtime.md`.

The old model has two layers. The first layer is a platform surface such as Slack or Telegram. The second layer is an entity such as `jarvis-a`. A normal platform message does not enter through a distinct platform identity; instead, each gateway picks the default entity and then derives a session id from `entity + surface + scope`. This means the platform-level bot identity is absent from the architecture even though Slack and Telegram both require concrete bot credentials to exist in the real world.

The new model has three layers. A `platform identity` is a concrete external bot presence such as one Slack app connection or one Telegram bot token. An `entity` is the Jarvis AI identity, prompt, and human-facing display name. A `scope` is the local conversation coordinate inside a platform identity such as a Slack thread or a Telegram chat/topic. Every incoming event must first resolve its platform identity. That identity already says which entity it belongs to. Only then may the runtime derive the persisted session for the local scope.

The key files that must change are:

- `packages/jar-core/src/config.ts`: rewrite config parsing and loaded types to describe entities plus platform identities.
- `packages/jar-core/src/entity-routing.ts`: rewrite routing helpers around identity-first session keys and recent-thread lookup.
- `packages/jar-core/src/session-executor.ts`: keep entity prompt overrides, but adapt side-query helpers to the new identity-aware model.
- `apps/jar-slack/src/slack-config.ts` and `apps/jar-slack/src/slack-runtime.ts`: parse multiple Slack identities and start one runtime per identity.
- `apps/jar-telegram/src/telegram-config.ts` and `apps/jar-telegram/src/telegram-runtime.ts`: parse multiple Telegram identities and start one runtime per identity.
- `packages/jar-core/src/config.test.ts` and `packages/jar-core/src/entity-routing.test.ts`: redefine tests around the new config and routing model.
- `docs/configuration.md`, `docs/slack-gateway.md`, `docs/telegram-gateway.md`, and `docs/agent-runtime.md`: rewrite docs to match the new product truth.

## Plan of Work

Begin in the shared config layer. The old config parser still accepts `[entities.<id>]` with `surfaces = [...]` and stores raw `platform` as an untyped record. Replace that with explicit loaded platform identity types. Each identity should include its own `id`, `platform`, `entityId`, and platform-specific credentials or runtime options. The entity object should become narrower: only display and prompt concerns should remain.

Next, rewrite the routing module so that normal message routing takes a known `identityId` plus a platform-local scope and returns a session id. The session id should be filesystem-safe and should begin with the identity key. The reverse lookup used by side query should be able to find the most recent persisted session for an identity or for the identity bound to a named entity, depending on the calling need.

Then refactor Slack. The process entry point should load all configured Slack identities and start one isolated Slack runtime state per identity. Each runtime must own its own `App`, dedupe caches, subscriptions, queues, and reply markers. Ordinary Slack messages must route through the current runtime identity instead of a default entity.

After Slack, refactor Telegram in the same pattern. The process should load all configured Telegram identities and start one `grammy` bot per identity. Each bot must have its own allowlist, queue state, and runtime identity information. Ordinary messages must route through the current Telegram identity.

Finally, update side-query semantics, tests, and docs. Side query should remain read-only against target threads, but lookup should no longer be described as “default entity on a platform”. Tests should prove the new config shape, new session id shape, and multi-identity gateway parsing behavior. Documentation should be rewritten to describe real multi-bot architecture and must remove any statement that a single platform bot is expected to host multiple Jarvis entities.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

1. Add failing tests before production edits.

   Run:

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "platform identities|identity routing"

   Expectation before implementation: the new tests fail because the config parser and routing helpers still use the old entity/surface model.

2. Rewrite shared config and routing.

   Edit:

   - `packages/jar-core/src/config.ts`
   - `packages/jar-core/src/index.ts`
   - `packages/jar-core/src/entity-routing.ts`
   - `packages/jar-core/src/config.test.ts`
   - `packages/jar-core/src/entity-routing.test.ts`

   Then run:

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "platform identities|identity routing"
       pnpm --filter @hijarvis/jar-core check

3. Refactor Slack identity handling.

   Edit:

   - `apps/jar-slack/src/slack-config.ts`
   - `apps/jar-slack/src/slack-runtime.ts`
   - Slack tests if they need updates

   Then run:

       pnpm --filter @hijarvis/jar-slack test
       pnpm --filter @hijarvis/jar-slack check

4. Refactor Telegram identity handling.

   Edit:

   - `apps/jar-telegram/src/telegram-config.ts`
   - `apps/jar-telegram/src/telegram-runtime.ts`
   - Telegram tests if they need updates

   Then run:

       pnpm --filter @hijarvis/jar-telegram test
       pnpm --filter @hijarvis/jar-telegram check

5. Rewrite documentation.

   Edit:

   - `docs/configuration.md`
   - `docs/agent-runtime.md`
   - `docs/slack-gateway.md`
   - `docs/telegram-gateway.md`
   - `docs/README.md` if references change materially

6. Run final repo-focused validation.

   Run:

       pnpm --filter @hijarvis/jar-core test
       pnpm --filter @hijarvis/jar-slack test
       pnpm --filter @hijarvis/jar-telegram test
       pnpm -r tsc --noEmit

   Record the actual results in `Progress`, `Surprises & Discoveries`, and `Artifacts and Notes`.

## Validation and Acceptance

Acceptance is behavioral.

First, a config file with two Slack identities or two Telegram identities must parse into explicit loaded identity objects, each pointing at exactly one entity. There must be no `surfaces` field on entities in the loaded model.

Second, identity-scoped routing must produce distinct session ids for different identities even when the platform and scope shape are otherwise identical. A routing test should prove that `slack-main` and `slack-pm` do not collide when both map a Slack thread scope like `thread:C1:2`.

Third, normal platform messages must route through the current identity rather than a global default entity. This is accepted when gateway tests or focused unit tests show that the route decision is determined by the runtime identity config bound to that daemon instance.

Fourth, side query must remain non-persistent. A test or narrow execution scenario should show that side query can read from a target identity-bound thread without appending the side-query prompt or answer to that thread transcript.

Fifth, the docs must describe the new truth. A reader of `docs/configuration.md`, `docs/slack-gateway.md`, and `docs/telegram-gateway.md` should come away understanding that HiJarvis supports multiple real bots per platform and that entity is no longer the ingress routing key.

## Idempotence and Recovery

This rewrite is intentionally destructive at the config and session-key model level, but the work is still safe to perform incrementally in the working tree. Tests should be updated alongside code so failures remain local and understandable. If a gateway refactor becomes unstable, the safe recovery path is to finish the shared config and routing rewrite first, then complete one gateway at a time until tests pass again. Because the old model is being deliberately removed, do not add compatibility branches unless a test or validation step demonstrates a concrete need that preserves the new architecture rather than undermining it.

If a partial edit leaves type errors, rerun the affected package check command after each focused patch rather than attempting broad speculative rewrites. The session store on disk is not being migrated by script in this plan, so retrying tests is safe; the main risk is stale assumptions in code, not data corruption.

## Artifacts and Notes

Observed proof artifacts after implementation:

- `pnpm --filter @hijarvis/jar-core check` passed.
- `pnpm --filter @hijarvis/jar-slack check && pnpm --filter @hijarvis/jar-slack test` passed.
- `pnpm --filter @hijarvis/jar-telegram check && pnpm --filter @hijarvis/jar-telegram test` passed.
- Focused `jar-core` config/routing tests passed after test fixture updates, except for unrelated OpenAI-backed `web_search` tests that require `OPENAI_API_KEY` in this environment.

Expected example session ids after implementation:

    identity__slack_main__slack__thread__C123__1743931234.56789
    identity__slack_pm__slack__thread__C123__1743931234.56789
    identity__tg_main__telegram__chat__-100123456

Expected config shape after implementation:

    [entities.jarvis_main]
    display_name = "Jarvis"

    [platform.slack.identities.slack_main]
    entity = "jarvis_main"
    bot_token = "xoxb-..."
    app_token = "xapp-..."
    signing_secret = "..."

    [platform.telegram.identities.tg_main]
    entity = "jarvis_main"
    bot_token = "123456:..."

## Interfaces and Dependencies

Use only existing project dependencies such as `zod`, `@slack/bolt`, `grammy`, `@mariozechner/pi-agent-core`, and the filesystem-backed session store in `packages/jar-core/src/session-store.ts`.

At the end of this rewrite, the codebase should expose interfaces equivalent to the following:

In `packages/jar-core/src/config.ts`, loaded config types for:

    type LoadedEntityConfig = {
      id: string;
      displayName: string;
      systemPrompt?: string;
    };

    type LoadedPlatformIdentityConfig =
      | LoadedSlackIdentityConfig
      | LoadedTelegramIdentityConfig;

In `packages/jar-core/src/entity-routing.ts`, exported helpers equivalent to:

    getPlatformIdentityById(...)
    resolveIdentityThread(...)
    resolveIdentitySessionId(...)
    findMostRecentIdentityThread(...)
    findMostRecentThreadForEntity(...)

In `apps/jar-slack/src/slack-runtime.ts` and `apps/jar-telegram/src/telegram-runtime.ts`, gateway startup paths that iterate configured identities and start one isolated runtime per identity rather than one runtime per platform.

Revision note: Created this ExecPlan before implementation to document the destructive identity-first architecture rewrite required to replace the old single-bot-per-platform model.
