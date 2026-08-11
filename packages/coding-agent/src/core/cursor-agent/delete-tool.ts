import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

const CursorDeleteParameters = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

type CursorDeleteArgs = Static<typeof CursorDeleteParameters>;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Tool execution aborted");
}

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Build the hidden, workspace-scoped AgentTool used only for Cursor's native
 * delete exec frame. It is registered with Agent.executeExternalTool so schema
 * validation, policy hooks, lifecycle events, and cancellation all apply.
 */
export function createCursorDeleteTool(cwd: string): AgentTool<typeof CursorDeleteParameters> {
	const workspacePath = resolve(cwd);
	return {
		name: "delete",
		label: "Delete file",
		description: "Delete one workspace-contained regular file or symbolic link.",
		parameters: CursorDeleteParameters,
		execute: async (_toolCallId: string, args: CursorDeleteArgs, signal?: AbortSignal) => {
			throwIfAborted(signal);
			if (isAbsolute(args.path) || win32.isAbsolute(args.path)) {
				throw new Error("Delete path must be workspace-relative; absolute paths are not allowed");
			}

			const candidate = resolve(workspacePath, args.path);
			if (!isContained(workspacePath, candidate)) {
				throw new Error("Delete path escapes the workspace or resolves to its root");
			}

			const workspaceRealPath = await realpath(workspacePath);
			throwIfAborted(signal);
			const parentRealPath = await realpath(dirname(candidate));
			if (!isContained(workspaceRealPath, parentRealPath) && parentRealPath !== workspaceRealPath) {
				throw new Error("Delete path escapes the workspace through a symbolic-link directory");
			}

			const stat = await lstat(candidate);
			if (!stat.isFile() && !stat.isSymbolicLink()) {
				throw new Error(
					"Delete only supports regular files and symbolic links; recursive directory deletion is forbidden",
				);
			}
			throwIfAborted(signal);
			await unlink(candidate);

			const sizeText = stat.size ? ` (${stat.size} bytes)` : "";
			return {
				content: [{ type: "text", text: `Deleted ${args.path}${sizeText}` }],
				details: {},
			};
		},
	};
}
