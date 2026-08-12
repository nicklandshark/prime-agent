#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../src/models.generated.ts", import.meta.url);
const block = "\t\"cursor-not-cloud\": {\n\t\t\"cursor-grok-4.5-high\": {\n\t\t\tid: \"cursor-grok-4.5-high\",\n\t\t\tname: \"Cursor Grok 4.5\",\n\t\t\tapi: \"cursor-not-cloud\",\n\t\t\tprovider: \"cursor-not-cloud\",\n\t\t\tbaseUrl: \"https://api2.cursor.sh\",\n\t\t\treasoning: true,\n\t\t\tthinkingLevelMap: {\"off\":null,\"minimal\":null,\"low\":\"cursor-grok-4.5-low\",\"medium\":\"cursor-grok-4.5-medium\",\"high\":\"cursor-grok-4.5-high\",\"xhigh\":null,\"max\":null},\n\t\t\tinput: [\"text\"],\n\t\t\t// Published model-pool estimates (USD/M tokens), not Cursor subscription invoices.\n\t\t\tcost: {\n\t\t\t\tinput: 2,\n\t\t\t\toutput: 6,\n\t\t\t\tcacheRead: 0,\n\t\t\t\tcacheWrite: 0,\n\t\t\t},\n\t\t\tcontextWindow: 256000,\n\t\t\tmaxTokens: 64000,\n\t\t\tfeatured: true,\n\t\t} satisfies Model<\"cursor-not-cloud\">,\n\t},\n";
let source = readFileSync(target, "utf8");
source = source.replace(/\t"cursor-not-cloud": \{[\s\S]*?^\t\},\n/m, "");
const anchor = '\t"cursor": {\n';
const index = source.indexOf(anchor);
if (index < 0) throw new Error("cursor provider anchor missing from generated catalog");
source = `${source.slice(0, index)}${block}${source.slice(index)}`;
writeFileSync(target, source);
console.log("Updated only cursor-not-cloud in src/models.generated.ts");
