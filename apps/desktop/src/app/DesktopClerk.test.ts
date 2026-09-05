import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeDesktopClerkLayer = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "linux",
  ownsSingleInstanceLock = true,
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    platform,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-dev" : "t3code",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return ownsSingleInstanceLock;
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events)));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("acquires the macOS lock for the resolved userData before creating the bridge", () => {
    const events: string[] = [];
    const cleanup = vi.fn();
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events, "darwin")));

      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/t3code-dev",
        "requestSingleInstanceLock",
        "createClerkBridge",
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
    });
  });

  it.effect("quits a secondary macOS instance before the bridge or downstream layers start", () => {
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const downstreamLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* DesktopClerk.DesktopClerk;
        events.push("startBackend");
      }),
    ).pipe(Layer.provide(makeDesktopClerkLayer(true, events, "darwin", false)));

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(downstreamLayer)));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/t3code-dev",
        "requestSingleInstanceLock",
        "quit",
      ]);
      assert.equal(storageMock.mock.calls.length, 0);
      assert.equal(createClerkBridgeMock.mock.calls.length, 0);
    });
  });

  it.effect.each(["win32", "linux"] as const)(
    "leaves single-instance locking to Clerk on %s",
    (platform) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });

      return Effect.gen(function* () {
        yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events, platform, false)));

        assert.deepEqual(events, [
          "setPath:userData:/tmp/app-data/t3code-dev",
          "createClerkBridge",
        ]);
      });
    },
  );

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.effect("reveals the current window when a second instance opens", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const listeners: Array<() => void> = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string, listener: () => void) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
          listeners.push(listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const mainWindow = { id: 42 } as Electron.BrowserWindow;
      const revealed = yield* Deferred.make<Electron.BrowserWindow>();
      const electronWindow = {
        currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
        reveal: (window: Electron.BrowserWindow) => Deferred.succeed(revealed, window),
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* clerk.configure;
            assert.equal(listeners.length, 1);
            listeners[0]!();
            assert.strictEqual(yield* Deferred.await(revealed), mainWindow);
          }),
        ).pipe(Effect.provideService(ElectronWindow.ElectronWindow, electronWindow)),
      );

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance"]);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });
});
