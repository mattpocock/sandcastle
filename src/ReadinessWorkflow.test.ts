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
import { fileURLToPath } from "node:url";
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
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const record=(value)=>fs.appendFileSync(process.env.READINESS_FIXTURE_TRACE,value+'\\n');
if(prompt.includes('MISSION — READINESS ASSESSMENT')) {
  if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN) throw Error('Tracker credential leaked');
  const {snapshot,trigger}=JSON.parse(prompt.match(/<readiness-input>([\\s\\S]*?)<\\/readiness-input>/)[1]);
  record('readiness:'+trigger.kind);
  if(process.env.READINESS_FIXTURE_DIRTY==='1') fs.writeFileSync('unauthorized.txt','dirty');
  console.log('<readiness>'+JSON.stringify({head:snapshot.head,decisions:snapshot.issues.map(i=>({number:i.number,status:i.dependencies.some(d=>d.state!=='closed')?'blocked':'ready-for-agent',reason:'fixture contract'}))})+'</readiness>');
} else if(prompt.includes('# CANDIDATE INVENTORY')) {
  const issues=JSON.parse(prompt.match(/<issues-json>([\\s\\S]*?)<\\/issues-json>/)[1]); record('plan:'+issues.map(i=>i.number).join(','));
  console.log('<plan>'+JSON.stringify({issues:issues.map(i=>({id:String(i.number),title:i.title,branch:'sandcastle/issue-'+i.number})),decisions:issues.map(i=>({id:String(i.number),disposition:'selected',reason:'independent',likelyAreas:['task-'+i.number]}))})+'</plan>');
} else if(prompt.includes('Integrate the following completed branches')) {
  const branches=[...new Set(prompt.match(/sandcastle\\/issue-\\d+/g))];
  for(const branch of branches) { const number=Number(branch.split('-').at(-1)); record('merge:'+number); git('merge',branch,'--no-edit'); execFileSync('gh',['issue','close',String(number)]); }
} else if(prompt.includes('Review task ')) { const number=prompt.match(/Review task (\\d+)/)[1];execFileSync('gh',['issue','view',number]);record('review:'+number); }
else if(prompt.includes('Complete task ')) { const number=prompt.match(/Complete task (\\d+)/)[1];execFileSync('gh',['issue','view',number]);record('implement:'+number);fs.writeFileSync('task-'+number+'.txt','implemented');git('add','.');git('commit','-m','Implement '+number); }
else throw Error('Unknown agent task');
console.log('<promise>COMPLETE</promise>');
`;

const verifier = `
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const {snapshot,assessment,trigger}=JSON.parse(fs.readFileSync(0,'utf8'));
if(trigger.kind==='post-merge' && process.env.READINESS_FIXTURE_FAIL_VERIFY==='1') throw Error('project gate failed');
const dependencyCommits={};
for(const i of snapshot.issues) for(const d of i.dependencies) if(d.state==='closed') dependencyCommits[d.repository+'#'+d.number]=execFileSync('git',['log','-1','--format=%H','--','task-'+d.number+'.txt'],{encoding:'utf8'}).trim();
console.log(JSON.stringify({head:snapshot.head,approved:assessment.decisions.map(({number,status})=>({number,status})),dependencyCommits}));
`;

async function execute(extraEnv: Record<string, string> = {}) {
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
      [20, 22].map((number) => ({
        number,
        title: `Task ${number}`,
        body: number === 20 ? "## Dependencies\n- #22" : "Implement slice",
        state: "open",
        state_reason: null,
        updated_at: "now",
        labels: [
          { name: "Sandcastle" },
          { name: number === 20 ? "blocked" : "ready-for-agent" },
        ],
      })),
    ),
  );
  await writeFile(trace, "");
  await writeFile(join(bin, "gh"), fakeGh);
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(join(root, "agent.mjs"), fakeAgent);
  await writeFile(join(root, "verify.mjs"), verifier);
  await Effect.runPromise(
    scaffold(cwd, {
      agent: getAgent("claude-code")!,
      model: "fixture",
      templateName: "parallel-planner-with-review",
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  const mainPath = join(cwd, ".sandcastle/main.mts");
  let main = await readFile(mainPath, "utf8");
  main = main
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
      'const copyToWorktree = ["node_modules"];',
      "const copyToWorktree: string[] = [];",
    );
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
      verifyCommand: [process.execPath, join(root, "verify.mjs")],
    }),
  );
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
  git(
    "remote",
    "add",
    "origin",
    "https://github.com/upstream/not-the-target.git",
  );
  let error: unknown;
  try {
    execFileSync(
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
          GH_TOKEN: "fake-host-token",
          READINESS_FIXTURE_STATE: state,
          READINESS_FIXTURE_TRACE: trace,
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
    trace: (await readFile(trace, "utf8")).trim().split("\n"),
    issues: JSON.parse(await readFile(state, "utf8")),
    snapshots,
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
