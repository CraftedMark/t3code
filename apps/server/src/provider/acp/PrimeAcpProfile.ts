import { type ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { discoverPrimeModels, PRIME_DEFAULT_THINKING_LEVEL } from "../Layers/AcpAgentProvider.ts";
import {
  ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
  type AcpAgentBinarySettings,
  type AcpAgentProfile,
} from "./AcpAgentProfile.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Settings slice the Prime profile reads. Mirrors `PrimeSettings` structurally;
 * `defaultThinking` is Prime-only because thinking is a spawn argument, not a
 * session config option.
 */
export interface PrimeAcpSettings extends AcpAgentBinarySettings {
  readonly defaultThinking: string;
}

export const PRIME_DEFAULT_BINARY = "prime-agent";

/**
 * Prime picks its model and thinking level at spawn time, so both come from the
 * thread's model selection (falling back to the configured default).
 */
export function buildPrimeAcpSpawnInput(
  settings: PrimeAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  modelSelection?: ModelSelection | null,
): AcpSessionRuntime.AcpSpawnInput {
  const model = modelSelection?.model?.trim();
  const thinking =
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")?.trim() ||
    settings.defaultThinking.trim() ||
    PRIME_DEFAULT_THINKING_LEVEL;
  return {
    command: settings.binaryPath.trim() || PRIME_DEFAULT_BINARY,
    args: ["--mode", "acp", ...(model ? ["--model", model] : []), "--thinking", thinking],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const PRIME_ACP_PROFILE: AcpAgentProfile<PrimeAcpSettings> = {
  driverKind: ProviderDriverKind.make("prime"),
  presentation: {
    displayName: "Prime Agent",
    badgeLabel: "Fork",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: true,
  },
  clientInfoName: "t3-code",
  clientCapabilities: ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES,
  buildSpawnInput: buildPrimeAcpSpawnInput,
  modelStrategy: { kind: "spawnArgs" },
  versionCommand: (settings) => ({
    command: settings.binaryPath.trim() || PRIME_DEFAULT_BINARY,
    args: ["--version"],
  }),
  discoverModels: (settings, environment) => discoverPrimeModels(settings, environment),
  resumeSupport: "none",
};
