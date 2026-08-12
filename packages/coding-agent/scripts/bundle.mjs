#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The bundle loads the same code
 * from ~20 chunk files in under half the time. dist/ stays unbundled for
 * library consumers and type resolution; only the bin entry uses the bundle.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 */
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageDir, "dist", "bundle");
const aiProviderDir = join(packageDir, "..", "ai", "dist", "providers");
const entryPoints = {
	cli: join(packageDir, "dist", "cli.js"),
	"amazon-bedrock": join(aiProviderDir, "amazon-bedrock.js"),
	"cursor/index": join(aiProviderDir, "cursor", "index.js"),
	"cursor-not-cloud/index": join(aiProviderDir, "cursor-not-cloud", "index.js"),
};
let buildId;
try {
	buildId = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
		cwd: dirname(packageDir),
		encoding: "utf8",
	}).trim();
} catch {
	buildId = `release-${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version}`;
}

rmSync(outdir, { recursive: true, force: true });

await build({
	// register-builtins loads these Node-only providers through computed dynamic
	// imports so browser bundles do not resolve them. Explicit entry points make
	// those runtime-relative paths available in the CLI bundle.
	entryPoints,
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	// Native or interop-sensitive packages stay external; they resolve from
	// node_modules at runtime (and are loaded via createRequire/lazily anyway).
	external: ["zeromq", "koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
	define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: JSON.stringify(buildId) },
	banner: {
		js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
	},
	logLevel: "warning",
});

chmodSync(join(outdir, "cli.js"), 0o755);
for (const name of Object.keys(entryPoints)) {
	const output = join(outdir, `${name}.js`);
	if (!existsSync(output)) {
		throw new Error(`Missing bundle entry point: ${output}`);
	}
}
console.log("bundled dist/cli.js -> dist/bundle/");
