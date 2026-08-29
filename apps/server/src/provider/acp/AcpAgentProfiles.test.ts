import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ModelSelection } from "@t3tools/contracts";

import { buildPiAcpSpawnInput, PI_ACP_PROFILE } from "./PiAcpProfile.ts";
import { buildPrimeAcpSpawnInput, PRIME_ACP_PROFILE } from "./PrimeAcpProfile.ts";

const decodeModelSelection = Schema.decodeSync(ModelSelection);

const PI_SETTINGS = { enabled: true, binaryPath: "", customModels: [] } as const;
const PRIME_SETTINGS = {
  enabled: true,
  binaryPath: "",
  customModels: [],
  defaultThinking: "medium",
} as const;

describe("buildPiAcpSpawnInput", () => {
  it("spawns the default bridge with no arguments", () => {
    expect(buildPiAcpSpawnInput(PI_SETTINGS, "/work")).toEqual({
      command: "pi-acp",
      args: [],
      cwd: "/work",
    });
  });

  it("honours a configured binary path and forwards the environment", () => {
    expect(
      buildPiAcpSpawnInput({ ...PI_SETTINGS, binaryPath: "  /opt/bin/pi-acp  " }, "/work", {
        PATH: "/usr/bin",
      }),
    ).toEqual({
      command: "/opt/bin/pi-acp",
      args: [],
      cwd: "/work",
      env: { PATH: "/usr/bin" },
    });
  });
});

describe("buildPrimeAcpSpawnInput", () => {
  it("uses the configured default thinking level when no selection is present", () => {
    expect(buildPrimeAcpSpawnInput(PRIME_SETTINGS, "/work")).toEqual({
      command: "prime-agent",
      args: ["--mode", "acp", "--thinking", "medium"],
      cwd: "/work",
    });
  });

  it("passes the selected model and reasoning effort as spawn args", () => {
    const modelSelection = decodeModelSelection({
      instanceId: "prime",
      model: "anthropic/claude-fable-5",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });

    expect(
      buildPrimeAcpSpawnInput(
        { ...PRIME_SETTINGS, binaryPath: "/opt/bin/prime-agent" },
        "/work",
        { PATH: "/usr/bin" },
        modelSelection,
      ),
    ).toEqual({
      command: "/opt/bin/prime-agent",
      args: ["--mode", "acp", "--model", "anthropic/claude-fable-5", "--thinking", "xhigh"],
      cwd: "/work",
      env: { PATH: "/usr/bin" },
    });
  });

  it("falls back to the settings default when the selection omits reasoning effort", () => {
    const modelSelection = decodeModelSelection({
      instanceId: "prime",
      model: "kimi-coding/k3",
    });

    expect(
      buildPrimeAcpSpawnInput(
        { ...PRIME_SETTINGS, defaultThinking: "low" },
        "/work",
        undefined,
        modelSelection,
      ),
    ).toEqual({
      command: "prime-agent",
      args: ["--mode", "acp", "--model", "kimi-coding/k3", "--thinking", "low"],
      cwd: "/work",
    });
  });

  it("falls back to `medium` when no default thinking level is configured", () => {
    expect(
      buildPrimeAcpSpawnInput({ ...PRIME_SETTINGS, defaultThinking: "  " }, "/work").args,
    ).toEqual(["--mode", "acp", "--thinking", "medium"]);
  });
});

describe("profile metadata", () => {
  it("describes Pi as a config-option model picker with ACP session resume", () => {
    expect(PI_ACP_PROFILE.driverKind).toBe("pi");
    expect(PI_ACP_PROFILE.presentation).toEqual({
      displayName: "Pi",
      badgeLabel: "Fork",
      showInteractionModeToggle: false,
      requiresNewThreadForModelChange: false,
    });
    expect(PI_ACP_PROFILE.authMethodId).toBe("pi_terminal_login");
    expect(PI_ACP_PROFILE.modelStrategy).toEqual({ kind: "configOption", configId: "model" });
    expect(PI_ACP_PROFILE.versionArgs).toEqual(["--version"]);
    expect(PI_ACP_PROFILE.resumeSupport).toBe("acpLoadSession");
    expect(PI_ACP_PROFILE.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });

  it("describes Prime as a spawn-arg model picker that needs a new thread per model", () => {
    expect(PRIME_ACP_PROFILE.driverKind).toBe("prime");
    expect(PRIME_ACP_PROFILE.presentation.displayName).toBe("Prime Agent");
    expect(PRIME_ACP_PROFILE.presentation.requiresNewThreadForModelChange).toBe(true);
    expect(PRIME_ACP_PROFILE.authMethodId).toBeUndefined();
    expect(PRIME_ACP_PROFILE.modelStrategy).toEqual({ kind: "spawnArgs" });
    expect(PRIME_ACP_PROFILE.versionArgs).toEqual(["--version"]);
    expect(PRIME_ACP_PROFILE.resumeSupport).toBe("none");
  });
});
