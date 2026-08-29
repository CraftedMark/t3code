# PRD — CraftedMark/t3code fork: Pi + Prime Agent providers

> Fork-local document. Upstream is `pingdotgg/t3code`; this file lives under `docs/fork/` so it never conflicts on rebase.

## Problem

T3 Code ships five hard-coded provider drivers (Codex, Claude, Cursor, Grok, OpenCode). Mark's daily agents — **Pi** (`pi`, earendil-works) and **Prime Agent** (`prime-agent`, Prime Intellect's Pi fork) — cannot be driven from T3, and neither can the custom/OpenAI-compatible providers those agents already know how to reach (Kimi K3, LM Studio, Ollama, OpenRouter).

## What this is

Two new first-party drivers in the fork, `pi` and `prime`, built on T3's existing ACP runtime:

- **Pi** via the `pi-acp` bridge (npm `pi-acp`, spawns `pi --mode rpc`). Exposes standard ACP `configOptions` (`model`, `thought_level`), `loadSession`, session list/delete.
- **Prime Agent** via native `prime-agent --mode acp`. No configOptions/authMethods; model chosen at spawn (`--model provider/id`, `--thinking level`); catalog from `prime-agent model list`.

Both ride one **generic, profile-driven ACP adapter** so a third ACP agent later (Gemini CLI, claude-agent-acp, codex-acp) is a profile, not another 1,500-line adapter.

## Users

Mark (devmbp + Mac Studio). Secondary: anyone on the fork.

## Architecture & map

| Layer                                                                  | Change                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/settings.ts`                                   | `PiSettings`, `PrimeSettings` (enabled opt-in, `binaryPath`, `customModels`), patch schemas, `providers.pi` / `providers.prime`                  |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`                    | `authMethodId` optional; skip `authenticate` when `initialize.authMethods` is empty                                                              |
| `apps/server/src/provider/acp/AcpAgentProfile.ts` (new)                | profile type: driverKind, presentation, `buildSpawnInput`, `authMethodId?`, `clientCapabilities`, model strategy (`configOption` \| `spawnArgs`) |
| `apps/server/src/provider/Layers/AcpAgentAdapter.ts` (new)             | generic adapter (derived from `CursorAdapter.ts` minus Cursor extensions)                                                                        |
| `apps/server/src/provider/Layers/AcpAgentProvider.ts` (new)            | status probe (`--version`), model discovery (Pi: `session/new.configOptions.model`; Prime: parse `model list` table), snapshot builders          |
| `apps/server/src/textGeneration/AcpAgentTextGeneration.ts` (new)       | generic from `GrokTextGeneration.ts`                                                                                                             |
| `apps/server/src/provider/Drivers/PiDriver.ts`, `PrimeDriver.ts` (new) | thin drivers; added to `builtInDrivers.ts`                                                                                                       |
| `apps/web/src/components/settings/providerDriverMeta.ts`, `Icons.tsx`  | labels, icons, settings schemas                                                                                                                  |
| `docs/internals/providers.md`, `docs/fork/`                            | driver table + fork docs                                                                                                                         |

Repo rules that bind: `AGENTS.md` (no repo-wide checks, focused tests, hit every surface, never touch `~/.t3/userdata`, complexity at the adapter boundary).

## Done criteria

1. `vp test run` passes for every new/changed test file (profile spawn builders, model-list parser, authenticate skip, adapter event mapping).
2. Targeted typecheck of `apps/server`, `packages/contracts`, `apps/web` is clean.
3. In a dev server against a **worktree** `.t3` (never the live install): both providers appear in Settings → Providers, enable, probe green, model picker populated (Pi ≥ 20 models, Prime ≥ 20), and one real turn completes on each (tool call rendered, `end_turn`).
4. Text generation (thread title) works through at least one of the two.
5. `docs/internals/providers.md` lists seven drivers; `docs/fork/` explains install prerequisites (`bun add -g pi-acp`, `prime-agent` on PATH).
6. Branch `feat/acp-agents-pi-prime` pushed to `CraftedMark/t3code`.

## Self-improving agent

Owning agent: **Hex**. Lessons go to OpenViking (`remember`) and `~/brain/wiki/concepts/t3code-fork.md`; repo-local notes in `docs/fork/`.

## Memory

- OpenViking: entity `software/t3.md`, event `2026-08-29/t3_codex_provider_fix`, this project's research record.
- Verified probe facts (2026-08-29): prime-agent ACP `initialize` ~2s; `authenticate` → `-32601`; pi-acp `authenticate` → `{}`; pi-acp `session/new` → `configOptions[model, thought_level]`.

## Out of scope

- A native OpenAI-compatible driver without an agent CLI underneath.
- Upstreaming (may follow once stable; keep the generic adapter upstream-shaped).
- Mobile UI beyond what falls out of the generic settings renderer.

## Risks

- **Upstream churn**: provider layer moves fast; mitigated by a small, profile-shaped diff and `upstream` remote rebases.
- **pi-acp is 0.0.x**: bridge quirks (startup-info chunk, embedded context off by default). Pin the version in docs; set `quietStartup` guidance.
- **Prime daemon + TMPDIR**: prime-agent's daemon sockets live under `$TMPDIR`; T3 must pass a stable env (it inherits the server's — fine).
- **Model switch semantics**: Prime needs a new thread per model change (`requiresNewThreadForModelChange: true`, same as Grok).
