import type { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Persist an encoded host record without truncating its last durable version. */
export const writePrivateRecord = (
  fs: FileSystem.FileSystem,
  path: string,
  encoded: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(encoded));
      yield* file.sync;
      yield* fs.rename(temporary, path);
      if (process.platform !== "win32") {
        const directory = yield* fs.open(dirname(path));
        yield* directory.sync;
      }
    }),
  );
