import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { AcpAgentBinarySettings, AcpAgentProfile } from "../provider/acp/AcpAgentProfile.ts";
import * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import { applyAcpAgentModelSelection } from "../provider/Layers/AcpAgentAdapter.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const ACP_AGENT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);
const makeJsonDecoder = <S extends Schema.Top>(schema: S) =>
  Schema.decodeEffect(Schema.fromJsonString(schema));

export const makeAcpAgentTextGeneration = Effect.fn("makeAcpAgentTextGeneration")(function* <
  Settings extends AcpAgentBinarySettings,
>(profile: AcpAgentProfile<Settings>, settings: Settings, environment?: NodeJS.ProcessEnv) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const runJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const output = yield* Ref.make("");
      const scope = yield* Scope.Scope;
      const runtime = yield* AcpSessionRuntime.make({
        spawn: profile.buildSpawnInput(
          settings,
          input.cwd,
          resolvedEnvironment,
          input.modelSelection,
        ),
        cwd: input.cwd,
        clientInfo: { name: `${profile.clientInfoName}-text`, version: "0.0.0" },
        clientCapabilities: profile.clientCapabilities,
        ...(profile.authMethodId ? { authMethodId: profile.authMethodId } : {}),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(output, (current) => current + text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* applyAcpAgentModelSelection({
          runtime,
          strategy: profile.modelStrategy,
          model: input.modelSelection.model,
          selections: input.modelSelection.options,
        });
        return yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
      }).pipe(
        Effect.timeoutOption(ACP_AGENT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${profile.presentation.displayName} request timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: `${profile.presentation.displayName} ACP request failed.`,
                cause,
              }),
        ),
      );

      const raw = (yield* Ref.get(output)).trim();
      if (!raw) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${profile.presentation.displayName} ACP request was cancelled.`
              : `${profile.presentation.displayName} returned empty output.`,
        });
      }
      const decodeOutput = makeJsonDecoder(input.outputSchemaJson);
      return yield* decodeOutput(extractJsonObject(raw)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: `${profile.presentation.displayName} returned invalid structured output.`,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: `${profile.presentation.displayName} ACP text generation failed.`,
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AcpAgentTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AcpAgentTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AcpAgentTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AcpAgentTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return TextGeneration.TextGeneration.of({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  });
});
