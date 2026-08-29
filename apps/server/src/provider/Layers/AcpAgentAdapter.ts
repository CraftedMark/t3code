import {
  ApprovalRequestId,
  EventId,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrorsModule from "effect-acp/errors";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type {
  AcpAgentBinarySettings,
  AcpAgentModelStrategy,
  AcpAgentProfile,
} from "../acp/AcpAgentProfile.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const RESUME_SCHEMA_VERSION = 1 as const;

interface ModelSelectionRuntime {
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

const configIdFromSelection = (selection: ProviderOptionSelection): string =>
  selection.id === "reasoningEffort" ? "thought_level" : selection.id;

/** Applies model controls only for agents that negotiate them through ACP. */
export function applyAcpAgentModelSelection<E = EffectAcpErrors.AcpError>(input: {
  readonly runtime: ModelSelectionRuntime;
  readonly strategy: AcpAgentModelStrategy;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError?: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  if (input.strategy.kind === "spawnArgs") {
    return Effect.void;
  }
  const configId = input.strategy.configId;
  const mapError = input.mapError ?? ((cause: EffectAcpErrors.AcpError) => cause as E);
  return Effect.gen(function* () {
    if (input.model?.trim()) {
      yield* input.runtime
        .setConfigOption(configId, input.model.trim())
        .pipe(Effect.mapError(mapError));
    }
    for (const selection of input.selections ?? []) {
      yield* input.runtime
        .setConfigOption(configIdFromSelection(selection), selection.value)
        .pipe(Effect.mapError(mapError));
    }
  });
}

export interface AcpAgentAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly turnLock: Semaphore.Semaphore;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

export interface AcpAgentTurnLifecycleContext {
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
}

export const withAcpAgentTurnPermit = <A, E, R>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => semaphore.withPermit(effect);

export const runAcpAgentPromptLifecycle = Effect.fn("runAcpAgentPromptLifecycle")(
  function* (input: {
    readonly context: AcpAgentTurnLifecycleContext;
    readonly provider: ProviderSession["provider"];
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly activeModel: string | undefined;
    readonly promptEffect: Effect.Effect<EffectAcpSchema.PromptResponse, ProviderAdapterError>;
    readonly drainEvents: Effect.Effect<void>;
    readonly nowIso: Effect.Effect<string>;
    readonly stamp: () => Effect.Effect<
      { readonly eventId: EventId; readonly createdAt: string },
      ProviderAdapterError
    >;
    readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  }) {
    input.context.activeTurnId = input.turnId;
    input.context.session = {
      ...input.context.session,
      status: "running",
      activeTurnId: input.turnId,
      model: input.activeModel,
      updatedAt: yield* input.nowIso,
    };
    yield* input.publish({
      type: "turn.started",
      ...(yield* input.stamp()),
      provider: input.provider,
      threadId: input.threadId,
      turnId: input.turnId,
      payload: { model: input.activeModel },
    });

    const resultExit = yield* Effect.exit(input.promptEffect);
    yield* input.drainEvents;
    const terminalState = Exit.isFailure(resultExit)
      ? "failed"
      : resultExit.value.stopReason === "cancelled"
        ? "cancelled"
        : "completed";
    yield* input.publish({
      type: "turn.completed",
      ...(yield* input.stamp()),
      provider: input.provider,
      threadId: input.threadId,
      turnId: input.turnId,
      payload: {
        state: terminalState,
        stopReason: Exit.isSuccess(resultExit) ? (resultExit.value.stopReason ?? null) : null,
      },
    });
    input.context.activeTurnId = undefined;
    input.context.session = {
      ...input.context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: yield* input.nowIso,
    };
    return yield* resultExit;
  },
);

function resumeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return value.schemaVersion === RESUME_SCHEMA_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim()
    ? value.sessionId.trim()
    : undefined;
}

function autoApprovalOption(request: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  return (
    request.options.find((option) => option.kind === "allow_always")?.optionId ??
    request.options.find((option) => option.kind === "allow_once")?.optionId
  );
}

export function makeAcpAgentAdapter<Settings extends AcpAgentBinarySettings>(
  profile: AcpAgentProfile<Settings>,
  settings: Settings,
  options?: AcpAgentAdapterOptions,
) {
  return Effect.gen(function* () {
    const provider = profile.driverKind;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(provider);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, SessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate ACP runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = () =>
      Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    };

    const stopContext = (context: SessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* Effect.forEach(
          context.pendingApprovals.values(),
          ({ decision }) => Deferred.succeed(decision, "cancel").pipe(Effect.ignore),
          { discard: true },
        );
        if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(context.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* stamp()),
          provider,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== provider) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Expected provider '${provider}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const cwd = path.resolve(input.cwd.trim());
        const selection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing);

        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const turnLock = yield* Semaphore.make(1);
        let context!: SessionContext;
        const storedResume =
          profile.resumeSupport === "acpLoadSession"
            ? resumeSessionId(input.resumeCursor)
            : undefined;
        const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
        const runtime = yield* AcpSessionRuntime.make({
          spawn: profile.buildSpawnInput(settings, cwd, options?.environment, selection),
          cwd,
          clientInfo: { name: profile.clientInfoName, version: "0.0.0" },
          clientCapabilities: profile.clientCapabilities,
          ...(profile.authMethodId ? { authMethodId: profile.authMethodId } : {}),
          ...(storedResume ? { resumeSessionId: storedResume } : {}),
          ...(mcp
            ? {
                mcpServers: [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcp.endpoint,
                    headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                  },
                ],
              }
            : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((error) =>
            mapAcpToAdapterError(provider, input.threadId, "session/start", error),
          ),
        );

        yield* runtime.handleRequestPermission((request) =>
          Effect.gen(function* () {
            if (input.runtimeMode === "full-access") {
              const optionId = autoApprovalOption(request);
              if (optionId) return { outcome: { outcome: "selected" as const, optionId } };
            }
            const permissionRequest = parsePermissionRequest(request);
            const requestId = ApprovalRequestId.make(yield* randomId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision });
            yield* publish(
              makeAcpRequestOpenedEvent({
                stamp: yield* stamp(),
                provider,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: RuntimeRequestId.make(requestId),
                permissionRequest,
                detail: permissionRequest.detail ?? "ACP permission requested.",
                args: request,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: request,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* publish(
              makeAcpRequestResolvedEvent({
                stamp: yield* stamp(),
                provider,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: RuntimeRequestId.make(requestId),
                permissionRequest,
                decision: resolved,
              }),
            );
            return resolved === "cancel"
              ? { outcome: { outcome: "cancelled" as const } }
              : {
                  outcome: {
                    outcome: "selected" as const,
                    optionId: acpPermissionOutcome(resolved),
                  },
                };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrorsModule.AcpTransportError({
                  detail: "Failed to process ACP permission request.",
                  cause,
                }),
            ),
          ),
        );

        const started = yield* runtime
          .start()
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, "session/start", error),
            ),
          );
        yield* applyAcpAgentModelSelection({
          runtime,
          strategy: profile.modelStrategy,
          model: selection?.model,
          selections: selection?.options,
          mapError: (error) =>
            mapAcpToAdapterError(provider, input.threadId, "session/set_config_option", error),
        });

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: selection?.model,
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: RESUME_SCHEMA_VERSION,
            sessionId: started.sessionId,
          },
          createdAt: now,
          updatedAt: now,
        };
        context = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          acp: runtime,
          notificationFiber: undefined,
          pendingApprovals,
          turns: [],
          turnLock,
          activeTurnId: undefined,
          stopped: false,
        };

        context.notificationFiber = yield* Stream.runForEach(runtime.getEvents(), (event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "EventStreamBarrier":
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              case "ModeChanged":
                return;
              case "AssistantItemStarted":
              case "AssistantItemCompleted":
                yield* publish(
                  makeAcpAssistantItemEvent({
                    stamp: yield* stamp(),
                    provider,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    itemId: event.itemId,
                    lifecycle:
                      event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                yield* publish(
                  makeAcpPlanUpdatedEvent({
                    stamp: yield* stamp(),
                    provider,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    payload: event.payload,
                    source: "acp.jsonrpc",
                    method: "session/update",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ToolCallUpdated":
                yield* publish(
                  makeAcpToolCallEvent({
                    stamp: yield* stamp(),
                    provider,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ContentDelta":
                yield* publish(
                  makeAcpContentDeltaEvent({
                    stamp: yield* stamp(),
                    provider,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
            }
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Failed to process ACP agent runtime notification.", { cause }),
          ),
          Effect.forkIn(sessionScope),
        );
        sessions.set(input.threadId, context);
        transferred = true;

        yield* publish({
          type: "session.started",
          ...(yield* stamp()),
          provider,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* stamp()),
          provider,
          threadId: input.threadId,
          payload: {
            state: "ready",
            reason: `${profile.presentation.displayName} ACP session ready`,
          },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* stamp()),
          provider,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.scoped);

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        return yield* withAcpAgentTurnPermit(
          context.turnLock,
          Effect.gen(function* () {
            const selection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const activeModel =
              profile.modelStrategy.kind === "configOption"
                ? (selection?.model ?? context.session.model)
                : context.session.model;
            yield* applyAcpAgentModelSelection({
              runtime: context.acp,
              strategy: profile.modelStrategy,
              model: selection?.model,
              selections: selection?.options,
              mapError: (error) =>
                mapAcpToAdapterError(provider, input.threadId, "session/set_config_option", error),
            });
            const prompt: Array<EffectAcpSchema.ContentBlock> = [];
            if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
            for (const attachment of input.attachments ?? []) {
              if (attachment.type !== "image") continue;
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              prompt.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
            if (prompt.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or image attachments.",
              });
            }
            const turnId = TurnId.make(yield* randomId);
            const result = yield* runAcpAgentPromptLifecycle({
              context,
              provider,
              threadId: input.threadId,
              turnId,
              activeModel,
              promptEffect: context.acp
                .prompt({ prompt })
                .pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(provider, input.threadId, "session/prompt", error),
                  ),
                ),
              drainEvents: context.acp.drainEvents,
              nowIso,
              stamp,
              publish,
            });
            context.turns.push({ id: turnId, items: [{ prompt, result }] });
            return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
          }),
        );
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider,
      capabilities: {
        sessionModelSwitch:
          profile.modelStrategy.kind === "configOption" ? "in-session" : "unsupported",
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          yield* context.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, threadId, "session/cancel", error),
            ),
          );
        }),
      respondToRequest: (threadId, requestId, decision) =>
        requireSession(threadId).pipe(
          Effect.flatMap((context) => {
            const pending = context.pendingApprovals.get(requestId);
            return pending
              ? Deferred.succeed(pending.decision, decision).pipe(Effect.asVoid)
              : Effect.fail(
                  new ProviderAdapterRequestError({
                    provider,
                    method: "session/request_permission",
                    detail: `Unknown pending approval request: ${requestId}`,
                  }),
                );
          }),
        ),
      respondToUserInput: (threadId, requestId) =>
        requireSession(threadId).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider,
                method: "session/elicitation",
                detail: `Unknown pending user-input request: ${requestId}`,
              }),
            ),
          ),
        ),
      stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map(({ session }) => ({ ...session }))),
      hasSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.stopped === false),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((context) => ({ threadId, turns: context.turns })),
        ),
      rollbackThread: (threadId, numTurns) =>
        requireSession(threadId).pipe(
          Effect.flatMap((context) => {
            if (!Number.isInteger(numTurns) || numTurns < 1) {
              return Effect.fail(
                new ProviderAdapterValidationError({
                  provider,
                  operation: "rollbackThread",
                  issue: "numTurns must be an integer >= 1.",
                }),
              );
            }
            context.turns.splice(Math.max(0, context.turns.length - numTurns));
            return Effect.succeed({ threadId, turns: context.turns });
          }),
        ),
      stopAll: () => Effect.forEach(sessions.values(), stopContext, { discard: true }),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };

    yield* Effect.addFinalizer(() =>
      adapter.stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEvents))),
    );
    return adapter;
  });
}
