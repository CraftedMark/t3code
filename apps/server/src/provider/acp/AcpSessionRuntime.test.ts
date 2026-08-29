// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";

async function makeMockAgentWrapper(dir: string, extraEnv: Record<string, string>) {
  const wrapperPath = NodePath.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readLoggedMethods(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { readonly method?: unknown }).method)
    .filter((method): method is string => typeof method === "string");
}

// `session/new` is the last request `start()` issues, so once it is in the log
// every request that could have carried `authenticate` is too.
const waitForStartRequests = (filePath: string, attempts = 40) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const methods = yield* Effect.promise(() => readLoggedMethods(filePath));
      if (methods.includes("session/new")) {
        return methods;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.promise(() => readLoggedMethods(filePath));
  });

const startAgainstMockAgent = (options: {
  readonly authMethodId?: string | undefined;
  readonly omitAuthMethods?: boolean;
}) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-session-runtime-auth-")),
    );
    const requestLogPath = NodePath.join(dir, "requests.ndjson");
    const wrapperPath = yield* Effect.promise(() =>
      makeMockAgentWrapper(dir, {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        ...(options.omitAuthMethods ? { T3_ACP_OMIT_AUTH_METHODS: "1" } : {}),
      }),
    );

    const runtime = yield* AcpSessionRuntime.make({
      spawn: { command: wrapperPath, args: [], cwd: dir },
      cwd: dir,
      clientInfo: { name: "t3-test", version: "0.0.0" },
      authMethodId: options.authMethodId,
    });
    const started = yield* runtime.start();
    const methods = yield* waitForStartRequests(requestLogPath);
    return { started, methods };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AcpSessionRuntime authenticate", () => {
  it.effect("authenticates when an auth method id is set and the agent advertises methods", () =>
    Effect.gen(function* () {
      const { started, methods } = yield* startAgainstMockAgent({ authMethodId: "mock-login" });

      expect(methods).toContain("initialize");
      expect(methods).toContain("authenticate");
      expect(typeof started.sessionId).toBe("string");
    }),
  );

  it.effect("skips authenticate when no auth method id is configured", () =>
    Effect.gen(function* () {
      const { started, methods } = yield* startAgainstMockAgent({ authMethodId: undefined });

      expect(methods).toContain("initialize");
      expect(methods).not.toContain("authenticate");
      expect(typeof started.sessionId).toBe("string");
    }),
  );

  // prime-agent 0.8.0 advertises no authMethods and answers `authenticate`
  // with JSON-RPC -32601 Method not found.
  it.effect("skips authenticate when the agent advertises no auth methods", () =>
    Effect.gen(function* () {
      const { started, methods } = yield* startAgainstMockAgent({
        authMethodId: "mock-login",
        omitAuthMethods: true,
      });

      expect(methods).toContain("initialize");
      expect(methods).not.toContain("authenticate");
      expect(typeof started.sessionId).toBe("string");
      expect(started.sessionId.length).toBeGreaterThan(0);
    }),
  );
});
