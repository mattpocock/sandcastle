export type FailedStep = "previousDiff" | "commits" | "diff" | "untracked";

export interface RecoveryInput {
  readonly patchDir: string;
  readonly failedStep: FailedStep;
  readonly hasPreviousDiff?: boolean;
  readonly hasCommits: boolean;
  readonly hasDiff: boolean;
  readonly hasUntracked: boolean;
  readonly branch?: string;
}

/**
 * Build copy-pastable recovery commands for a failed sync-out.
 * Pure function: takes failure state, returns formatted terminal output.
 */
export const buildRecoveryMessage = (input: RecoveryInput): string => {
  const {
    patchDir,
    failedStep,
    hasPreviousDiff,
    hasCommits,
    hasDiff,
    hasUntracked,
    branch,
  } = input;

  // When --branch is set, commands run inside .sandcastle/worktree,
  // so patch paths need ../../ prefix to reach repo root
  const cmdPatchDir = branch ? `../../${patchDir}` : patchDir;

  // Determine the step number for the failed step
  const steps: { key: FailedStep; label: string; has: boolean }[] = [];
  if (hasPreviousDiff)
    steps.push({
      key: "previousDiff",
      label: "previously synced uncommitted changes",
      has: true,
    });
  if (hasCommits)
    steps.push({ key: "commits", label: "committed changes", has: true });
  if (hasDiff)
    steps.push({ key: "diff", label: "uncommitted changes", has: true });
  if (hasUntracked)
    steps.push({ key: "untracked", label: "untracked files", has: true });

  const failedIndex = steps.findIndex((s) => s.key === failedStep);
  const failedStepInfo = steps[failedIndex]!;
  const stepNumber = failedIndex + 1;

  const lines: string[] = [];
  lines.push(
    `Patch application failed at step ${stepNumber} (${failedStepInfo.label}).`,
  );
  lines.push("");

  // Add worktree setup preamble for --branch
  if (branch) {
    lines.push("Set up worktree, then resolve:");
    lines.push(
      formatCommandBlock([
        `git worktree add .sandcastle/worktree ${branch}`,
        `cd .sandcastle/worktree`,
      ]),
    );
    lines.push("");
  }

  if (failedStep === "commits") {
    // git am failure — lean on git's built-in workflow
    lines.push("Resolve conflicts, then continue with:");
    lines.push(`  git am --continue`);

    // Remaining steps after git am resolves
    const remaining = buildRemainingCommands(
      cmdPatchDir,
      steps.slice(failedIndex + 1),
    );
    if (remaining.length > 0) {
      lines.push("");
      lines.push("After all commits are applied, run the remaining steps:");
      lines.push(formatCommandBlock(remaining));
    }
  } else {
    // Print remaining commands from the failed step onward.
    const remaining = buildRemainingCommands(
      cmdPatchDir,
      steps.slice(failedIndex),
    );
    if (remaining.length > 0) {
      lines.push("Run the remaining steps:");
      lines.push(formatCommandBlock(remaining));
    }
  }

  return lines.join("\n");
};

const buildRemainingCommands = (
  patchDir: string,
  steps: { key: FailedStep; has: boolean }[],
): string[] => {
  const commands: string[] = [];
  for (const step of steps) {
    if (!step.has) continue;
    if (step.key === "previousDiff") {
      commands.push(`git apply --reverse ${patchDir}/previous.diff`);
    } else if (step.key === "commits") {
      commands.push(`git am --3way ${patchDir}/[0-9]*.patch`);
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
