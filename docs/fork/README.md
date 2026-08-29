# CraftedMark/t3code — fork notes

This fork tracks `pingdotgg/t3code` (`upstream` remote) and adds two ACP-based providers: **Pi** and **Prime Agent**. Everything fork-specific lives under `docs/fork/`.

- [PRD](./PRD.md) — problem, scope, done criteria
- [Plan](./pi-prime-acp-providers-plan.md) — design, verified agent behaviour, phases

## Prerequisites (macOS, devmbp)

| Provider    | Binary                                            | Install                                                                                       | Check                                             |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Pi          | `pi-acp` (ACP bridge that spawns `pi --mode rpc`) | `bun add -g pi-acp` (needs `pi` on PATH: `@earendil-works/pi-coding-agent`)                   | `pi-acp --version`, `pi --list-models`            |
| Prime Agent | `prime-agent`                                     | `npm i -g prime-agent` was used originally; any install that puts `prime-agent` on PATH works | `prime-agent --version`, `prime-agent model list` |

Both agents list only the providers you are already authenticated with (`~/.pi/agent/auth.json`, `~/.prime/agent/auth.json`). Authenticate in the terminal first; T3 does not run login flows for these drivers.

## Known limits

- `pi-acp` is 0.0.x. It emits a startup-info message chunk at session start; set `"quietStartup": true` in `~/.pi/agent/settings.json` to suppress it.
- Prime Agent runs one session per process and refuses concurrent prompts; T3 spawns one process per thread, so this is fine. Changing model requires a new thread.
- Prime Agent's daemon keeps sockets under `$TMPDIR`; if a sandbox rewrites `TMPDIR` per call, the agent cannot reach its worker. T3 passes its own environment through, which is stable.

## Development

```bash
export PATH=/opt/homebrew/bin:$PATH   # Node 26; repo pins ^24 but is not engine-strict
pnpm install
./node_modules/.bin/vp test run <file>            # targeted tests only (see AGENTS.md)
./node_modules/.bin/vp run --filter t3 typecheck  # server
./node_modules/.bin/vp run --filter @t3tools/contracts typecheck
```

Never run a dev server against `~/.t3/userdata` (the live install). Use a worktree `.t3`.

## Syncing with upstream

```bash
git fetch upstream
git rebase upstream/main        # on feat/* branches
```

Keep fork changes profile-shaped (new files + one-line registrations) so rebases stay cheap.
