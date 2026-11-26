import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workflowSandbox } from "./sandbox";

// WORKFLOW_SANDBOX picks the workflows' provider, and an unset one means
// host(). So a job that forgot it would quietly run the agent where it can
// read the job's token: every step that runs a script opening a sandbox
// must set it to bwrap, after a step that installs Bubblewrap.

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const SCRIPTS = path.join(ROOT, ".sandcastle/agent-workflows");

/** The agent workflow scripts that open a sandbox, relative to the repo root. */
const scriptsOpeningASandbox = async (): Promise<string[]> => {
  const files = await readdir(SCRIPTS, { recursive: true });
  const scripts = files.filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.startsWith("shared"),
  );
  const opening = await Promise.all(
    scripts.map(async (file) => {
      const source = await readFile(path.join(SCRIPTS, file), "utf8");
      return source.includes("openSandbox()");
    }),
  );
  return scripts
    .filter((_, index) => opening[index] === true)
    .map((file) => `.sandcastle/agent-workflows/${file.replaceAll("\\", "/")}`);
};

/** Each workflow's steps, as the text of each `- name:` block. */
const workflowSteps = async (): Promise<
  { readonly file: string; readonly steps: readonly string[] }[]
> => {
  const entries = await readdir(WORKFLOWS);
  const files = entries.filter((file) => file.endsWith(".yml"));
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(WORKFLOWS, file), "utf8");
      return { file, steps: text.split(/^ {6}- /mu) };
    }),
  );
};

describe("WORKFLOW_SANDBOX", () => {
  it("names bwrap or host, and means host when unset", () => {
    expect(workflowSandbox("bwrap")).toBe("bwrap");
    expect(workflowSandbox("host")).toBe("host");
    expect(workflowSandbox(undefined)).toBe("host");
    expect(workflowSandbox("")).toBe("host");
    expect(() => workflowSandbox("docker")).toThrow(/"docker"/u);
  });

  it("is bwrap in every workflow step that runs a script opening a sandbox, after Bubblewrap is installed", async () => {
    const scripts = await scriptsOpeningASandbox();
    const workflows = await workflowSteps();
    const runs = workflows.flatMap(({ file, steps }) =>
      steps.flatMap((step, index) =>
        scripts
          .filter((script) => step.includes(`npx tsx ${script}`))
          .map((script) => ({
            file,
            script,
            bwrap: step.includes("WORKFLOW_SANDBOX: bwrap"),
            installed: steps
              .slice(0, index)
              .some((before) =>
                before.includes("sudo apt-get install -y bubblewrap"),
              ),
          })),
      ),
    );

    expect(scripts).toHaveLength(5);
    expect(runs).toHaveLength(scripts.length);
    expect(new Set(runs.map((found) => found.script))).toStrictEqual(
      new Set(scripts),
    );
    for (const found of runs) {
      expect(found, `${found.file} runs ${found.script}`).toMatchObject({
        bwrap: true,
        installed: true,
      });
    }
  });
});
