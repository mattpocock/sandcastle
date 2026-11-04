import { Data } from "effect";

/** Writing the skills into a sandbox failed. */
export class InstallSkillsError extends Data.TaggedError("InstallSkillsError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
