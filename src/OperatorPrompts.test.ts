import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { loadProjectPrompts, saveProjectPrompt } from "./OperatorPrompts.js";

test("defaults advance while overrides retain their base and reset follows current defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    const path = join(cwd, "default.md");
    await writeFile(path, "Task {{TASK}} <promise>COMPLETE</promise>");
    const promptFiles = {
      planner: path,
      implementer: path,
      reviewer: path,
      merger: path,
      readiness: path,
    };
    const options = { cwd, promptFiles };
    const initial = await loadProjectPrompts(options);
    await saveProjectPrompt({
      ...options,
      role: "implementer",
      content: initial.implementer!.content + "\nCustom",
    });
    await writeFile(path, "New task {{TASK}} <promise>COMPLETE</promise>");
    const next = await loadProjectPrompts(options);
    expect(next.planner!.content).toContain("New task");
    expect(next.implementer!.content).toContain("Custom");
    expect(next.implementer!.base).toEqual(initial.implementer!.default);
    expect(next.implementer!.defaultChanged).toBe(true);
    await saveProjectPrompt({ ...options, role: "implementer", content: null });
    expect((await loadProjectPrompts(options)).implementer!.content).toContain(
      "New task",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent first saves retain each role's project override", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    await writeFile(
      join(cwd, "default.md"),
      "Default <promise>COMPLETE</promise>",
    );
    const promptFiles = {
      planner: "default.md",
      implementer: "default.md",
      reviewer: "default.md",
      merger: "default.md",
      readiness: "default.md",
    };
    const options = { cwd, promptFiles };
    const saves = await Promise.allSettled(
      Object.keys(promptFiles).map((role) =>
        saveProjectPrompt({
          ...options,
          role,
          content: role + " custom <promise>COMPLETE</promise>",
        }),
      ),
    );
    expect(saves.map((save) => save.status)).toEqual(
      Array(5).fill("fulfilled"),
    );
    const selected = await loadProjectPrompts(options);
    expect(Object.values(selected).map((prompt) => prompt?.content)).toEqual([
      "planner custom <promise>COMPLETE</promise>",
      "implementer custom <promise>COMPLETE</promise>",
      "reviewer custom <promise>COMPLETE</promise>",
      "merger custom <promise>COMPLETE</promise>",
      "readiness custom <promise>COMPLETE</promise>",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid templates preserve prior prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    const path = join(cwd, "default.md");
    await writeFile(path, "Task {{TASK}} <promise>COMPLETE</promise> <review>");
    const options = {
      cwd,
      promptFiles: {
        planner: path,
        implementer: path,
        reviewer: path,
        merger: path,
        readiness: path,
      },
    };
    await saveProjectPrompt({
      ...options,
      role: "reviewer",
      content: "Saved review {{TASK}} <promise>COMPLETE</promise> <review>",
    });
    const original = (await loadProjectPrompts(options)).reviewer!;
    for (const content of [
      "Task {{UNKNOWN}} <promise>COMPLETE</promise> <review>",
      "Task <promise>COMPLETE</promise> <review>",
      "Task {{TASK}} <review>",
      "Task {{TASK}} <promise>COMPLETE</promise>",
      "Task {{TASK}} <promise>COMPLETE</promise> <review> !`touch /tmp/unsafe`",
      "Task {{TASK} <promise>COMPLETE</promise> <review>",
    ]) {
      await expect(
        saveProjectPrompt({ ...options, role: "reviewer", content }),
      ).rejects.toThrow(/reviewer:/);
      expect((await loadProjectPrompts(options)).reviewer).toEqual(original);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("selected overrides freeze at run start", async () => {
  const { createProjectRuntime, openProjectRuntime } =
    await import("./OperatorRuntime.js");
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    const path = join(cwd, "default.md");
    await writeFile(path, "Default <promise>COMPLETE</promise>");
    const options = {
      cwd,
      promptFiles: {
        planner: path,
        implementer: path,
        reviewer: path,
        merger: path,
        readiness: path,
      },
    };
    await saveProjectPrompt({
      ...options,
      role: "implementer",
      content: "Selected <promise>COMPLETE</promise>",
    });
    const active = await createProjectRuntime({
      ...options,
      sandboxIdentity: "fake-image",
    });
    await saveProjectPrompt({
      ...options,
      role: "implementer",
      content: "Next <promise>COMPLETE</promise>",
    });
    expect(await readFile(active.promptFile("implementer"), "utf8")).toBe(
      "Selected <promise>COMPLETE</promise>",
    );
    expect(
      (await openProjectRuntime({ cwd, id: active.record.id })).record.prompts
        .implementer,
    ).toEqual(active.record.prompts.implementer);
    const next = await createProjectRuntime({
      ...options,
      sandboxIdentity: "fake-image",
    });
    expect(next.record.prompts.implementer!.content).toBe(
      "Next <promise>COMPLETE</promise>",
    );
    expect(next.record.prompts.implementer!.digest).not.toBe(
      active.record.prompts.implementer!.digest,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prompt writes reject paths and symlink escapes", async () => {
  const { startOperator } = await import("./OperatorServer.js");
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  const outside = await mkdtemp(join(tmpdir(), "auth-"));
  try {
    await writeFile(join(cwd, "default.md"), "Default");
    await writeFile(join(outside, "auth.json"), "secret");
    const options = {
      cwd,
      promptFiles: {
        planner: "default.md",
        implementer: "default.md",
        reviewer: "default.md",
        merger: "default.md",
        readiness: "default.md",
      },
    };
    const server = await startOperator({
      ...options,
      port: 0,
      adapter: {
        promptFiles: options.promptFiles,
        sandboxIdentity: async () => "fake",
        run: async () => {},
      },
    });
    try {
      const cookie = (await fetch(server.url)).headers
        .get("set-cookie")!
        .split(";")[0]!;
      const headers = {
        cookie,
        origin: server.url,
        "content-type": "application/json",
      };
      for (const body of [
        { role: "../auth", content: "replace" },
        {
          role: "implementer",
          content: "replace",
          path: join(outside, "auth.json"),
        },
        { role: "implementer", content: "replace", auth: "replace" },
      ]) {
        const response = await fetch(server.url + "/api/prompts", {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      for (const deniedHeaders of [
        { ...headers, origin: "https://evil.example" },
        { ...headers, cookie: "forged" },
        { origin: server.url, "content-type": "application/json" },
        { cookie, "content-type": "application/json" },
      ]) {
        const denied = await fetch(server.url + "/api/prompts", {
          method: "PUT",
          headers: deniedHeaders,
          body: JSON.stringify({ role: "implementer", content: "replace" }),
        });
        expect(denied.status).toBe(403);
      }
    } finally {
      await server.close();
    }
    await mkdir(join(cwd, ".sandcastle"), { recursive: true });
    await symlink(outside, join(cwd, ".sandcastle/prompts"), "dir");
    await expect(
      saveProjectPrompt({
        ...options,
        role: "implementer",
        content: "replace",
      }),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(outside, "auth.json"), "utf8")).toBe("secret");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("managed prompt records cannot follow authentication symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  const outside = await mkdtemp(join(tmpdir(), "auth-"));
  try {
    await writeFile(join(cwd, "default.md"), "Default");
    const auth = join(outside, "auth.json");
    await writeFile(auth, "private authentication bytes");
    const options = {
      cwd,
      promptFiles: {
        planner: "default.md",
        implementer: "default.md",
        reviewer: "default.md",
        merger: "default.md",
        readiness: "default.md",
      },
    };
    await mkdir(join(cwd, ".sandcastle/prompts"), { recursive: true });
    for (const record of ["implementer.json", "defaults.json"]) {
      const path = join(cwd, ".sandcastle/prompts", record);
      await symlink(auth, path);
      for (const content of ["Edited", null]) {
        await expect(
          saveProjectPrompt({ ...options, role: "implementer", content }),
        ).rejects.toThrow(/symbolic link/);
        expect(await readFile(auth, "utf8")).toBe(
          "private authentication bytes",
        );
      }
      await rm(path);
    }
    await rm(join(cwd, ".sandcastle"), { recursive: true });
    await symlink(outside, join(cwd, ".sandcastle"), "dir");
    await expect(
      saveProjectPrompt({ ...options, role: "implementer", content: "Edited" }),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(auth, "utf8")).toBe("private authentication bytes");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("packaged default adoption preserves existing customized project files", async () => {
  const { usePackagedPromptDefaults } = await import("./OperatorPrompts.js");
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    await writeFile(join(cwd, "default.md"), "Project-owned instructions");
    const options = {
      cwd,
      promptFiles: {
        planner: "default.md",
        implementer: "default.md",
        reviewer: "default.md",
        merger: "default.md",
        readiness: "default.md",
      },
    };
    await usePackagedPromptDefaults({
      cwd,
      templateArgs: {
        VIEW_TASK_COMMAND: "gh issue view <ID>",
        CLOSE_TASK_COMMAND: "gh issue close <ID>",
      },
    });
    const selected = (await loadProjectPrompts(options)).implementer!;
    expect(selected.status).toBe("override");
    expect(selected.content).toBe("Project-owned instructions");
    expect(selected.default.content).toContain("Implement task {{TASK_ID}}");
    expect(selected.default.content).toContain("gh issue view <ID>");
    await saveProjectPrompt({ ...options, role: "implementer", content: null });
    const reset = (await loadProjectPrompts(options)).implementer!;
    expect(reset.status).toBe("default");
    expect(reset.content).toBe(selected.default.content);
    expect(await readFile(join(cwd, "default.md"), "utf8")).toBe(
      "Project-owned instructions",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("template validation follows runtime placeholder syntax and rejects control-marker shell injection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    await writeFile(
      join(cwd, "default.md"),
      "Task {{ taskId }} {{SOURCE_BRANCH}} <result>",
    );
    const options = {
      cwd,
      promptFiles: {
        planner: "default.md",
        implementer: "default.md",
        reviewer: "default.md",
        merger: "default.md",
        readiness: "default.md",
      },
    };
    await saveProjectPrompt({
      ...options,
      role: "planner",
      content: "Edited {{taskId}} {{ SOURCE_BRANCH }} <result>",
    });
    const saved = (await loadProjectPrompts(options)).planner!;
    for (const content of [
      "Edited {{taskId}} {{SOURCE_BRANCH}}",
      "Edited {{taskId}} {{SOURCE_BRANCH}} <result> !\x01`touch /tmp/unsafe`",
    ]) {
      await expect(
        saveProjectPrompt({ ...options, role: "planner", content }),
      ).rejects.toThrow(/planner:/);
      expect((await loadProjectPrompts(options)).planner).toEqual(saved);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
