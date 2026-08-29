import type { ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAcpAgentTextGeneration } from "../../textGeneration/AcpAgentTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { AcpAgentBinarySettings, AcpAgentProfile } from "../acp/AcpAgentProfile.ts";
import { makeAcpAgentAdapter } from "../Layers/AcpAgentAdapter.ts";
import {
  buildInitialAcpAgentProviderSnapshot,
  checkAcpAgentProviderStatus,
  enrichAcpAgentSnapshot,
} from "../Layers/AcpAgentProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

export type AcpAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export function makeAcpAgentDriver<Settings extends AcpAgentBinarySettings>(input: {
  readonly profile: AcpAgentProfile<Settings>;
  readonly configSchema: Schema.Codec<Settings, unknown>;
  readonly defaultConfig: () => Settings;
}): ProviderDriver<Settings, AcpAgentDriverEnv> {
  const { profile } = input;
  const update = makeStaticProviderMaintenanceResolver(
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: profile.driverKind,
      packageName: null,
    }),
  );
  const stampIdentity =
    (identity: {
      readonly instanceId: ProviderInstance["instanceId"];
      readonly displayName: string | undefined;
      readonly accentColor: string | undefined;
      readonly continuationGroupKey: string;
    }) =>
    (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: identity.instanceId,
      driver: profile.driverKind,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.accentColor ? { accentColor: identity.accentColor } : {}),
      continuation: { groupKey: identity.continuationGroupKey },
    });

  return {
    driverKind: profile.driverKind,
    metadata: {
      displayName: profile.presentation.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: input.configSchema,
    defaultConfig: input.defaultConfig,
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const serverSettings = yield* ServerSettingsService;
        const { cwd } = yield* ServerConfig;
        yield* ProviderEventLoggers;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: profile.driverKind,
          instanceId,
        });
        const stamp = stampIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const effectiveConfig = { ...config, enabled } satisfies Settings;
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          update,
          {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          },
        );
        const adapter = yield* makeAcpAgentAdapter(profile, effectiveConfig, {
          environment: processEnv,
          instanceId,
        });
        const textGeneration = yield* makeAcpAgentTextGeneration(
          profile,
          effectiveConfig,
          processEnv,
        );
        const checkProvider = checkAcpAgentProviderStatus(
          profile,
          effectiveConfig,
          processEnv,
          cwd,
        ).pipe(
          Effect.map(stamp),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<Settings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialAcpAgentProviderSnapshot(profile, settings.provider).pipe(
              Effect.map(stamp),
            ),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            enrichAcpAgentSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
              httpClient,
            }),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: profile.driverKind,
                instanceId,
                detail: `Failed to build ${profile.presentation.displayName} snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );
        return {
          instanceId,
          driverKind: profile.driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
}
