import { ProviderDriverKind } from "@t3tools/contracts";

import { discoverPiModelsViaAcp } from "../Layers/AcpAgentProvider.ts";
import {
  ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
  type AcpAgentBinarySettings,
  type AcpAgentProfile,
} from "./AcpAgentProfile.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Settings slice the Pi profile reads. Mirrors `PiSettings` structurally. */
export type PiAcpSettings = AcpAgentBinarySettings;

export const PI_DEFAULT_BINARY = "pi-acp";
/** pi-acp accepts any auth method id; this is the one it advertises. */
export const PI_AUTH_METHOD_ID = "pi_terminal_login";

/** `pi-acp` speaks ACP on stdio with no arguments; it spawns `pi --mode rpc`. */
export function buildPiAcpSpawnInput(
  settings: PiAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath.trim() || PI_DEFAULT_BINARY,
    args: [],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const PI_ACP_PROFILE: AcpAgentProfile<PiAcpSettings> = {
  driverKind: ProviderDriverKind.make("pi"),
  presentation: {
    displayName: "Pi",
    badgeLabel: "Fork",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
  },
  clientInfoName: "t3-code",
  clientCapabilities: ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
  authMethodId: PI_AUTH_METHOD_ID,
  buildSpawnInput: buildPiAcpSpawnInput,
  modelStrategy: { kind: "configOption", configId: "model" },
  versionArgs: ["--version"],
  discoverModels: (settings, environment, cwd) =>
    discoverPiModelsViaAcp(PI_ACP_PROFILE, settings, environment, cwd),
  resumeSupport: "acpLoadSession",
};
