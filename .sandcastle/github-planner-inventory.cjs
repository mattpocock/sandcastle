const { execFileSync } = require("node:child_process");

function explicitBlockerNumbers(body) {
  const references = new Set();
  let inDependencySection = false;

  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      inDependencySection = /^(blocked by|depends on):?$/i.test(heading[1]);
      continue;
    }
    if (!inDependencySection) continue;
    for (const match of line.matchAll(/#(\d+)/g)) {
      references.add(Number(match[1]));
    }
  }

  return [...references].sort((left, right) => left - right);
}

function enrichPlannerInventory(openIssues, loadIssue) {
  const known = new Map(
    openIssues.map(({ number, title, state }) => [
      number,
      { number, title, state },
    ]),
  );

  return openIssues.map((issue) => {
    const blockers = explicitBlockerNumbers(issue.body ?? "").map((number) => {
      const existing = known.get(number);
      if (existing) return existing;
      const loaded = loadIssue(number);
      known.set(number, loaded);
      return loaded;
    });

    return {
      ...issue,
      blockers,
      explicitBlockersResolved: blockers.every(
        ({ state }) => state === "CLOSED",
      ),
    };
  });
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function loadPlannerInventory(args = process.argv.slice(2)) {
  const openIssues = ghJson([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    ...args,
    "--json",
    "number,title,state,body,labels,comments",
  ]).map((issue) => ({
    ...issue,
    labels: issue.labels.map(({ name }) => name),
    comments: issue.comments.map(({ body }) => body),
  }));

  return enrichPlannerInventory(openIssues, (number) =>
    ghJson(["issue", "view", String(number), "--json", "number,title,state"]),
  );
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(loadPlannerInventory())}\n`);
}

module.exports = {
  enrichPlannerInventory,
  explicitBlockerNumbers,
  loadPlannerInventory,
};
