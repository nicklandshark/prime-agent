import { closeSync, constants, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

const CursorDeleteParameters = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });

type CursorDeleteArgs = Static<typeof CursorDeleteParameters>;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Tool execution aborted");
}

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Linux exposes an opened directory as a stable magic link in /proc/self/fd.
 * Open every parent component with O_NOFOLLOW relative to the preceding held
 * directory, then unlink through the final held parent. This is the unlinkat
 * containment property Node's path-only fs.promises API cannot express.
 */
function unlinkWorkspaceFileNoFollow(workspaceRealPath: string, relativePath: string, signal?: AbortSignal) {
	if (process.platform !== "linux") {
		throw new Error("Safe Cursor delete is supported only on Linux; refusing a path-racy deletion");
	}
	const parts = relativePath.split(sep).filter(Boolean);
	const basename = parts.pop();
	if (!basename || basename === "." || basename === "..") throw new Error("Invalid delete path");
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	const descriptors: number[] = [];
	try {
		let directoryFd = openSync(workspaceRealPath, flags);
		descriptors.push(directoryFd);
		for (const part of parts) {
			if (part === "." || part === "..") throw new Error("Delete path contains an unsafe parent component");
			throwIfAborted(signal);
			directoryFd = openSync(`/proc/self/fd/${directoryFd}/${part}`, flags);
			descriptors.push(directoryFd);
		}
		throwIfAborted(signal);
		const target = `/proc/self/fd/${directoryFd}/${basename}`;
		const stat = lstatSync(target);
		if (!stat.isFile() && !stat.isSymbolicLink()) {
			throw new Error(
				"Delete only supports regular files and symbolic links; recursive directory deletion is forbidden",
			);
		}
		throwIfAborted(signal);
		unlinkSync(target);
		return stat;
	} finally {
		for (const fd of descriptors.reverse()) {
			try {
				closeSync(fd);
			} catch {
				// Best-effort descriptor cleanup; the unlink outcome remains authoritative.
			}
		}
	}
}

/** Hidden, workspace-scoped delete tool used only by Cursor's native exec frame. */
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
			const workspaceRealPath = realpathSync(workspacePath);
			throwIfAborted(signal);
			const stat = unlinkWorkspaceFileNoFollow(workspaceRealPath, relative(workspacePath, candidate), signal);
			const sizeText = stat.size ? ` (${stat.size} bytes)` : "";
			return {
				content: [{ type: "text", text: `Deleted ${args.path}${sizeText}` }],
				details: {},
			};
		},
	};
}
