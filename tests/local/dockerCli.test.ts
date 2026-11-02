import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runCli.js";
import { command } from "./helpers/command.js";
import { imagesFor } from "./helpers/sandboxes.js";

// `sandcastle docker build-image` and `sandcastle docker remove-image`, run
// as the user runs them, against the real Docker engine.

const images = imagesFor("docker");

const hostUid = String(process.getuid?.() ?? 1000);
const hostGid = String(process.getgid?.() ?? 1000);

/** Whether Docker has an image tagged `tag`. */
const imageExists = async (tag: string): Promise<boolean> =>
  command("docker", ["image", "inspect", tag]).then(
    () => true,
    () => false,
  );

describe.skipIf(images === undefined)(
  "sandcastle docker build-image / remove-image",
  { concurrent: true },
  () => {
    const base = images?.base ?? "";
    const suffix = `${String(process.pid)}-${String(Date.now())}`;
    const tags: string[] = [];
    const containers: string[] = [];
    let project = "";

    /** A tag for this run, removed in afterAll. */
    const tag = (label: string): string => {
      const name = `sandcastle-local-cli:${label}-${suffix}`;
      tags.push(name);
      return name;
    };

    beforeAll(async () => {
      project = await realpath(
        await mkdtemp(path.join(tmpdir(), "local-docker-cli-")),
      );
      await mkdir(path.join(project, ".sandcastle"));
      // The build args the CLI passes, recorded where `docker image inspect`
      // can read them.
      await writeFile(
        path.join(project, ".sandcastle", "Dockerfile"),
        `FROM ${base}\nARG AGENT_UID\nARG AGENT_GID\nLABEL sandcastle.test.ids="$AGENT_UID:$AGENT_GID"\n`,
      );
      await writeFile(path.join(project, "marker.txt"), "from the cwd");
      await writeFile(
        path.join(project, "custom.Dockerfile"),
        `FROM ${base}\nCOPY marker.txt /marker.txt\n`,
      );
    });

    afterAll(async () => {
      await command("docker", ["rm", "-f", ...containers]).catch(
        () => undefined,
      );
      await command("docker", ["rmi", "-f", ...tags]).catch(() => undefined);
      await rm(project, { recursive: true, force: true });
    });

    it("builds .sandcastle/Dockerfile with the host UID and GID as build args", async () => {
      const image = tag("ids");

      const result = await runCli(
        ["docker", "build-image", "--image-name", image],
        { cwd: project },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      const stdout = await command("docker", [
        "image",
        "inspect",
        image,
        "--format",
        '{{index .Config.Labels "sandcastle.test.ids"}}',
      ]);
      expect(stdout.trim()).toBe(`${hostUid}:${hostGid}`);
    });

    it("builds a --dockerfile with the current directory as its context", async () => {
      const image = tag("custom");

      const result = await runCli(
        [
          "docker",
          "build-image",
          "--image-name",
          image,
          "--dockerfile",
          "custom.Dockerfile",
        ],
        { cwd: project },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      const stdout = await command("docker", [
        "run",
        "--rm",
        image,
        "cat",
        "/marker.txt",
      ]);
      expect(stdout).toBe("from the cwd");
    });

    it("removes an image", async () => {
      const image = tag("remove");
      await command("docker", ["tag", base, image]);

      const result = await runCli(
        ["docker", "remove-image", "--image-name", image],
        { cwd: project },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      await expect(imageExists(image)).resolves.toBe(false);
    });

    it("says there is nothing to remove when the image does not exist", async () => {
      const image = `sandcastle-local-cli:never-built-${suffix}`;

      const result = await runCli(
        ["docker", "remove-image", "--image-name", image],
        { cwd: project },
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `Docker image '${image}' does not exist, so there is nothing to remove.`,
      );
    });

    it("reports Docker's own reason when an image can't be removed", async () => {
      // Its own image, not another tag of `base` (which rmi would only
      // untag), with a container using it.
      const image = tag("in-use");
      const source = await command("docker", ["create", base]);
      containers.push(source.trim());
      await command("docker", ["commit", source.trim(), image]);
      const user = await command("docker", ["create", image]);
      containers.push(user.trim());

      const result = await runCli(
        ["docker", "remove-image", "--image-name", image],
        { cwd: project },
      );

      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("docker rmi failed");
      expect(output).not.toContain("does not exist");
      await expect(imageExists(image)).resolves.toBe(true);
    });
  },
);
