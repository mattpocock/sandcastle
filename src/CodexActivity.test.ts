import { exec } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { codex } from "./AgentProvider.js";

const execute = promisify(exec);
const itPosix = process.platform === "win32" ? it.skip : it;

itPosix(
  "Codex activity honors CODEX_HOME or an explicit sandbox store without disclosing content",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex activity 'store-"));
    try {
      const home = join(directory, "codex-home");
      const sessions = join(home, "sessions", "2026", "10", "12");
      await mkdir(sessions, { recursive: true });
      const id = "session-$(not-a-shell-command)";
      const content = "private reasoning must not be returned";
      await writeFile(join(sessions, `rollout-fixture-${id}.jsonl`), content);
      const command = codex("fixture").buildActivityCommand!(id);
      expect(
        (await execute(command, { env: { ...process.env, CODEX_HOME: home } }))
          .stdout,
      ).toBe(String(Buffer.byteLength(content)));
      const explicit = codex("fixture", {
        sessionStorage: { sandboxSessionsDir: join(home, "sessions") },
      }).buildActivityCommand!(id);
      expect(
        (
          await execute(explicit, {
            env: { ...process.env, CODEX_HOME: join(directory, "wrong") },
          })
        ).stdout,
      ).toBe(String(Buffer.byteLength(content)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

itPosix(
  "Codex activity rejects ambiguous or symlinked rollout files",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "codex-activity-ambiguous-"),
    );
    try {
      const provider = codex("fixture", {
        sessionStorage: { sandboxSessionsDir: directory },
      });
      const command = provider.buildActivityCommand!("fixture-id");
      const first = join(directory, "rollout-first-fixture-id.jsonl");
      await writeFile(first, "private");
      await writeFile(
        join(directory, "rollout-second-fixture-id.jsonl"),
        "ambiguous",
      );
      expect((await execute(command)).stdout).toBe("");
      await symlink(first, join(directory, "rollout-link-other-id.jsonl"));
      expect(
        (await execute(provider.buildActivityCommand!("other-id"))).stdout,
      ).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
