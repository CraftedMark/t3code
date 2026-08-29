# Plan — Pi + Prime Agent providers over a generic ACP adapter

Companion to [PRD.md](./PRD.md). Branch: `feat/acp-agents-pi-prime`.

## Verified inputs (2026-08-29, devmbp)

| Agent             | Binary                                                 | ACP    | `initialize`                                                                                                                                        | `authenticate`            | `session/new`                                                                                                 | Model selection                                                                  | Catalog                                                                               |
| ----------------- | ------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pi 0.84.4         | `pi-acp` 0.0.33 (`~/.bun/bin`, spawns `pi --mode rpc`) | bridge | `authMethods:[pi_terminal_login]`, `loadSession:true`, `sessionCapabilities.list/delete`, `promptCapabilities.image`                                | any methodId → `{}`       | `configOptions[model(select, provider/id ×25), thought_level(select)]` + a startup-info `agent_message_chunk` | `session/set_config_option` `model`                                              | from `configOptions.model.options`                                                    |
| Prime Agent 0.8.0 | `prime-agent --mode acp` (`~/.local/bin`)              | native | no `authMethods`, `loadSession:false`, `mcpCapabilities.http`, `promptCapabilities.image+embeddedContext`, `_meta["ai.primeintellect.prime-agent"]` | `-32601 Method not found` | `{sessionId}` only; one session per process; concurrent prompt refused                                        | spawn args `--model provider/id --thinking <level>`; new thread per model change | `prime-agent model list` (table: provider, model, context, max-out, thinking, images) |

Both catalogs list only providers the agent is authenticated for. Prime's daemon uses sockets under `$TMPDIR` — probes must run with the server's real env.

## Design

**One generic adapter, two profiles.** Today Cursor and Grok each own a 1.2–2k-line adapter over the shared `AcpSessionRuntime`. Pi and Prime have no agent-specific extension methods, so their adapters would be ~90% identical. We extract that 90% once:

```
apps/server/src/provider/acp/AcpAgentProfile.ts        // profile contract
apps/server/src/provider/Layers/AcpAgentAdapter.ts     // generic ProviderAdapterShape over AcpSessionRuntime
apps/server/src/provider/Layers/AcpAgentProvider.ts    // status probe + model discovery + snapshot builders
apps/server/src/textGeneration/AcpAgentTextGeneration.ts
apps/server/src/provider/Drivers/PiDriver.ts           // profile + ProviderDriver
apps/server/src/provider/Drivers/PrimeDriver.ts
```

`AcpAgentProfile`:

```ts
interface AcpAgentProfile<Settings> {
  driverKind: ProviderDriverKind;
  presentation: {
    displayName;
    badgeLabel?;
    showInteractionModeToggle;
    requiresNewThreadForModelChange;
  };
  clientInfoName: string;
  clientCapabilities: ClientCapabilities;
  authMethodId?: string; // undefined → runtime skips authenticate
  buildSpawnInput(settings, cwd, env, modelSelection?): AcpSpawnInput;
  modelStrategy: { kind: "configOption"; configId: "model" } | { kind: "spawnArgs" };
  discoverModels(settings, env): Effect<ReadonlyArray<ServerProviderModel>>;
  versionCommand(settings): { command; args };
  resumeSupport: "acpLoadSession" | "none";
}
```

Cursor/Grok are **not** migrated in this pass (keeps the diff reviewable and rebase-safe). The generic adapter is written so they could be later.

### Runtime change (upstream-shaped)

`AcpSessionRuntimeOptions.authMethodId` becomes optional. `start()` calls `authenticate` only when `authMethodId` is set **and** `initializeResult.authMethods` is non-empty. Cursor/Grok behavior unchanged.

### Model catalog

- Pi: at probe time spawn `pi-acp`, `initialize` → `session/new` → read `configOptions` where `id === "model"`, map `options[].value` → `ServerProviderModel.slug`, `name` → display, then `session/close`/kill. Timeout 15s (same as Grok's discovery). Fallback: `customModels` only.
- Prime: run `prime-agent model list` (timeout 15s), parse the fixed-width table by header positions (`provider`, `model`, …); slug = `${provider}/${model}`; capabilities: `thinking === "yes"` → reasoning-effort option descriptor (off/minimal/low/medium/high/xhigh/max, default from Prime settings), `images === "yes"` → image input.

### Settings (contracts)

`PiSettings`, `PrimeSettings` = `makeProviderSettingsSchema({ enabled(default false, hidden), binaryPath(placeholder "pi-acp" / "prime-agent"), customModels(hidden) })`, plus `*SettingsPatch`, `providers.pi`, `providers.prime`, and `legacyDefaults` entries. Prime additionally gets `defaultThinking` (select: off…max, default `medium`) since thinking is a spawn arg.

### Web

`providerDriverMeta.ts`: two entries (`Pi`, `Prime Agent`, badge `Fork`), icons added to `Icons.tsx` (simple monochrome glyphs). Settings toggles follow the Grok pattern in `SettingsPanels.logic.ts`.

### Docs

`docs/internals/providers.md` driver table → 7 rows + a paragraph on the generic adapter. `docs/fork/README.md`: prerequisites (`bun add -g pi-acp`, `prime-agent` install), known limits.

## Phases & acceptance gates

| #   | Phase                                                                                                                                       | Gate (must pass before next)                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Contracts: settings schemas, patches, defaults                                                                                              | `vp test run packages/contracts/src/settings.test.ts`; typecheck contracts                                                        |
| 2   | Runtime: optional `authMethodId`, skip logic + test                                                                                         | `vp test run apps/server/src/provider/acp/AcpSessionRuntime*.test.ts` (new case: no authMethods → no authenticate request logged) |
| 3   | Profile + `AcpAgentProvider` (probe, Prime table parser, Pi configOptions discovery) + tests with fixtures                                  | parser test on captured `model list` output; discovery test with a fake ACP agent script                                          |
| 4   | Generic `AcpAgentAdapter` + `AcpAgentTextGeneration` (+ tests adapted from `CursorAdapter.test.ts`)                                         | adapter tests green; typecheck server                                                                                             |
| 5   | `PiDriver`, `PrimeDriver`, `builtInDrivers.ts`, `ProviderRegistry.test.ts` expectations                                                     | registry tests green                                                                                                              |
| 6   | Web meta/icons/toggles; docs                                                                                                                | typecheck web; `vp check --fix` on touched files                                                                                  |
| 7   | Live verification in a worktree `.t3` (`vp run dev`), both providers: probe green, picker populated, one turn each, thread title generation | screenshots + `server.trace.ndjson` evidence in `docs/fork/verification-2026-08-29.md`                                            |
| 8   | Commit per phase (conventional), push branch                                                                                                | `git log` on `origin/feat/acp-agents-pi-prime`                                                                                    |

Rules from `AGENTS.md` in force: no repo-wide `vp check`/`test`; targeted runs only; never start a server against `~/.t3/userdata`; kill only PIDs we spawned.
