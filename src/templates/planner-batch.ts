export interface PlannerCandidate {
  readonly id?: string | number;
  readonly number?: string | number;
  readonly explicitBlockersResolved?: boolean;
}

export interface PlannedIssue {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

export interface PlannerDecision {
  readonly id: string;
  readonly disposition:
    | "selected"
    | "blocked"
    | "not-implementation"
    | "unresolved-decision"
    | "parallel-conflict";
  readonly reason: string;
  readonly likelyAreas: readonly string[];
  readonly conflictsWith?: readonly string[];
}

export interface PlannerBatch {
  readonly issues: readonly PlannedIssue[];
  readonly decisions: readonly PlannerDecision[];
}

const candidateId = (candidate: PlannerCandidate): string => {
  const id = candidate.id ?? candidate.number;
  if (id === undefined)
    throw new Error("planner candidate is missing id/number");
  return String(id);
};

const incidentalArea = (area: string): boolean =>
  /(^|\/)(readme(?:\.md)?|docs?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\.example)?|changelog(?:\.md)?)$/i.test(
    area,
  );

const areasOverlap = (left: string, right: string): boolean =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

export function validatePlannerBatch(
  inventory: readonly PlannerCandidate[],
  plan: PlannerBatch,
): void {
  const candidates = new Map(
    inventory.map((candidate) => [candidateId(candidate), candidate]),
  );
  if (candidates.size !== inventory.length) {
    throw new Error("planner inventory contains duplicate candidate IDs");
  }

  const decisions = new Map<string, PlannerDecision>();
  for (const decision of plan.decisions) {
    if (decisions.has(decision.id)) {
      throw new Error(`duplicate planner decision for: ${decision.id}`);
    }
    if (!candidates.has(decision.id)) {
      throw new Error(
        `planner decision references unknown candidate: ${decision.id}`,
      );
    }
    if (!decision.reason.trim()) {
      throw new Error(`planner decision ${decision.id} is missing a reason`);
    }
    decisions.set(decision.id, decision);
  }

  const missing = [...candidates.keys()].filter((id) => !decisions.has(id));
  if (missing.length > 0) {
    throw new Error(`missing decisions for: ${missing.join(", ")}`);
  }

  const issues = new Map<string, PlannedIssue>();
  for (const issue of plan.issues) {
    if (issues.has(issue.id))
      throw new Error(`duplicate selected issue: ${issue.id}`);
    if (issue.branch !== `sandcastle/issue-${issue.id}`) {
      throw new Error(
        `selected issue ${issue.id} has a non-deterministic branch`,
      );
    }
    issues.set(issue.id, issue);
  }

  for (const [id, decision] of decisions) {
    const selected = decision.disposition === "selected";
    if (selected !== issues.has(id)) {
      throw new Error(`selected issue and decision disagree for: ${id}`);
    }

    const candidate = candidates.get(id)!;
    if (
      candidate.explicitBlockersResolved === false &&
      decision.disposition !== "blocked"
    ) {
      throw new Error(
        `${id} has unresolved explicit blockers and must be blocked`,
      );
    }
    if (
      decision.disposition === "blocked" &&
      candidate.explicitBlockersResolved === true
    ) {
      throw new Error(
        `${id} is marked blocked but its explicit blockers are resolved`,
      );
    }

    if (decision.disposition !== "parallel-conflict") continue;
    if (!decision.conflictsWith || decision.conflictsWith.length === 0) {
      throw new Error(`${id} is missing selected conflictsWith IDs`);
    }

    for (const conflictId of decision.conflictsWith) {
      const selectedDecision = decisions.get(conflictId);
      if (selectedDecision?.disposition !== "selected") {
        throw new Error(
          `${id} conflicts with non-selected issue ${conflictId}`,
        );
      }
      const hasSharedMaterialArea = decision.likelyAreas
        .filter((area) => !incidentalArea(area))
        .some((area) =>
          selectedDecision.likelyAreas
            .filter((selectedArea) => !incidentalArea(selectedArea))
            .some((selectedArea) => areasOverlap(area, selectedArea)),
        );
      if (!hasSharedMaterialArea) {
        throw new Error(
          `${id} has no shared material area with selected conflict ${conflictId}`,
        );
      }
    }
  }
}
