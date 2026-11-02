import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daytona } from "@ai-hero/sandcastle/sandboxes/daytona";

// daytona() puts the Daytona sandbox id on the handle as `sandboxId`.
// Sandbox.sandboxId reading the handle is covered for isolated providers in
// sandboxId.test.ts. vercel()'s case is in src/sandboxes/vercel.test.ts:
// @vercel/sandbox is an optional peer dependency that isn't installed, so
// tests/ can neither run it nor import it to mock it.
//
// daytona() runs the real @daytona/sdk against a fake Daytona API on
// localhost. Creating a sandbox answers with a started sandbox whose toolbox
// is this server too; the toolbox's work-dir and home-dir questions get
// /home/daytona; every other call succeeds with an empty body.

const DAYTONA_SANDBOX_ID = "daytona-sbx-42";

/** The fake API's JSON answer to `method url`; `apiUrl` is its own address. */
const answer = (
  apiUrl: string,
  method: string | undefined,
  url: string,
): Record<string, string> => {
  if (method === "POST" && url === "/sandbox") {
    return {
      id: DAYTONA_SANDBOX_ID,
      state: "started",
      toolboxProxyUrl: `${apiUrl}/toolbox`,
    };
  }
  if (url.endsWith("/work-dir") || url.endsWith("/user-home-dir")) {
    return { dir: "/home/daytona" };
  }
  return {};
};

describe("daytona() sandboxId", () => {
  let server: Server;
  let apiUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(apiUrl, req.method, req.url ?? "")));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake Daytona API has no port");
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("is the Daytona sandbox id", async () => {
    const handle = await daytona({
      apiKey: "fake-key",
      apiUrl,
      target: "us",
    }).create({ env: {} });
    await handle.close();

    expect(handle.sandboxId).toBe(DAYTONA_SANDBOX_ID);
  });
});
