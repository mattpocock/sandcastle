# No automatic fallback when an agent runs out of tokens

## Context

Issue #850 asked Sandcastle to recover automatically when an **agent** hits a
provider-side token or usage limit — the kind of failure where a long run dies
because the model's context window fills up, or because a rolling usage quota
(e.g. Claude Code's 5-hour quota) is exhausted. The hoped-for behaviour is some
mix of: detect the condition, then switch model, back off, or otherwise keep the
run alive instead of failing the iteration.

There are two variants, and they fail for different reasons:

1. **Proactive detection** — notice the agent is _about_ to run out and act
   before it does. This is already ruled out by
   [ADR 0005](0005-usage-raw-tokens-no-percentage.md): Sandcastle reports raw
   token counts but cannot obtain the model's context-window size from any data
   source it reads, so it has no denominator to compare against. There is
   nothing to threshold on.

2. **Reactive detection** — notice the agent _has just_ run out, from the way it
   died, and respond. A quota crash surfaces today as a non-zero process exit,
   which becomes a thrown `AgentError` (`<provider> exited with code N:
<stderr>`) in `Orchestrator.ts`. To branch on "this exit means token
   exhaustion" rather than "this exit means anything else," Sandcastle would have
   to classify that failure.

This ADR records why we will not implement the reactive variant either.

## Decision

Sandcastle does **not** detect token/quota exhaustion and does **not** fall back
automatically when it happens. A run that dies because the agent ran out of
tokens fails the iteration like any other non-zero agent exit. Recovery is the
orchestration layer's responsibility, not core's.

The blocker is classification. The only signal a token/quota crash gives
Sandcastle is a non-zero exit code plus a human-readable `stderr` string. Exit
codes are not specific — providers reuse the same generic failure codes for
exhaustion, auth errors, network failures, and internal panics — so the exit
code alone cannot tell exhaustion apart from any other failure. That leaves
string-matching the error message, and string-matching is unacceptable here:

- **It is unversioned.** Provider error wording is not a contract. A CLI can
  reword "usage limit reached" in a patch release and silently break our
  matcher. We would be coupling core behaviour to strings the providers are free
  to change without notice.
- **No major provider gives us a better shape.** If any of the major **agent
  providers** emitted a stable, machine-readable signal for this condition — a
  dedicated exit code, a typed error event in the stream, a structured field —
  we would key off it and implement the fallback. As far as we know, none of the
  major ones do. (Compare ADR 0020, where we added _typed_ diagnostics precisely
  so downstream code would not have to parse strings.)
- **Partial coverage is worse than none.** Even if we hand-tuned matchers for
  one provider, the feature would work for a minority of the audience and quietly
  fail for everyone else, while presenting as if exhaustion is handled. A
  fallback that fires for some providers and not others is a trap, not a
  feature.

## Considered Options

- **Parse provider error messages / stderr to classify exhaustion.** Rejected —
  unversioned, breaks on patch releases, and only ever covers some providers.
  This is the core reason for the decision.
- **Threshold proactively on usage.** Rejected — no context-window size is
  available; see ADR 0005.
- **Caller-supplied model fallback list, switched on agent error.** This is the
  legitimate, mechanism-level version of the ask and is tracked separately as
  #848. It does not require Sandcastle to _classify_ the failure — the caller
  opts in to retrying on _any_ agent error with the next model — so it sidesteps
  the string-matching problem entirely. It is a reactive retry policy, not
  exhaustion detection.

## Consequences

- Token/quota exhaustion fails the iteration with a normal `AgentError`. There is
  no special-cased recovery in core.
- Resilience to crashes (including quota crashes) is handled at the
  orchestration/scaffold layer, which already supports resuming partial work via
  deterministic branch names rather than redoing it from scratch.
- This decision is revisitable the moment a major agent provider exposes a
  stable, structured signal for the condition. The blocker is the absence of a
  reliable signal, not a position that fallback is undesirable.
