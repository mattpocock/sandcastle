import { Context, Effect, Layer } from "effect";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import type { SandboxService } from "./SandboxFactory.js";
import type {
  ExecError,
  PromptError,
  PromptExpansionTimeoutError,
} from "./errors.js";

export interface PromptPreprocessorService {
  readonly preprocess: (
    prompt: string,
    sandbox: SandboxService,
    cwd: string,
  ) => Effect.Effect<
    string,
    ExecError | PromptError | PromptExpansionTimeoutError,
    Display
  >;
}

export class PromptPreprocessor extends Context.Tag("PromptPreprocessor")<
  PromptPreprocessor,
  PromptPreprocessorService
>() {}

/** Production layer — delegates to the existing shell-expression expansion. */
export const ProductionPromptPreprocessorLayer: Layer.Layer<PromptPreprocessor> =
  Layer.succeed(PromptPreprocessor, {
    preprocess: preprocessPrompt,
  });
