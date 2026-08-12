import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

const CursorDeleteParameters = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });

type CursorDeleteArgs = Static<typeof CursorDeleteParameters>;

export type CursorDeleteTool = AgentTool<typeof CursorDeleteParameters> & { dispose(): void };

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Tool execution aborted");
}

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Linux exposes an opened directory as a stable magic link in /proc/self/fd.
 * The workspace fd is opened once at tool creation and remains the authority
 * for the tool's lifetime. Every child parent is then opened no-follow from
 * that anchor before unlinking through the final held parent.
 */
function unlinkWorkspaceFileNoFollow(workspaceFd: number, relativePath: string, signal?: AbortSignal) {
	const parts = relativePath.split(sep).filter(Boolean);
	const basename = parts.pop();
	if (!basename || basename === "." || basename === "..") throw new Error("Invalid delete path");
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	const descriptors: number[] = [];
	try {
		let directoryFd = workspaceFd;
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
export function createCursorDeleteTool(cwd: string): CursorDeleteTool {
	const workspacePath = resolve(cwd);
	let workspaceFd: number | undefined;
	let workspaceDevice: bigint | undefined;
	let workspaceInode: bigint | undefined;
	let disposed = false;
	if (process.platform === "linux") {
		const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
		const openedFd = openSync(realpathSync(workspacePath), flags);
		try {
			const anchored = fstatSync(openedFd, { bigint: true });
			workspaceFd = openedFd;
			workspaceDevice = anchored.dev;
			workspaceInode = anchored.ino;
		} catch (error) {
			closeSync(openedFd);
			throw error;
		}
	}

	return {
		name: "delete",
		label: "Delete file",
		description: "Delete one workspace-contained regular file or symbolic link.",
		parameters: CursorDeleteParameters,
		execute: async (_toolCallId: string, args: CursorDeleteArgs, signal?: AbortSignal) => {
			throwIfAborted(signal);
			if (disposed) throw new Error("Cursor delete tool is disposed");
			if (process.platform !== "linux" || workspaceFd === undefined) {
				throw new Error("Safe Cursor delete is supported only on Linux; refusing a path-racy deletion");
			}
			if (isAbsolute(args.path) || win32.isAbsolute(args.path)) {
				throw new Error("Delete path must be workspace-relative; absolute paths are not allowed");
			}
			const candidate = resolve(workspacePath, args.path);
			if (!isContained(workspacePath, candidate)) {
				throw new Error("Delete path escapes the workspace or resolves to its root");
			}

			// This check detects a removed/replaced lexical root. It never authorizes
			// traversal: even if the path changes again after stat, deletion remains
			// anchored to the original held fd rather than the replacement.
			let currentRoot = fstatSync(workspaceFd, { bigint: true });
			try {
				currentRoot = statSync(workspacePath, { bigint: true });
			} catch {
				throw new Error("Workspace root is no longer the directory anchored when the delete tool was created");
			}
			if (currentRoot.dev !== workspaceDevice || currentRoot.ino !== workspaceInode) {
				throw new Error("Workspace root changed after the delete tool was created; refusing deletion");
			}

			throwIfAborted(signal);
			const stat = unlinkWorkspaceFileNoFollow(workspaceFd, relative(workspacePath, candidate), signal);
			const sizeText = stat.size ? ` (${stat.size} bytes)` : "";
			return {
				content: [{ type: "text", text: `Deleted ${args.path}${sizeText}` }],
				details: {},
			};
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (workspaceFd !== undefined) {
				try {
					closeSync(workspaceFd);
				} finally {
					workspaceFd = undefined;
				}
			}
		},
	};
}
