import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../src/providers/cursor-not-cloud/agent_pb.ts", import.meta.url);
const generated = readFileSync(path, "utf8");
writeFileSync(path, generated.replace(/\n+$/, "\n"));
