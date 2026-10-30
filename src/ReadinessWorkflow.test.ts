import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { getAgent, scaffold } from "./InitService.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// These executables stand in for GitHub and the model process. Sandcastle's
// orchestration, worktrees, signals, verification, and map persistence are real.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), rows = JSON.parse(fs.readFileSync(process.env.READINESS_FIXTURE_STATE, 'utf8'));
if(args[0] === 'issue') {
  if(process.env.GH_REPO !== 'owner/project') throw Error('Task command routed to wrong repository');
  const issue = rows.find(i=>i.number===Number(args[2]));
  if(args[1] === 'close') {issue.state='closed';issue.state_reason='completed';fs.writeFileSync(process.env.READINESS_FIXTURE_STATE,JSON.stringify(rows));}
  console.log(JSON.stringify(issue));process.exit(0);
}
if(args[0] !== 'api') throw Error('Only REST API expected: '+args);
const endpoint = args[1];
const number = Number(endpoint.split('/issues/')[1]?.split('/')[0]);
const issue = rows.find(i=>i.number===number);
if(args.includes('POST') || args.includes('DELETE')) {
  if(args.includes('POST')) for(const arg of args.filter(a=>a.startsWith('labels[]='))) issue.labels.push({name:arg.slice(9)});
  else issue.labels=issue.labels.filter(l=>!endpoint.endsWith('/'+encodeURIComponent(l.name)));
  fs.writeFileSync(process.env.READINESS_FIXTURE_STATE,JSON.stringify(rows)); console.log('[]');
} else if(endpoint.includes('/comments?') || endpoint.includes('/dependencies/')) console.log('[[]]');
else if(endpoint.includes('/issues?')) console.log(JSON.stringify([rows.filter(i=>i.state==='open')]));
else if(issue) console.log(JSON.stringify(issue));
else throw Error('Unexpected GitHub request '+endpoint);
`;

const fakeAgent = `
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const prompt=fs.readFileSync(0,'utf8');
if(process.env.READINESS_FIXTURE_CODEX==='1') {
  const rawLog=console.log, messages=[];
  console.log=text=>messages.push(text);
  process.on('exit',()=>rawLog(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:messages.join(String.fromCharCode(10))}})));
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const record=(value)=>fs.appendFileSync(process.env.READINESS_FIXTURE_TRACE,value+'\\n');
if(prompt.includes('MISSION — READINESS ASSESSMENT')) {
  if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN) throw Error('Tracker credential leaked');
  const {snapshot,trigger}=JSON.parse(prompt.match(/<readiness-input>([\\s\\S]*?)<\\/readiness-input>/)[1]);
  record('readiness:'+trigger.kind);
  if(process.env.READINESS_FIXTURE_DIRTY==='1') fs.writeFileSync('unauthorized.txt','dirty');
  console.log('<readiness>'+JSON.stringify({head:snapshot.head,decisions:snapshot.issues.map(i=>({number:i.number,status:i.body.includes('**Kind:** live-validation')?'not-implementation':i.dependencies.some(d=>d.state!=='closed')?'blocked':'ready-for-agent',reason:'fixture contract',evidence:[{path:'host:integration',claim:'Host gate'}],gates:[{id:'integration',status:'satisfied',reason:'Host gate',evidence:[{path:'host:integration',claim:'Host gate'}]}]}))})+'</readiness>');
} else if(prompt.includes('# CANDIDATE INVENTORY')) {
  const issues=JSON.parse(prompt.match(/<issues-json>([\\s\\S]*?)<\\/issues-json>/)[1]); record('plan:'+issues.map(i=>i.number).join(','));
  if(process.env.READINESS_FIXTURE_INVALID_PLAN==='1' && fs.readFileSync(process.env.READINESS_FIXTURE_TRACE,'utf8').split('plan:22').length===2) { console.log('<plan>'+JSON.stringify({issues:[],decisions:[]})+'</plan>'); console.log('<promise>COMPLETE</promise>'); process.exit(0); }
  if(process.env.READINESS_FIXTURE_STALE_PLAN==='1') { const state=JSON.parse(fs.readFileSync(process.env.READINESS_FIXTURE_STATE,'utf8'));state.find(i=>i.number===22).labels.push({name:'blocked'});fs.writeFileSync(process.env.READINESS_FIXTURE_STATE,JSON.stringify(state)); }
  console.log('<plan>'+JSON.stringify({issues:issues.map(i=>({id:String(i.number),title:i.title,branch:'sandcastle/issue-'+i.number})),decisions:issues.map(i=>({id:String(i.number),disposition:'selected',reason:'independent',likelyAreas:['task-'+i.number]}))})+'</plan>');
} else if(prompt.includes('Integrate the following completed branches')) {
  const branches=[...new Set(prompt.match(/sandcastle\\/issue-\\d+/g))];
  if(process.env.READINESS_FIXTURE_INDEPENDENT==='1') record('merger:'+branches.map(b=>b.split('-').at(-1)).join('+'));
  if(branches.some(b=>b.endsWith('-'+process.env.READINESS_FIXTURE_MERGE_BLOCKED_ISSUE))) {console.log('<promise>BLOCKED</promise>');process.exit(0);}
  for(const branch of branches) { const number=Number(branch.split('-').at(-1)); record('merge:'+number); git('merge',branch,'--no-edit'); execFileSync('gh',['issue','close',String(number)]); }
  if(process.env.READINESS_FIXTURE_MERGE_BLOCKED==='1') {console.log('<promise>BLOCKED</promise>');process.exit(0);}
} else if(prompt.includes('Review task ')) {
  const number=prompt.match(/Review task (\\d+)/)[1];execFileSync('gh',['issue','view',number]);record('review:'+number);
  if(process.env.READINESS_FIXTURE_REVIEW_BLOCKED==='1') {console.log('<promise>BLOCKED</promise>');process.exit(0);}
  const repaired=fs.readFileSync(process.env.READINESS_FIXTURE_TRACE,'utf8').includes('repair:'+number);
  const changes=(process.env.READINESS_FIXTURE_REVIEW_CHANGES==='1' && !repaired) || process.env.READINESS_FIXTURE_REVIEW_ALWAYS_CHANGES==='1';
  console.log('<review-verdict>'+JSON.stringify(changes?{verdict:'changes-requested',findings:[{id:'F1',severity:'major',file:'task-'+number+'.txt',change:'Add a repair note'}]}:{verdict:'approve',findings:[]})+'</review-verdict>');
}
else if(prompt.includes('Implement task ')) {
  const number=prompt.match(/Implement task (\\d+)/)[1];execFileSync('gh',['issue','view',number]);
  const providerFailed=fs.readFileSync(process.env.READINESS_FIXTURE_TRACE,'utf8').includes('provider-fail:'+number);
  if(process.env.READINESS_FIXTURE_PROVIDER_FAIL==='always' || (process.env.READINESS_FIXTURE_PROVIDER_FAIL==='once' && !providerFailed)) {record('provider-fail:'+number);console.error('HTTP 429 Too Many Requests: rate limit');process.exit(1);}
  if(prompt.includes('- [F1] (major)')) {record('repair:'+number);fs.appendFileSync('repair-'+number+'.txt','repaired\\n');git('add','.');git('commit','-m','Repair '+number);console.log('<promise>COMPLETE</promise>');process.exit(0);}
  record('implement:'+number);
  if(process.env.READINESS_FIXTURE_NO_PROGRESS!=='1' && !(number==='22' && process.env.READINESS_FIXTURE_RETAINED==='1')) {fs.writeFileSync('task-'+number+'.txt','implemented');git('add','.');git('commit','-m','Implement '+number);}
  if(process.env.READINESS_FIXTURE_BLOCKED==='1') {console.log('<promise>BLOCKED</promise>');process.exit(0);}
}
else throw Error('Unknown agent task');
console.log('<promise>COMPLETE</promise>');
`;

const verifier = `
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
import {verifyReadinessPolicy} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const {snapshot,assessment,trigger}=JSON.parse(fs.readFileSync(0,'utf8'));
if(trigger.kind==='post-merge' && process.env.READINESS_FIXTURE_FAIL_VERIFY==='1') throw Error('project gate failed');
const policy=JSON.parse(fs.readFileSync(process.env.READINESS_FIXTURE_POLICY,'utf8'));
console.log(JSON.stringify(await verifyReadinessPolicy({cwd:process.cwd(),input:{snapshot,assessment,trigger},policy,
  verifyGate:async id=>{if(id!=='integration') throw Error('Unknown gate');execFileSync(process.execPath,['-e','process.exit(0)']);return {head:snapshot.head,passed:true,reference:'host:integration'};},
})));
`;

async function execute(
  extraEnv: Record<string, string> = {},
  templateName = "parallel-planner-with-review",
) {
  const root = await mkdtemp(join(tmpdir(), "readiness-workflow-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(root, "node_modules"),
    "dir",
  );
  const bin = join(root, "bin");
  await mkdir(bin);
  const state = join(root, "github.json"),
    trace = join(root, "trace.txt");
  await writeFile(
    state,
    JSON.stringify(
      (extraEnv.READINESS_FIXTURE_QUALIFICATION_ONLY === "1"
        ? [22]
        : [20, 22]
      ).map((number) => ({
        number,
        title: `Task ${number}`,
        body:
          extraEnv.READINESS_FIXTURE_META === "1"
            ? "**Kind:** meta\nParent tracking task"
            : extraEnv.READINESS_FIXTURE_QUALIFICATION_ONLY === "1"
              ? "**Kind:** live-validation\nLive protocol still required"
              : extraEnv.READINESS_FIXTURE_INDEPENDENT !== "1" && number === 20
                ? "## Dependencies\n- #22"
                : "Implement slice",
        state: "open",
        state_reason: null,
        updated_at: "now",
        labels: [
          { name: "Sandcastle" },
          {
            name:
              extraEnv.READINESS_FIXTURE_INDEPENDENT !== "1" && number === 20
                ? "blocked"
                : "ready-for-agent",
          },
          ...(extraEnv.READINESS_FIXTURE_HOLD === "1"
            ? [{ name: "readiness:hold" }]
            : []),
        ],
      })),
    ),
  );
  await writeFile(trace, "");
  const { readinessContractHash } = await import("./index.js");
  const approvedRows = JSON.parse(await readFile(state, "utf8")) as {
    number: number;
    title: string;
    body: string;
  }[];
  const policyPath = join(root, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      repository: "owner/project",
      issues: Object.fromEntries(
        approvedRows.map((i) => [
          String(i.number),
          {
            contractHash: readinessContractHash({
              ...i,
              comments: [],
              dependencies:
                extraEnv.READINESS_FIXTURE_INDEPENDENT !== "1" &&
                i.number === 20
                  ? [
                      {
                        repository: "owner/project",
                        number: 22,
                        state: "open",
                        stateReason: null,
                      },
                    ]
                  : [],
            }),
            kind: i.body.includes("live-validation")
              ? "qualification"
              : "implementation",
            gates: ["integration"],
            dependencies:
              extraEnv.READINESS_FIXTURE_INDEPENDENT !== "1" && i.number === 20
                ? { "owner/project#22": "refs/heads/sandcastle/issue-22" }
                : {},
          },
        ]),
      ),
    }),
  );
  await writeFile(join(bin, "gh"), fakeGh);
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(join(root, "agent.mjs"), fakeAgent);
  if (extraEnv.READINESS_FIXTURE_CODEX === "1") {
    await writeFile(
      join(bin, "codex"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.READINESS_FIXTURE_MODELS, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
import(${JSON.stringify(pathToFileURL(join(root, "agent.mjs")).href)});
`,
    );
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(
      join(bin, "docker"),
      "#!/usr/bin/env sh\nprintf 'sha256:fixture-image\\n'\n",
    );
    await chmod(join(bin, "docker"), 0o755);
    await writeFile(join(bin, "codegraph"), "#!/usr/bin/env sh\nexit 0\n");
    await chmod(join(bin, "codegraph"), 0o755);
    await writeFile(join(root, "models.jsonl"), "");
  }
  await writeFile(join(root, "verify.mjs"), verifier);
  await Effect.runPromise(
    scaffold(cwd, {
      agent: getAgent(
        extraEnv.READINESS_FIXTURE_CODEX === "1" ? "codex" : "claude-code",
      )!,
      model: "fixture",
      templateName,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (extraEnv.READINESS_FIXTURE_CODEX === "1") {
    const { loadRoleConfig, saveRoleConfig } = await import("./index.js");
    const config = await loadRoleConfig({ cwd });
    for (const [role, value] of Object.entries(config.roles)) {
      value.model = "configured-" + role;
      value.effort =
        role === "implementer"
          ? "medium"
          : role === "merger"
            ? "xhigh"
            : value.effort;
    }
    await saveRoleConfig({ cwd, config });
  }
  const mainPath = join(cwd, ".sandcastle/main.mts");
  let main = await readFile(mainPath, "utf8");
  main = main
    .replace("const MAX_ITERATIONS = 10;", "const MAX_ITERATIONS = 3;")
    .replace(
      'const MERGE_MODE: "batch" | "per-branch" = "batch";',
      `const MERGE_MODE: "batch" | "per-branch" = ${JSON.stringify(extraEnv.READINESS_FIXTURE_MERGE_MODE ?? "batch")};`,
    )
    .replace(
      "const PROVIDER_FAILURE_THRESHOLD = 3;",
      `const PROVIDER_FAILURE_THRESHOLD = ${extraEnv.READINESS_FIXTURE_BREAKER ?? 3};`,
    )
    .replace(
      '"@ai-hero/sandcastle"',
      JSON.stringify(new URL("./index.ts", import.meta.url).href),
    )
    .replace(
      'import { docker } from "@ai-hero/sandcastle/sandboxes/docker";',
      `import { noSandbox as docker } from ${JSON.stringify(new URL("./sandboxes/no-sandbox.ts", import.meta.url).href)};`,
    )
    .replace(/sandcastle\.claudeCode\([^)]+\)/g, "scriptedAgent()")
    .replace(
      'const hooks = {\n  sandbox: { onSandboxReady: [{ command: "npm install" }] },\n};',
      "const hooks = {};",
    )
    .replace(
      'const hooks = {\n  sandbox: {\n    onSandboxReady: [\n      { command: "bash .sandcastle/scripts/ready.sh", timeoutMs: 180_000 },\n    ],\n  },\n};',
      "const hooks = {};",
    )
    .replace(
      'const copyToWorktree = ["node_modules"];',
      "const copyToWorktree: string[] = [];",
    );
  if (extraEnv.READINESS_FIXTURE_CODEX === "1") {
    main = main.replace(
      'import { docker, defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";',
      `import { noSandbox as docker } from ${JSON.stringify(new URL("./sandboxes/no-sandbox.ts", import.meta.url).href)};
const defaultImageName = () => "fixture-image";`,
    );
  }
  main =
    `const scriptedAgent = () => ({ name: "fixture", env: {}, captureSessions: false, buildPrintCommand: ({prompt}) => ({command: ${JSON.stringify(`${process.execPath} ${JSON.stringify(join(root, "agent.mjs"))}`)}, stdin: prompt}), parseStreamLine: text => [{type: "text", text}] });\n` +
    main;
  await writeFile(mainPath, main);
  const configPath = join(cwd, ".sandcastle/readiness.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      repository: "owner/project",
      mode: "apply",
      verifyCommand: [
        process.execPath,
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        join(root, "verify.mjs"),
      ],
    }),
  );
  if (
    extraEnv.READINESS_FIXTURE_CYCLES ||
    extraEnv.READINESS_FIXTURE_CODEX === "1"
  ) {
    const { loadWorkflowConfig, saveWorkflowConfig } =
      await import("./index.js");
    const config = await loadWorkflowConfig({ cwd });
    await saveWorkflowConfig({
      cwd,
      config: {
        ...config,
        limits: {
          ...config.limits,
          cycles: Number(extraEnv.READINESS_FIXTURE_CYCLES ?? 3),
          concurrency: 1,
          plannerAttempts: Number(
            extraEnv.READINESS_FIXTURE_PLANNER_ATTEMPTS ??
              config.limits.plannerAttempts,
          ),
        },
        ...(extraEnv.READINESS_FIXTURE_MERGE_MODE
          ? {
              merge: {
                mode: extraEnv.READINESS_FIXTURE_MERGE_MODE as
                  | "batch"
                  | "per-branch",
              },
            }
          : {}),
        ...(extraEnv.READINESS_FIXTURE_REPAIR_ROUNDS
          ? {
              review: {
                maxRepairRounds: Number(
                  extraEnv.READINESS_FIXTURE_REPAIR_ROUNDS,
                ),
              },
            }
          : {}),
      },
    });
  }
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-qb", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("add", ".");
  git("commit", "-qm", "fixture");
  if (extraEnv.READINESS_FIXTURE_RETAINED === "1") {
    git("switch", "-qc", "sandcastle/issue-22");
    await writeFile(join(cwd, "task-22.txt"), "retained implementation");
    git("add", ".");
    git("commit", "-qm", "retained implementation");
    git("switch", "main");
  }
  git(
    "remote",
    "add",
    "origin",
    "https://github.com/upstream/not-the-target.git",
  );
  let error: unknown;
  let stdout = "";
  try {
    stdout = execFileSync(
      process.execPath,
      ["--import", createRequire(import.meta.url).resolve("tsx"), mainPath],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GIT_CONFIG_GLOBAL: join(root, "fixture-gitconfig"),
          GH_TOKEN: "fake-host-token",
          READINESS_FIXTURE_STATE: state,
          READINESS_FIXTURE_POLICY: policyPath,
          READINESS_FIXTURE_TRACE: trace,
          READINESS_FIXTURE_MODELS: join(root, "models.jsonl"),
          ...extraEnv,
        },
      },
    );
  } catch (failure) {
    error = failure;
  }
  const runDir = join(cwd, ".sandcastle/runs");
  const files = await readdir(runDir).catch((failure) => {
    throw error ?? failure;
  });
  const snapshots = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        JSON.parse(await readFile(join(runDir, file), "utf8")),
      ),
  );
  return {
    error,
    stdout,
    modelArgs:
      extraEnv.READINESS_FIXTURE_CODEX === "1"
        ? (await readFile(join(root, "models.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    trace: (await readFile(trace, "utf8")).trim().split("\n"),
    issues: JSON.parse(await readFile(state, "utf8")),
    snapshots,
    diagnostics:
      extraEnv.READINESS_FIXTURE_CODEX === "1"
        ? await (
            await (
              await import("./index.js")
            ).openProjectRuntime({ cwd, id: snapshots[0].runtime.id })
          ).diagnostics()
        : [],
  };
}

it("runs the generated two-batch workflow through real orchestration and unlocks the next issue after merge", async () => {
  const result = await execute();
  expect(result.error).toBeUndefined();
  expect(result.trace).toEqual([
    "readiness:startup",
    "plan:22",
    "implement:22",
    "review:22",
    "merge:22",
    "readiness:post-merge",
    "plan:20",
    "implement:20",
    "review:20",
    "merge:20",
    "plan:",
  ]);
  expect(
    result.issues.every((issue: { state: string }) => issue.state === "closed"),
  ).toBe(true);
  expect(result.snapshots).toEqual([
    expect.objectContaining({
      status: "completed",
      nodes: expect.arrayContaining([
        expect.objectContaining({ role: "readiness", status: "completed" }),
      ]),
    }),
  ]);
}, 90_000);

it("repairs changes-requested findings through the implementer and merges only after approval", async () => {
  const result = await execute({ READINESS_FIXTURE_REVIEW_CHANGES: "1" });
  expect(result.error).toBeUndefined();
  const forTask = result.trace.filter(
    (value: string) => value.endsWith(":22") && !value.startsWith("plan:"),
  );
  expect(forTask).toEqual([
    "implement:22",
    "review:22",
    "repair:22",
    "review:22",
    "merge:22",
  ]);
}, 90_000);

it("retains the branch without merging when review findings exhaust the repair budget", async () => {
  const result = await execute({
    READINESS_FIXTURE_REVIEW_ALWAYS_CHANGES: "1",
  });
  expect(result.error).toBeDefined();
  const forTask = result.trace.filter(
    (value: string) => value.endsWith(":22") && !value.startsWith("plan:"),
  );
  expect(forTask.filter((value: string) => value === "repair:22")).toHaveLength(
    2,
  );
  expect(forTask.filter((value: string) => value === "review:22")).toHaveLength(
    3,
  );
  expect(result.trace).not.toContain("merge:22");
}, 90_000);

it("the configured Codex runtime applies the saved review repair budget", async () => {
  const result = await execute({
    READINESS_FIXTURE_CODEX: "1",
    READINESS_FIXTURE_REPAIR_ROUNDS: "1",
    READINESS_FIXTURE_REVIEW_ALWAYS_CHANGES: "1",
  });
  expect(result.error).toBeDefined();
  const forTask = result.trace.filter(
    (value: string) => value.endsWith(":22") && !value.startsWith("plan:"),
  );
  expect(forTask).toEqual([
    "implement:22",
    "review:22",
    "repair:22",
    "review:22",
  ]);
}, 90_000);

it("retries a provider-failed pipeline on the retained branch and then merges", async () => {
  const result = await execute({ READINESS_FIXTURE_PROVIDER_FAIL: "once" });
  expect(result.error).toBeUndefined();
  const forTask = result.trace.filter(
    (value: string) => value.endsWith(":22") && !value.startsWith("plan:"),
  );
  expect(forTask).toEqual([
    "provider-fail:22",
    "implement:22",
    "review:22",
    "merge:22",
  ]);
}, 90_000);

it("opens the circuit breaker after consecutive provider failures and stops without merging", async () => {
  const result = await execute({
    READINESS_FIXTURE_PROVIDER_FAIL: "always",
    READINESS_FIXTURE_BREAKER: "2",
  });
  expect(String(result.error)).toMatch(
    /Provider unavailable after 2 consecutive provider failures/,
  );
  expect(
    result.trace.filter((value: string) => value === "provider-fail:22"),
  ).toHaveLength(2);
  expect(result.trace).not.toContain("review:22");
  expect(result.trace).not.toContain("merge:22");
  expect(result.trace).not.toContain("plan:20");
}, 90_000);

it("batch mode integrates independent approved branches with one merger after the batch", async () => {
  const result = await execute({
    READINESS_FIXTURE_INDEPENDENT: "1",
    READINESS_FIXTURE_CODEX: "1",
  });
  expect(result.error).toBeUndefined();
  const mergers = result.trace.filter((value: string) =>
    value.startsWith("merger:"),
  );
  expect(mergers).toHaveLength(1);
  expect(mergers[0]!.split(":")[1]!.split("+").sort()).toEqual(["20", "22"]);
}, 90_000);

it("per-branch mode integrates each approved branch as soon as it is approved", async () => {
  const result = await execute({
    READINESS_FIXTURE_INDEPENDENT: "1",
    READINESS_FIXTURE_CODEX: "1",
    READINESS_FIXTURE_MERGE_MODE: "per-branch",
  });
  expect(result.error).toBeUndefined();
  const mergers = result.trace.filter((value: string) =>
    value.startsWith("merger:"),
  );
  expect(mergers.sort()).toEqual(["merger:20", "merger:22"]);
  // Streaming: the first approved branch merges while the other pipeline runs.
  expect(result.trace.indexOf("merger:20")).toBeLessThan(
    result.trace.indexOf("review:22"),
  );
  // Post-merge readiness is incremental: the issues are independent and the
  // merges touch no file either mentions, so no post-merge assessment is
  // needed (a dependent issue is covered by the readiness tests).
  expect(
    result.trace.filter((value: string) => value === "readiness:post-merge"),
  ).toHaveLength(0);
  expect(
    result.issues.every((issue: { state: string }) => issue.state === "closed"),
  ).toBe(true);
}, 90_000);

it("per-branch mode retains a branch whose merge is blocked without stopping the other merge", async () => {
  const result = await execute({
    READINESS_FIXTURE_INDEPENDENT: "1",
    READINESS_FIXTURE_CODEX: "1",
    READINESS_FIXTURE_MERGE_MODE: "per-branch",
    READINESS_FIXTURE_MERGE_BLOCKED_ISSUE: "20",
  });
  expect(result.trace).toContain("merge:22");
  expect(result.trace).not.toContain("merge:20");
  expect(
    result.issues.find((issue: { number: number }) => issue.number === 22)
      .state,
  ).toBe("closed");
  expect(
    result.issues.find((issue: { number: number }) => issue.number === 20)
      .state,
  ).toBe("open");
}, 90_000);

it("stops before the next planner when post-merge project verification fails", async () => {
  const result = await execute({ READINESS_FIXTURE_FAIL_VERIFY: "1" });
  expect(result.error).toBeDefined();
  expect(result.trace).toContain("merge:22");
  expect(result.trace).not.toContain("plan:20");
  expect(
    result.issues.find((issue: { number: number }) => issue.number === 20)
      .labels,
  ).toContainEqual({ name: "blocked" });
  expect(result.snapshots).toEqual([
    expect.objectContaining({
      status: "failed",
      nodes: expect.arrayContaining([
        expect.objectContaining({ role: "readiness", status: "failed" }),
      ]),
    }),
  ]);
}, 90_000);

it("rejects an assessor's uncommitted edits before starting the planner", async () => {
  const result = await execute({ READINESS_FIXTURE_DIRTY: "1" });
  expect(result.error).toBeDefined();
  expect(result.trace).toEqual(["readiness:startup"]);
  expect(result.snapshots).toEqual([
    expect.objectContaining({ status: "failed" }),
  ]);
}, 90_000);

it("refreshes tracker eligibility before creating any selected worktree", async () => {
  const result = await execute({ READINESS_FIXTURE_STALE_PLAN: "1" });
  expect(result.error).toBeDefined();
  expect(result.trace).not.toContain("implement:22");
  expect(
    result.issues.find((issue: { number: number }) => issue.number === 22)
      .state,
  ).toBe("open");
}, 90_000);

it("does not review or merge a blocked implementation that produced commits", async () => {
  const result = await execute({ READINESS_FIXTURE_BLOCKED: "1" });
  expect(result.error).toBeDefined();
  // A blocked implementation is a task failure and is never retried.
  expect(
    result.trace.filter((value: string) => value === "implement:22"),
  ).toHaveLength(1);
  expect(result.trace).not.toContain("review:22");
  expect(result.trace).not.toContain("merge:22");
  expect(
    result.issues.every((issue: { state: string }) => issue.state === "open"),
  ).toBe(true);
}, 90_000);

it("stops a no-progress batch after one implementation attempt", async () => {
  const result = await execute({ READINESS_FIXTURE_NO_PROGRESS: "1" });
  expect(result.error).toBeDefined();
  expect(result.trace.filter((value) => value === "implement:22")).toHaveLength(
    1,
  );
  expect(result.trace).not.toContain("merge:22");
}, 90_000);

it("reviews retained branch commits before integration when the resumed implementer adds none", async () => {
  const result = await execute({ READINESS_FIXTURE_RETAINED: "1" });
  expect(result.error).toBeUndefined();
  expect(result.trace).toContain("review:22");
  expect(result.trace.indexOf("review:22")).toBeLessThan(
    result.trace.indexOf("merge:22"),
  );
  expect(
    result.issues.every((issue: { state: string }) => issue.state === "closed"),
  ).toBe(true);
}, 90_000);

it("reports pending external qualification without implementing or closing its issue", async () => {
  const result = await execute({ READINESS_FIXTURE_QUALIFICATION_ONLY: "1" });
  expect(result.error).toBeUndefined();
  expect(result.stdout).toContain(
    "external qualification remains pending for: 22",
  );
  expect(result.trace).toEqual(["readiness:startup", "plan:"]);
  expect(result.issues[0].state).toBe("open");
  expect(result.snapshots[0].status).toBe("completed");
}, 90_000);

it.each(["parallel-planner-with-review", "codex-afk"])(
  "generated %s Codex workflow consumes saved models and effort for all roles through real provider commands and records",
  async (templateName) => {
    const result = await execute(
      { READINESS_FIXTURE_CODEX: "1" },
      templateName,
    );
    expect(result.error).toBeUndefined();
    for (const [role, effort] of [
      ["planner", "low"],
      ["implementer", "medium"],
      ["reviewer", "high"],
      ["merger", "xhigh"],
      ["readiness", "high"],
    ]) {
      const args = result.modelArgs.find((args) =>
        args.includes("configured-" + role),
      );
      expect(args).toBeDefined();
      expect(args).toContain('model_reasoning_effort="' + effort + '"');
      const nodes = result.snapshots.flatMap((snapshot) => snapshot.nodes);
      expect(
        nodes.find((node) => node.role === role && node.status === "completed"),
      ).toMatchObject({
        model: "configured-" + role,
        effort,
        provider: "codex",
      });
    }
    expect(result.snapshots[0].runtime.configRevision).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.snapshots[0].runtime.version).toMatch(/^0\./);
  },
  60_000,
);

it.each([
  {
    scenario: "fresh admission",
    flag: "READINESS_FIXTURE_STALE_PLAN",
    forbidden: ["implement:22"],
  },
  {
    scenario: "blocked completion",
    flag: "READINESS_FIXTURE_BLOCKED",
    forbidden: ["review:22", "merge:22"],
  },
  {
    scenario: "blocked review",
    flag: "READINESS_FIXTURE_REVIEW_BLOCKED",
    forbidden: ["merge:22", "readiness:post-merge"],
  },
  {
    scenario: "merger completion",
    flag: "READINESS_FIXTURE_MERGE_BLOCKED",
    forbidden: ["readiness:post-merge", "plan:20", "implement:20"],
  },
  {
    scenario: "readiness checkout integrity",
    flag: "READINESS_FIXTURE_DIRTY",
    forbidden: ["plan:22"],
  },
  {
    scenario: "post-merge verification",
    flag: "READINESS_FIXTURE_FAIL_VERIFY",
    forbidden: ["plan:20", "implement:20"],
  },
])(
  "shared Codex runtime preserves $scenario guards",
  async ({ flag, forbidden }) => {
    const result = await execute({ READINESS_FIXTURE_CODEX: "1", [flag]: "1" });
    expect(result.error).toBeDefined();
    for (const event of forbidden) expect(result.trace).not.toContain(event);
    expect(result.snapshots[0].status).toBe("failed");
  },
  90_000,
);

it.each(["parallel-planner-with-review", "codex-afk"])(
  "generated %s stops at the saved cycle limit without starting a later task",
  async (template) => {
    const result = await execute(
      { READINESS_FIXTURE_CODEX: "1", READINESS_FIXTURE_CYCLES: "1" },
      template,
    );
    expect(result.error).toBeDefined();
    expect(result.trace).toContain("merge:22");
    expect(result.trace).not.toContain("plan:20");
    expect(result.diagnostics).toEqual([
      { code: "iteration-limit", issues: [] },
    ]);
    expect(
      result.issues.find((issue: { number: number }) => issue.number === 20)
        .state,
    ).toBe("open");
    expect(result.snapshots[0].status).toBe("failed");
  },
  90000,
);

it.each([
  { flag: "READINESS_FIXTURE_NO_PROGRESS", code: "no-progress", failed: true },
  {
    flag: "READINESS_FIXTURE_QUALIFICATION_ONLY",
    code: "qualification-pending",
    failed: false,
  },
])(
  "configured Codex workflow records $code without closing unfinished issues",
  async ({ flag, code, failed }) => {
    const result = await execute({ READINESS_FIXTURE_CODEX: "1", [flag]: "1" });
    expect(Boolean(result.error)).toBe(failed);
    expect(result.diagnostics).toEqual([{ code, issues: [22] }]);
    expect(result.trace).not.toContain("merge:22");
    expect(
      result.issues.every((issue: { state: string }) => issue.state === "open"),
    ).toBe(true);
  },
  90000,
);
it.each(["READINESS_FIXTURE_HOLD", "READINESS_FIXTURE_META"])(
  "configured Codex workflow cannot implement held or meta tasks: %s",
  async (flag) => {
    const result = await execute({ READINESS_FIXTURE_CODEX: "1", [flag]: "1" });
    expect(result.trace).not.toContain("implement:22");
    expect(result.trace).not.toContain("implement:20");
    expect(
      result.issues.every((issue: { state: string }) => issue.state === "open"),
    ).toBe(true);
  },
  90000,
);

it.each([1, 2])(
  "configured Codex workflow enforces %s planner attempts before implementation",
  async (attempts) => {
    const result = await execute({
      READINESS_FIXTURE_CODEX: "1",
      READINESS_FIXTURE_INVALID_PLAN: "1",
      READINESS_FIXTURE_PLANNER_ATTEMPTS: String(attempts),
    });
    expect(result.trace.filter((event) => event === "plan:22")).toHaveLength(
      attempts,
    );
    if (attempts === 1) {
      expect(result.error).toBeDefined();
      expect(result.trace).not.toContain("implement:22");
      expect(
        result.issues.every(
          (issue: { state: string }) => issue.state === "open",
        ),
      ).toBe(true);
    } else {
      expect(result.error).toBeUndefined();
      expect(result.trace).toContain("implement:22");
      expect(
        result.issues.every(
          (issue: { state: string }) => issue.state === "closed",
        ),
      ).toBe(true);
    }
  },
  90000,
);
