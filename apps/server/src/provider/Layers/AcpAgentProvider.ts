import type { ModelCapabilities, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpAgentBinarySettings, AcpAgentProfile } from "../acp/AcpAgentProfile.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const NO_MODELS: ReadonlyArray<ServerProviderModel> = [];

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/** pi-acp accepts any auth method id, so the probe uses its terminal login id. */
const PI_PROBE_AUTH_METHOD_ID = "pi_terminal_login";
const PROBE_CLIENT_INFO = { name: "t3-code-provider-probe", version: "0.0.0" } as const;

/** The slice of a profile the ACP model probe needs — accepts a whole profile. */
export type AcpAgentProbeProfile<Settings extends AcpAgentBinarySettings> = Pick<
  AcpAgentProfile<Settings>,
  "buildSpawnInput" | "clientCapabilities" | "authMethodId"
>;

function fallbackModelsFrom(settings: AcpAgentBinarySettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
}

/**
 * First snapshot published before the probe runs, so the Settings UI renders
 * the provider (with its custom models) immediately instead of an empty card.
 */
export function buildInitialAcpAgentProviderSnapshot<Settings extends AcpAgentBinarySettings>(
  profile: AcpAgentProfile<Settings>,
  settings: Settings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = fallbackModelsFrom(settings);
    const displayName = profile.presentation.displayName;

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: profile.presentation,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${displayName} is disabled in T3 Code settings.`,
        },
      });
    }

    return buildServerProvider({
      presentation: profile.presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Checking ${displayName} CLI availability...`,
      },
    });
  });
}

const runVersionCommand = (
  binaryPath: string,
  versionArgs: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, [...versionArgs], {
      env: environment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Both `pi-acp --version` and `prime-agent --version` print a bare version on
 * stdout. stderr is ignored on purpose: `prime-agent` also prints
 * `fatal: not a git repository` when the cwd is not a repo.
 */
function firstLine(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Probes the agent binary, then its model catalog, and folds both into one
 * provider snapshot. Mirrors `checkGrokProviderStatus`, but every
 * agent-specific decision comes from the profile.
 */
export const checkAcpAgentProviderStatus = Effect.fn("checkAcpAgentProviderStatus")(function* <
  Settings extends AcpAgentBinarySettings,
>(
  profile: AcpAgentProfile<Settings>,
  settings: Settings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = fallbackModelsFrom(settings);
  const displayName = profile.presentation.displayName;
  // Reuse the profile's spawn resolution so the probe hits the same binary a
  // real session would, including its default when `binaryPath` is blank.
  const binaryPath = profile.buildSpawnInput(settings, cwd, environment).command;

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: profile.presentation,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${displayName} is disabled in T3 Code settings.`,
      },
    });
  }

  const versionResult = yield* runVersionCommand(binaryPath, profile.versionArgs, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    const missing = isCommandMissingCause(error);
    yield* Effect.logWarning(`${displayName} CLI health check failed.`, {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: profile.presentation,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `${displayName} (\`${binaryPath}\`) is not installed or not on PATH.`
          : `Failed to execute the ${displayName} CLI health check.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: profile.presentation,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `${displayName} is installed but timed out while reporting its version.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = firstLine(versionOutput.stdout);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning(`${displayName} CLI version probe exited with a non-zero status.`, {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: profile.presentation,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `${displayName} is installed but failed to run.`,
      },
    });
  }

  const discovered = yield* profile.discoverModels(settings, environment, cwd).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.map((option) => (Option.isNone(option) ? NO_MODELS : option.value)),
  );

  const models =
    discovered.length > 0
      ? providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES)
      : fallbackModels;

  if (models.length === 0) {
    return buildServerProvider({
      presentation: profile.presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `${displayName} is installed but no models were found. Sign in to the agent CLI, or add custom models in settings.`,
      },
    });
  }

  return buildServerProvider({
    presentation: profile.presentation,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

/**
 * Attaches the shared version advisory to a published snapshot. ACP agent
 * profiles have nothing else to enrich, so this stays a thin mirror of the
 * Grok/Cursor step.
 */
export const enrichAcpAgentSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("ACP agent version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );

// ---------------------------------------------------------------------------
// Prime Agent model catalog (`prime-agent model list`)
// ---------------------------------------------------------------------------

/** Levels Prime accepts for `--thinking`, in the order its CLI lists them. */
export const PRIME_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const PRIME_DEFAULT_THINKING_LEVEL = "medium";

const PRIME_THINKING_LABELS: Record<(typeof PRIME_THINKING_LEVELS)[number], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const PRIME_REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: PRIME_DEFAULT_THINKING_LEVEL,
      options: PRIME_THINKING_LEVELS.map((level) => ({
        id: level,
        label: PRIME_THINKING_LABELS[level],
        ...(level === PRIME_DEFAULT_THINKING_LEVEL ? { isDefault: true } : {}),
      })),
    },
  ],
});

export interface PrimeModelTableRow {
  readonly provider: string;
  readonly model: string;
  readonly context: string;
  readonly maxOut: string;
  readonly thinking: boolean;
  readonly images: boolean;
}

const PRIME_TABLE_COLUMNS = [
  "provider",
  "model",
  "context",
  "max-out",
  "thinking",
  "images",
] as const;

function primeTableColumnStarts(header: string): ReadonlyArray<number> | undefined {
  const starts: Array<number> = [];
  let cursor = 0;
  for (const column of PRIME_TABLE_COLUMNS) {
    const index = header.indexOf(column, cursor);
    if (index === -1) {
      return undefined;
    }
    starts.push(index);
    cursor = index + column.length;
  }
  return starts;
}

/**
 * Parses the fixed-width table printed by `prime-agent model list`. Columns are
 * located by their header offsets; anything before the header (the CLI prints
 * `fatal: not a git repository ...` outside a repo) is skipped.
 */
export function parsePrimeModelListTable(text: string): ReadonlyArray<PrimeModelTableRow> {
  const lines = text.split(/\r?\n/);
  let starts: ReadonlyArray<number> | undefined;
  let headerIndex = -1;
  for (const [index, line] of lines.entries()) {
    const candidate = primeTableColumnStarts(line);
    if (candidate && line.slice(0, candidate[0]).trim().length === 0) {
      starts = candidate;
      headerIndex = index;
      break;
    }
  }
  if (!starts || headerIndex === -1) {
    return [];
  }

  const rows: Array<PrimeModelTableRow> = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) {
      continue;
    }
    const cells = starts.map((start, index) => {
      const end = starts[index + 1];
      return (end === undefined ? line.slice(start) : line.slice(start, end)).trim();
    });
    const [provider, model, context, maxOut, thinking, images] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (provider.length === 0 || model.length === 0) {
      continue;
    }
    rows.push({
      provider,
      model,
      context,
      maxOut,
      thinking: thinking.toLowerCase() === "yes",
      images: images.toLowerCase() === "yes",
    });
  }
  return rows;
}

/**
 * Maps parsed table rows to provider models. Slugs are `provider/model`, which
 * is exactly what `prime-agent --model` expects; note some model ids already
 * contain a slash (`lmstudio/google/gemma-4-31b`) and that is fine — custom
 * model slugs are only trimmed, never validated against a pattern.
 */
export function primeModelsFromTable(
  rows: ReadonlyArray<PrimeModelTableRow>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const row of rows) {
    const slug = `${row.provider}/${row.model}`;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      capabilities: row.thinking ? PRIME_REASONING_CAPABILITIES : EMPTY_CAPABILITIES,
    });
  }
  return models;
}

/** Runs `<binaryPath> model list` and parses its table. Never fails. */
export const discoverPrimeModels = (
  settings: AcpAgentBinarySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const binaryPath = settings.binaryPath.trim() || "prime-agent";
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["model", "list"], {
      env: environment,
    });
    const output = yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    return primeModelsFromTable(parsePrimeModelListTable(output.stdout));
  }).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.map((option) => (Option.isNone(option) ? NO_MODELS : option.value)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Prime Agent model discovery failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(NO_MODELS)),
    ),
  );

// ---------------------------------------------------------------------------
// Pi model catalog (ACP `session/new` config options)
// ---------------------------------------------------------------------------

const PI_MODEL_CONFIG_ID = "model";
const PI_THOUGHT_LEVEL_CONFIG_ID = "thought_level";

interface AcpSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<AcpSelectOption> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          name: nested.name.trim(),
        })),
  );
}

function findSelectConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
): Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }> | undefined {
  const found = configOptions.find((option) => option.id.trim() === configId);
  return found?.type === "select" ? found : undefined;
}

/**
 * Turns a Pi `session/new` config option set into provider models. When Pi also
 * advertises a `thought_level` select, every model carries it as a
 * reasoning-effort descriptor so the web model picker renders the control.
 */
export function piModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findSelectConfigOption(configOptions, PI_MODEL_CONFIG_ID);
  if (!modelOption) {
    return NO_MODELS;
  }

  const thoughtLevel = findSelectConfigOption(configOptions, PI_THOUGHT_LEVEL_CONFIG_ID);
  const thoughtLevelOptions = flattenSelectOptions(thoughtLevel);
  const capabilities: ModelCapabilities =
    thoughtLevel && thoughtLevelOptions.length > 0
      ? createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: thoughtLevel.name.trim() || "Reasoning",
              type: "select",
              currentValue: thoughtLevel.currentValue,
              options: thoughtLevelOptions.map((entry) => ({
                id: entry.value,
                label: entry.name || entry.value,
                ...(entry.value === thoughtLevel.currentValue ? { isDefault: true } : {}),
              })),
            },
          ],
        })
      : EMPTY_CAPABILITIES;

  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of flattenSelectOptions(modelOption)) {
    if (entry.value.length === 0 || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    models.push({
      slug: entry.value,
      name: entry.name || entry.value,
      isCustom: false,
      capabilities,
    });
  }
  return models;
}

/**
 * Starts a throwaway ACP session against the agent and reads its model catalog
 * from `session/new` config options. The runtime is killed on scope close.
 * Never fails: startup problems and timeouts both yield `[]`.
 */
export const discoverPiModelsViaAcp = <Settings extends AcpAgentBinarySettings>(
  profile: AcpAgentProbeProfile<Settings>,
  settings: Settings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: profile.buildSpawnInput(settings, cwd, environment),
        cwd,
        clientInfo: PROBE_CLIENT_INFO,
        authMethodId: profile.authMethodId ?? PI_PROBE_AUTH_METHOD_ID,
        clientCapabilities: profile.clientCapabilities,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    const acp = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    yield* acp.start();
    return piModelsFromConfigOptions(yield* acp.getConfigOptions);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.map((option) => (Option.isNone(option) ? NO_MODELS : option.value)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi ACP model discovery failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(NO_MODELS)),
    ),
  );
