import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
  type AcpAgentBinarySettings,
  type AcpAgentProfile,
} from "../acp/AcpAgentProfile.ts";
import { PI_ACP_PROFILE } from "../acp/PiAcpProfile.ts";
import {
  buildInitialAcpAgentProviderSnapshot,
  checkAcpAgentProviderStatus,
  discoverPiModelsViaAcp,
  discoverPrimeModels,
  parsePrimeModelListTable,
  primeModelsFromTable,
} from "./AcpAgentProvider.ts";

/**
 * Real `prime-agent model list` output captured on 2026-08-29. The leading
 * `fatal:` line is what the CLI prints when the cwd is not a git repository.
 */
const PRIME_MODEL_LIST_FIXTURE = [
  "fatal: not a git repository (or any of the parent directories): .git",
  "provider      model                                            context  max-out  thinking  images",
  "anthropic     claude-fable-5                                   1M       128K     yes       yes",
  "anthropic     claude-sonnet-5                                  1M       128K     yes       yes",
  "kimi-coding   k3                                               1.0M     131.1K   yes       yes",
  "lmstudio      google/gemma-4-31b                               262.1K   32K      no        yes",
  "lmstudio      llama-3.2-1b-instruct                            131.1K   32K      no        no",
  "openai-codex  gpt-5.6-sol                                      1.0M     131.1K   yes       yes",
  "",
].join("\n");

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "acp-agent-provider-mock-",
  });
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const mockAgentCommand = ["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${mockAgentCommand} "$@"
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const writeExecutable = Effect.fn("writeExecutable")(function* (
  prefix: string,
  lines: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectory({ directory: NodeOS.tmpdir(), prefix });
  const binaryPath = path.join(dir, "test-agent");
  yield* fileSystem.writeFileString(binaryPath, [...lines, ""].join("\n"));
  yield* fileSystem.chmod(binaryPath, 0o755);
  return binaryPath;
});

function makeTestProfile(
  overrides?: Partial<AcpAgentProfile<AcpAgentBinarySettings>>,
): AcpAgentProfile<AcpAgentBinarySettings> {
  return {
    driverKind: PI_ACP_PROFILE.driverKind,
    presentation: {
      displayName: "Test Agent",
      badgeLabel: "Fork",
      showInteractionModeToggle: false,
      requiresNewThreadForModelChange: false,
    },
    clientInfoName: "t3-code",
    clientCapabilities: ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
    authMethodId: "pi_terminal_login",
    buildSpawnInput: (settings, cwd, environment) => ({
      command: settings.binaryPath || "test-agent",
      args: [],
      cwd,
      ...(environment ? { env: environment } : {}),
    }),
    modelStrategy: { kind: "configOption", configId: "model" },
    versionCommand: (settings) => ({
      command: settings.binaryPath || "test-agent",
      args: ["--version"],
    }),
    discoverModels: () => Effect.succeed([]),
    resumeSupport: "acpLoadSession",
    ...overrides,
  };
}

describe("parsePrimeModelListTable", () => {
  it("parses every row and skips the pre-header noise", () => {
    const rows = parsePrimeModelListTable(PRIME_MODEL_LIST_FIXTURE);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
      context: "1M",
      maxOut: "128K",
      thinking: true,
      images: true,
    });
    expect(rows.map((row) => `${row.provider}/${row.model}`)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-5",
      "kimi-coding/k3",
      "lmstudio/google/gemma-4-31b",
      "lmstudio/llama-3.2-1b-instruct",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(rows.map((row) => row.thinking)).toEqual([true, true, true, false, false, true]);
    expect(rows.map((row) => row.images)).toEqual([true, true, true, true, false, true]);
  });

  it("returns nothing when the header is absent", () => {
    expect(parsePrimeModelListTable("fatal: not a git repository\n")).toEqual([]);
    expect(parsePrimeModelListTable("")).toEqual([]);
  });
});

describe("primeModelsFromTable", () => {
  const models = primeModelsFromTable(parsePrimeModelListTable(PRIME_MODEL_LIST_FIXTURE));

  it("slugs models as provider/model and keeps embedded slashes intact", () => {
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-5",
      "kimi-coding/k3",
      "lmstudio/google/gemma-4-31b",
      "lmstudio/llama-3.2-1b-instruct",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(models.every((model) => model.name === model.slug)).toBe(true);
    expect(models.every((model) => model.isCustom === false)).toBe(true);
  });

  it("attaches a reasoning-effort descriptor only to thinking models", () => {
    const thinkingModel = models.find((model) => model.slug === "anthropic/claude-fable-5");
    expect(thinkingModel?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "off", label: "Off" },
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
    ]);

    const plainModel = models.find((model) => model.slug === "lmstudio/llama-3.2-1b-instruct");
    expect(plainModel?.capabilities?.optionDescriptors).toEqual([]);
  });
});

it.layer(NodeServices.layer)("discoverPrimeModels", (it) => {
  it.effect("reads the model catalog from stderr", () =>
    Effect.gen(function* () {
      const binaryPath = yield* writeExecutable("prime-agent-stderr-models-", [
        "#!/bin/sh",
        'printf "%s\\n" "' + PRIME_MODEL_LIST_FIXTURE.replaceAll("\n", '" "') + '" >&2',
      ]);

      const models = yield* discoverPrimeModels({
        enabled: true,
        binaryPath,
        customModels: [],
      });

      expect(models).toHaveLength(6);
      expect(models[0]?.slug).toBe("anthropic/claude-fable-5");
    }),
  );
});

it.layer(NodeServices.layer)("discoverPiModelsViaAcp", (it) => {
  it.effect("reads the model catalog from session/new config options", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockAgentWrapper({ T3_ACP_MODEL_CONFIG_OPTIONS: "1" });

      const models = yield* discoverPiModelsViaAcp(PI_ACP_PROFILE, {
        enabled: true,
        binaryPath: wrapperPath,
        customModels: [],
      });

      expect(models.map((model) => model.slug)).toEqual([
        "anthropic/claude-fable-5",
        "anthropic/claude-sonnet-5",
      ]);
      expect(models.map((model) => model.name)).toEqual([
        "anthropic/Claude Fable 5",
        "anthropic/Claude Sonnet 5",
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Thinking",
          type: "select",
          currentValue: "medium",
          options: [
            { id: "off", label: "Thinking: off" },
            { id: "medium", label: "Thinking: medium", isDefault: true },
            { id: "high", label: "Thinking: high" },
          ],
        },
      ]);
    }),
  );

  it.effect("returns no models when the agent cannot be spawned", () =>
    Effect.gen(function* () {
      const models = yield* discoverPiModelsViaAcp(PI_ACP_PROFILE, {
        enabled: true,
        binaryPath: "/definitely/not/installed/pi-acp",
        customModels: [],
      });

      expect(models).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("buildInitialAcpAgentProviderSnapshot", (it) => {
  it.effect("reports a disabled provider without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpAgentProviderSnapshot(makeTestProfile(), {
        enabled: false,
        binaryPath: "",
        customModels: ["custom-model"],
      });

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toBe("Test Agent is disabled in T3 Code settings.");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["custom-model"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkAcpAgentProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpAgentProviderStatus(makeTestProfile(), {
        enabled: true,
        binaryPath: "/definitely/not/installed/test-agent",
        customModels: [],
      });

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports ready with the first stdout line as the version", () =>
    Effect.gen(function* () {
      // `prime-agent --version` also prints a git warning on stderr; the probe
      // must read the version from stdout only.
      const binaryPath = yield* writeExecutable("acp-agent-version-", [
        "#!/bin/sh",
        'printf "fatal: not a git repository\\n" >&2',
        'printf "0.8.0\\n"',
      ]);

      const snapshot = yield* checkAcpAgentProviderStatus(
        makeTestProfile({
          discoverModels: () =>
            Effect.succeed([
              {
                slug: "anthropic/claude-fable-5",
                name: "anthropic/claude-fable-5",
                isCustom: false,
                capabilities: { optionDescriptors: [] },
              },
            ]),
        }),
        { enabled: true, binaryPath, customModels: ["extra-model"] },
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.8.0");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-fable-5",
        "extra-model",
      ]);
    }),
  );

  it.effect("uses the profile's dedicated version command", () =>
    Effect.gen(function* () {
      const versionBinaryPath = yield* writeExecutable("acp-agent-version-command-", [
        "#!/bin/sh",
        'printf "0.84.4\\n"',
      ]);

      const snapshot = yield* checkAcpAgentProviderStatus(
        makeTestProfile({
          versionCommand: (_settings, environment) => ({
            command: environment?.PI_ACP_PI_COMMAND ?? "pi",
            args: ["--version"],
          }),
          discoverModels: () =>
            Effect.succeed([
              {
                slug: "anthropic/claude-fable-5",
                name: "anthropic/claude-fable-5",
                isCustom: false,
                capabilities: { optionDescriptors: [] },
              },
            ]),
        }),
        {
          enabled: true,
          binaryPath: "/binary/that-must-not-be-used-for-version",
          customModels: [],
        },
        {
          PATH: "/usr/bin:/bin",
          PI_ACP_PI_COMMAND: versionBinaryPath,
        },
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.84.4");
    }),
  );

  it.effect("warns when the agent is installed but advertises no models", () =>
    Effect.gen(function* () {
      const binaryPath = yield* writeExecutable("acp-agent-empty-", [
        "#!/bin/sh",
        'printf "0.0.33\\n"',
      ]);

      const snapshot = yield* checkAcpAgentProviderStatus(makeTestProfile(), {
        enabled: true,
        binaryPath,
        customModels: [],
      });

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBe("0.0.33");
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("reports an installed agent as unhealthy when the version probe exits non-zero", () =>
    Effect.gen(function* () {
      const binaryPath = yield* writeExecutable("acp-agent-broken-", [
        "#!/bin/sh",
        'printf "broken install\\n" >&2',
        "exit 2",
      ]);

      const snapshot = yield* checkAcpAgentProviderStatus(makeTestProfile(), {
        enabled: true,
        binaryPath,
        customModels: [],
      });

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Test Agent is installed but failed to run.");
      expect(snapshot.message).not.toContain("broken install");
    }),
  );
});
