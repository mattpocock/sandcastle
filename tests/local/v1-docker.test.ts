import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import {
  createSandbox,
  reattachSandbox,
  SandboxUnavailableError,
} from "@ai-hero/sandcastle/v1";
import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { command } from "./helpers/command.js";
import { imagesFor } from "./helpers/sandboxes.js";

// The v1 docker() provider against the real Docker engine: what only a real
// container can show. tests/v1-docker.test.ts covers the rest with a fake CLI.

/** Has Node.js and `sh`, which the session supervisor needs. */
const IMAGE = "node:22-alpine";

/** The ids of the containers labelled with this run's label. */
const labelled = async (label: string): Promise<string[]> => {
  const out = await command("docker", [
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=${label}`,
  ]);
  return out.split("\n").filter((line) => line !== "");
};

describe.skipIf(imagesFor("docker") === undefined)(
  "docker() (v1) on a real engine",
  () => {
    const run = `${String(process.pid)}-${String(Date.now())}`;
    const label = `sandcastle-local-test=${run}`;
    const provider = docker({
      image: IMAGE,
      create: { labels: { "sandcastle-local-test": run } },
    });
    const made: DetachableSandbox[] = [];
    const open = async (timeLimitMinutes = 10): Promise<DetachableSandbox> => {
      const sandbox = await createSandbox({
        provider,
        env: { SANDBOX_TOKEN: "tok-real" },
        timeLimitMinutes,
      });
      made.push(sandbox);
      return sandbox;
    };

    beforeAll(async () => {
      await command("docker", ["pull", "-q", IMAGE], { timeout: 300_000 });
    });

    afterAll(async () => {
      await Promise.all(made.map(async (sandbox) => sandbox.close()));
      const left = await labelled(label);
      await Promise.all(
        left.map(async (id) => command("docker", ["rm", "-f", id])),
      );
    });

    it("runs commands with the env, in an empty working directory, with nothing of the host mounted", async () => {
      const sandbox = await open();

      const env = await sandbox.exec('printf %s "$SANDBOX_TOKEN"');
      const listing = await sandbox.exec("ls -A");
      const host = await sandbox.exec({
        command: `test -e ${JSON.stringify(process.cwd())}`,
        allowFailure: true,
      });
      const mounts = await command("docker", [
        "inspect",
        "--format",
        "{{json .Mounts}}",
        sandbox.sandboxId,
      ]);

      expect(env.stdout).toBe("tok-real");
      expect(sandbox.workingDirectory).toBe("/workspace");
      expect(listing.stdout).toBe("");
      expect(host.exitCode).not.toBe(0);
      expect(mounts.trim()).toBe("[]");
    });

    it("writes and reads files, and runs a sudo command as root", async () => {
      const sandbox = await open();

      await sandbox.writeTextFile({ path: "a/b.txt", content: "héllo\n" });

      await expect(sandbox.readTextFile({ path: "a/b.txt" })).resolves.toBe(
        "héllo\n",
      );
      await expect(
        sandbox.readTextFile({ path: "missing" }),
      ).resolves.toBeNull();
      await expect(
        sandbox.exec({ command: "id -u", sudo: true }),
      ).resolves.toMatchObject({ stdout: "0\n" });
    });

    it("kills an aborted command in the container", async () => {
      const sandbox = await open();
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 500);

      const result = await sandbox.exec({
        command: "sleep 3 && echo late > late.txt",
        allowFailure: true,
        abortSignal: controller.signal,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 3500);
      });

      expect(result.exitCode).toBe(143);
      await expect(
        sandbox.readTextFile({ path: "late.txt" }),
      ).resolves.toBeNull();
    }, 15_000);

    it("ends and removes the container at its kill time", async () => {
      const sandbox = await open(3 / 60);

      await new Promise((resolve) => {
        setTimeout(resolve, sandbox.killTime.getTime() - Date.now() + 3000);
      });

      await expect(labelled(label)).resolves.not.toContain(sandbox.sandboxId);
      await expect(
        reattachSandbox({ provider, sandboxId: sandbox.sandboxId }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    }, 20_000);

    it("detaches and reattaches by id, and close() removes the container", async () => {
      const sandbox = await open();
      await sandbox.spawnSession({
        name: "work",
        agent: fakeAgent({
          lines: [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "s",
            }),
          ],
          hang: true,
        }),
        prompt: "Work.",
      });
      const receipt = await sandbox.detach();

      const reattached = await reattachSandbox({
        provider,
        sandboxId: receipt.sandboxId,
      });

      await expect(reattached?.status()).resolves.toMatchObject({
        running: [{ kind: "session", name: "work" }],
        detached: { detachId: receipt.detachId },
      });
      expect(reattached?.killTime).toStrictEqual(sandbox.killTime);
      await reattached?.close();
      await expect(labelled(label)).resolves.not.toContain(sandbox.sandboxId);
    }, 30_000);
  },
);
