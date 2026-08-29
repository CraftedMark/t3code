import type { ModelSelection, ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { ServerProviderPresentation } from "../providerSnapshot.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Minimal settings shape every profile-driven ACP agent shares. Declared
 * structurally (rather than importing a concrete `*Settings` contract) so the
 * generic layer stays decoupled from any one driver's settings schema.
 */
export interface AcpAgentBinarySettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<string>;
}

/**
 * How the profile steers model selection.
 *
 * - `configOption`: the agent negotiates models through an ACP session config
 *   option (`session/set_config_option`), so a running session can switch.
 * - `spawnArgs`: the model is fixed at spawn time, so switching needs a new
 *   process (pair with `presentation.requiresNewThreadForModelChange`).
 */
export type AcpAgentModelStrategy =
  | { readonly kind: "configOption"; readonly configId: string }
  | { readonly kind: "spawnArgs" };

/**
 * Everything the generic ACP layers need to drive one agent CLI. Two profiles
 * (Pi, Prime) replace what would otherwise be two near-identical adapters.
 */
export interface AcpAgentProfile<Settings extends AcpAgentBinarySettings> {
  /** Registry key for this driver — also what threads/settings persist. */
  readonly driverKind: ProviderDriverKind;
  /** Labels and toggles the Settings UI renders for this provider. */
  readonly presentation: ServerProviderPresentation;
  /** `clientInfo.name` sent on ACP `initialize`. */
  readonly clientInfoName: string;
  /** Capabilities advertised on ACP `initialize` (fs access, terminal, `_meta`). */
  readonly clientCapabilities: EffectAcpSchema.ClientCapabilities;
  /** Auth method passed to ACP `authenticate`; omit when the agent has none. */
  readonly authMethodId?: string;
  /** Builds the child-process spawn for one ACP session (or probe). */
  readonly buildSpawnInput: (
    settings: Settings,
    cwd: string,
    environment?: NodeJS.ProcessEnv,
    modelSelection?: ModelSelection | null,
  ) => AcpSessionRuntime.AcpSpawnInput;
  /** Where the selected model is applied — session config option or spawn args. */
  readonly modelStrategy: AcpAgentModelStrategy;
  /** Command used for the installed/version probe. */
  readonly versionCommand: (
    settings: Settings,
    environment?: NodeJS.ProcessEnv,
  ) => {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
  /** Model catalog lookup. Never fails: an unreachable agent yields `[]`. */
  readonly discoverModels: (
    settings: Settings,
    environment: NodeJS.ProcessEnv | undefined,
    cwd: string | undefined,
  ) => Effect.Effect<
    ReadonlyArray<ServerProviderModel>,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >;
  /** Whether a stored session can be resumed via ACP `session/load`. */
  readonly resumeSupport: "acpLoadSession" | "none";
}

/**
 * Default capabilities for a T3-hosted ACP agent: the client serves file reads
 * and writes plus terminals, which is what both Pi and Prime expect.
 */
export const ACP_AGENT_DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
} satisfies EffectAcpSchema.ClientCapabilities;
