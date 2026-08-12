#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../src/models.generated.ts", import.meta.url);
const block = `	"cursor-not-cloud": {
		"cursor-grok-4.6-high": {
			id: "cursor-grok-4.6-high",
			name: "Cursor Grok 4.6",
			api: "cursor-not-cloud",
			provider: "cursor-not-cloud",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			thinkingLevelMap: {"off":null,"minimal":null,"low":"cursor-grok-4.6-low","medium":"cursor-grok-4.6-medium","high":"cursor-grok-4.6-high","xhigh":"cursor-grok-4.6-xhigh","max":null},
			input: ["text"],
			// Published model-pool estimates (USD/M tokens), not Cursor subscription invoices.
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.5,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 64000,
			featured: true,
		} satisfies Model<"cursor-not-cloud">,
	},
`;
let source = readFileSync(target, "utf8");
source = source.replace(/	"cursor-not-cloud": \{[\s\S]*?^	\},\n/m, "");
const anchor = '	"cursor": {\n';
const index = source.indexOf(anchor);
if (index < 0) throw new Error("cursor provider anchor missing from generated catalog");
source = `${source.slice(0, index)}${block}${source.slice(index)}`;
writeFileSync(target, source);
console.log("Updated only cursor-not-cloud in src/models.generated.ts");
