import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowEvent } from "./types.js";

export class WorkflowEventLog<Event extends object = WorkflowEvent> {
  constructor(readonly filePath: string) {}

  async append(event: Event): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readAll(): Promise<Event[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    return content
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Event);
  }
}
