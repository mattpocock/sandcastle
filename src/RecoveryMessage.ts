export type FailedStep = "commits" | "diff" | "untracked";

export interface RecoveryInput {
  readonly patchDir: string;
  readonly failedStep: FailedStep;
  readonly hasCommits: boolean;
  readonly hasDiff: boolean;
  readonly hasUntracked: boolean;
  readonly branch?: string;
}

interface RecoveryStep {
  readonly key: FailedStep;
  readonly label: string;
  readonly has: boolean;
}

/** The steps that had changes, in the order they are applied. */
const stepsWithChanges = (input: RecoveryInput): RecoveryStep[] => {
  const steps: RecoveryStep[] = [
    { key: "commits", label: "committed changes", has: input.hasCommits },
    { key: "diff", label: "uncommitted changes", has: input.hasDiff },
    { key: "untracked", label: "untracked files", has: input.hasUntracked },
  ];
  return steps.filter((step) => step.has);
};

/** git am failure — lean on git's built-in workflow, then the rest. */
const gitAmResolution = (remaining: string[]): string[] => [
  "Resolve conflicts, then continue with:",
  `  git am --continue`,
  ...(remaining.length > 0
    ? [
        "",
        "After all commits are applied, run the remaining steps:",
        formatCommandBlock(remaining),
      ]
    : []),
];

/** diff or untracked failure — the commands from the failed step onward. */
const applyResolution = (remaining: string[]): string[] =>
  remaining.length > 0
    ? ["Run the remaining steps:", formatCommandBlock(remaining)]
    : [];

/**
 * Build copy-pastable recovery commands for a failed sync-out.
 * Pure function: takes failure state, returns formatted terminal output.
 */
export const buildRecoveryMessage = (input: RecoveryInput): string => {
  const { patchDir, failedStep, branch } = input;

  // When --branch is set, commands run inside .sandcastle/worktree,
  // so patch paths need ../../ prefix to reach repo root
  const hasBranch = branch !== undefined && branch !== "";
  const cmdPatchDir = hasBranch ? `../../${patchDir}` : patchDir;

  const steps = stepsWithChanges(input);
  const failedIndex = steps.findIndex((s) => s.key === failedStep);
  const failedStepInfo = steps[failedIndex];
  if (failedStepInfo === undefined) {
    throw new Error(
      `Recovery step "${failedStep}" failed, but it had no changes to apply.`,
    );
  }

  // Worktree setup preamble for --branch
  const preamble = hasBranch
    ? [
        "Set up worktree, then resolve:",
        formatCommandBlock([
          `git worktree add .sandcastle/worktree ${branch}`,
          `cd .sandcastle/worktree`,
        ]),
        "",
      ]
    : [];

  // git am resumes the failed step itself, so only the later steps remain.
  const resolution =
    failedStep === "commits"
      ? gitAmResolution(
          buildRemainingCommands(cmdPatchDir, steps.slice(failedIndex + 1)),
        )
      : applyResolution(
          buildRemainingCommands(cmdPatchDir, steps.slice(failedIndex)),
        );

  return [
    `Patch application failed at step ${failedIndex + 1} (${failedStepInfo.label}).`,
    "",
    ...preamble,
    ...resolution,
  ].join("\n");
};

const buildRemainingCommands = (
  patchDir: string,
  steps: { key: FailedStep; has: boolean }[],
): string[] => {
  const commands: string[] = [];
  for (const step of steps) {
    if (!step.has) {
      continue;
    }
    if (step.key === "commits") {
      commands.push(`git am --3way ${patchDir}/*.patch`);
    } else if (step.key === "diff") {
      commands.push(`git apply ${patchDir}/changes.patch`);
    } else if (step.key === "untracked") {
      commands.push(`cp -r ${patchDir}/untracked/* .`);
    }
  }
  return commands;
};

const formatCommandBlock = (commands: string[]): string => {
  if (commands.length === 1) {
    return `  ${commands[0]}`;
  }
  // Join with && \ continuation
  return commands
    .map((cmd, i) => (i < commands.length - 1 ? `  ${cmd} && \\` : `  ${cmd}`))
    .join("\n");
};
