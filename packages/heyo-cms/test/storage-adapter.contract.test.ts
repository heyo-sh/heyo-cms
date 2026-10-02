import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { local, memory } from "../src/uploads";
import { runStorageAdapterContract } from "./contract/storage-adapter";

runStorageAdapterContract({ name: "memory", create: () => memory() });

let directory: string | undefined;
runStorageAdapterContract({
  name: "local",
  create: async () => {
    directory = await mkdtemp(join(tmpdir(), "heyo-cms-storage-"));
    return local({ directory, baseUrl: "/media" });
  },
  cleanup: async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  },
});
