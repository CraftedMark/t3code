import { describe, expect, it, vi } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  applyAcpAgentModelSelection,
  runAcpAgentPromptLifecycle,
  withAcpAgentTurnPermit,
} from "./AcpAgentAdapter.ts";

const provider = ProviderDriverKind.make("pi");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");

function makeSession(): ProviderSession {
  return {
    provider,
    providerInstanceId: ProviderInstanceId.make("pi"),
    status: "ready",
    runtimeMode: "approval-required",
    cwd: "/tmp/project",
    model: "anthropic/claude-sonnet-4",
    threadId,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

describe("applyAcpAgentModelSelection", () => {
  it.effect("writes the profile model config option and additional selections", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const runtime = {
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => calls.push([id, value] as const)),
      };
      yield* applyAcpAgentModelSelection({
        runtime,
        strategy: { kind: "configOption", configId: "model" },
        model: "anthropic/claude-sonnet-4",
        selections: [
          { id: "reasoningEffort", value: "high" },
          { id: "tools", value: true },
        ],
      });
      expect(calls).toEqual([
        ["model", "anthropic/claude-sonnet-4"],
        ["thought_level", "high"],
        ["tools", true],
      ]);
    }),
  );

  it.effect("does not write model options for spawn-argument profiles", () =>
    Effect.gen(function* () {
      const setConfigOption = vi.fn(() => Effect.void);
      yield* applyAcpAgentModelSelection({
        runtime: { setConfigOption },
        strategy: { kind: "spawnArgs" },
        model: "openai/gpt-5",
        selections: [{ id: "reasoningEffort", value: "max" }],
      });
      expect(setConfigOption).not.toHaveBeenCalled();
    }),
  );
});

describe("runAcpAgentPromptLifecycle", () => {
  it.effect("serializes concurrent turns before lifecycle state can overlap", () =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const first = yield* withAcpAgentTurnPermit(
        semaphore,
        Effect.gen(function* () {
          order.push("first-enter");
          yield* Deferred.succeed(firstEntered, undefined);
          yield* Deferred.await(releaseFirst);
          order.push("first-exit");
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const second = yield* withAcpAgentTurnPermit(
        semaphore,
        Effect.gen(function* () {
          order.push("second-enter");
          yield* Deferred.succeed(secondEntered, undefined);
        }),
      ).pipe(Effect.forkChild);
      expect(order).toEqual(["first-enter"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Deferred.await(secondEntered);
      yield* Fiber.join(second);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    }),
  );

  it.effect("drains runtime events before completion and restores a ready session", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const context = { session: makeSession(), activeTurnId: undefined };
      const publish = (event: ProviderRuntimeEvent) =>
        Effect.sync(() => {
          order.push(`${event.type}:${context.session.status}:${context.activeTurnId ?? "none"}`);
        });
      const result = yield* runAcpAgentPromptLifecycle({
        context,
        provider,
        threadId,
        turnId,
        activeModel: "anthropic/claude-sonnet-4",
        promptEffect: Effect.sync(() => {
          order.push("prompt");
          return { stopReason: "end_turn" as const };
        }),
        drainEvents: Effect.sync(() => order.push("drain")),
        nowIso: Effect.succeed("2026-08-29T00:00:01.000Z"),
        stamp: () =>
          Effect.succeed({
            eventId: EventId.make("event-1"),
            createdAt: "2026-08-29T00:00:01.000Z",
          }),
        publish,
      });
      expect(result.stopReason).toBe("end_turn");
      expect(order).toEqual([
        "turn.started:running:turn-1",
        "prompt",
        "drain",
        "turn.completed:running:turn-1",
      ]);
      expect(context.session.status).toBe("ready");
      expect(context.session.activeTurnId).toBeUndefined();
      expect(context.activeTurnId).toBeUndefined();
    }),
  );

  it.effect("settles failed prompts after draining and clears active turn state", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const terminalEvents: Array<ProviderRuntimeEvent> = [];
      const context = { session: makeSession(), activeTurnId: undefined };
      const failure = new ProviderAdapterRequestError({
        provider,
        method: "session/prompt",
        detail: "mock failure",
      });
      const exit = yield* Effect.exit(
        runAcpAgentPromptLifecycle({
          context,
          provider,
          threadId,
          turnId,
          activeModel: context.session.model,
          promptEffect: Effect.fail(failure),
          drainEvents: Effect.sync(() => order.push("drain")),
          nowIso: Effect.succeed("2026-08-29T00:00:01.000Z"),
          stamp: () =>
            Effect.succeed({
              eventId: EventId.make("event-2"),
              createdAt: "2026-08-29T00:00:01.000Z",
            }),
          publish: (event) =>
            Effect.sync(() => {
              order.push(event.type);
              terminalEvents.push(event);
            }),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(order).toEqual(["turn.started", "drain", "turn.completed"]);
      expect(terminalEvents.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "failed", stopReason: null },
      });
      expect(context.session.status).toBe("ready");
      expect(context.session.activeTurnId).toBeUndefined();
      expect(context.activeTurnId).toBeUndefined();
    }),
  );
});
