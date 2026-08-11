import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../agent/src/agent.js";
import type { AgentEvent, AgentTool } from "../../agent/src/types.js";
import { createCursorDeleteTool } from "../src/core/cursor-agent/delete-tool.js";
import { createCursorExecHandlers } from "../src/core/cursor-agent/exec-bridge.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeTool(name: string, onExecute: (args: Record<string, unknown>) => void): AgentTool<any> {
	return {
		name,
		label: `${name} test tool`,
		description: `${name} test tool`,
		parameters: {} as any,
		execute: async (_toolCallId, args) => {
			onExecute(args as Record<string, unknown>);
			return { content: [{ type: "text" as const, text: `${name} ok` }], details: {} };
		},
	};
}

function createDeleteHarness(
	cwd: string,
	options: {
		before?: NonNullable<ConstructorParameters<typeof Agent>[0]>["beforeToolCall"];
		after?: NonNullable<ConstructorParameters<typeof Agent>[0]>["afterToolCall"];
		onExecute?: () => void;
	} = {},
) {
	const baseTool = createCursorDeleteTool(cwd);
	const tool: AgentTool<any> = {
		...baseTool,
		execute: async (toolCallId, args, signal, onUpdate) => {
			options.onExecute?.();
			return await baseTool.execute(toolCallId, args as { path: string }, signal, onUpdate);
		},
	};
	const agent = new Agent({
		initialState: { tools: [] },
		beforeToolCall: options.before,
		afterToolCall: options.after,
	});
	agent.setExternalTool(tool);
	const events: AgentEvent[] = [];
	const handlers = createCursorExecHandlers({
		getTools: () => [tool],
		emitEvent: (event) => {
			events.push(event);
		},
		executeTool: (name, id, args, update, skipBefore, signal) =>
			agent.executeExternalTool(name, id, args, update, skipBefore, signal),
	});
	return { handlers, events };
}

describe("Cursor Agent exec bridge", () => {
	it("installs every legacy, streaming, modern Pi, MCP, resource, and todo handler", () => {
		const handlers = createCursorExecHandlers({ getTools: () => [] });
		for (const name of [
			"read",
			"ls",
			"grep",
			"write",
			"delete",
			"shell",
			"shellStream",
			"diagnostics",
			"piRead",
			"piBash",
			"piEdit",
			"piWrite",
			"piGrep",
			"piFind",
			"piLs",
			"mcp",
			"mcpApprovalPreflight",
			"listMcpResources",
			"readMcpResource",
			"todoSync",
		] as const) {
			expect(handlers[name], name).toBeTypeOf("function");
		}
	});

	it("executes advertised MCP calls through the live Prime tool registry", async () => {
		const executions: Record<string, unknown>[] = [];
		const tool = fakeTool("mcp__demo__lookup", (args) => executions.push(args));
		const handlers = createCursorExecHandlers({ getTools: () => [tool] });
		const result = await handlers.mcp?.({
			name: tool.name,
			providerIdentifier: "prime-agent",
			toolName: tool.name,
			toolCallId: "mcp-call-1",
			args: { query: "needle" },
			rawArgs: {},
		});

		expect(executions).toEqual([{ query: "needle" }]);
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: "mcp-call-1",
			toolName: tool.name,
			isError: false,
		});
	});

	it("answers MCP approval preflight without executing the side-effecting tool", async () => {
		let executions = 0;
		const approvals: unknown[] = [];
		const tool = fakeTool("mcp__demo__mutate", () => executions++);
		const handlers = createCursorExecHandlers({
			getTools: () => [tool],
			approveTool: async (toolName, toolCallId, args) => {
				approvals.push({ toolName, toolCallId, args });
				return true;
			},
		});
		const approved = await handlers.mcpApprovalPreflight?.({
			name: tool.name,
			providerIdentifier: "prime-agent",
			toolName: tool.name,
			toolCallId: "approval-only",
			args: { destructive: true },
			rawArgs: {},
			approvalOnly: true,
		});

		expect(approved).toBe(true);
		expect(approvals).toEqual([{ toolName: tool.name, toolCallId: "approval-only", args: { destructive: true } }]);
		expect(executions).toBe(0);
	});

	it("reuses an exact MCP preflight decision without running the policy hook twice", async () => {
		const tool = fakeTool("mcp__demo__approved", () => {});
		const skips: boolean[] = [];
		const handlers = createCursorExecHandlers({
			getTools: () => [tool],
			approveTool: async () => true,
			executeTool: async (_name, _id, _args, _update, skipBeforeToolCall) => {
				skips.push(skipBeforeToolCall === true);
				return {
					result: { content: [{ type: "text", text: "ok" }], details: {} },
					isError: false,
				};
			},
		});
		const call = {
			name: tool.name,
			providerIdentifier: "prime-agent",
			toolName: tool.name,
			toolCallId: "approved-call",
			args: { query: "safe" },
			rawArgs: {},
		};

		await handlers.mcpApprovalPreflight?.({ ...call, approvalOnly: true });
		await handlers.mcp?.(call);

		expect(skips).toEqual([true]);
	});

	it("maps modern Pi edits to Prime's batched edit arguments", async () => {
		const executions: Record<string, unknown>[] = [];
		const tool = fakeTool("edit", (args) => executions.push(args));
		const handlers = createCursorExecHandlers({ getTools: () => [tool] });
		const result = await handlers.piEdit?.({
			toolCallId: "pi-edit-1",
			args: {
				$typeName: "agent.v1.PiEditExecArgs",
				path: "src/file.ts",
				edits: [{ $typeName: "agent.v1.PiEditReplacement", oldText: "old", newText: "new" }],
			},
		});

		expect(executions).toEqual([{ path: "src/file.ts", edits: [{ oldText: "old", newText: "new" }] }]);
		expect(result).toMatchObject({ role: "toolResult", toolCallId: "pi-edit-1", isError: false });
	});

	it("routes delete through policy denial and lifecycle events without touching the file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-delete-policy-"));
		tempDirs.push(cwd);
		writeFileSync(join(cwd, "blocked.txt"), "keep");
		let beforeCalls = 0;
		let afterCalls = 0;
		const { handlers, events } = createDeleteHarness(cwd, {
			before: async () => {
				beforeCalls++;
				return { block: true, reason: "policy denied delete" };
			},
			after: async () => {
				afterCalls++;
				return undefined;
			},
		});

		const result = await handlers.delete?.({
			$typeName: "agent.v1.DeleteArgs",
			path: "blocked.txt",
			toolCallId: "delete-denied",
		});
		expect(result).toMatchObject({ isError: true });
		expect(result && "content" in result ? result.content[0] : undefined).toMatchObject({
			text: "policy denied delete",
		});
		expect(existsSync(join(cwd, "blocked.txt"))).toBe(true);
		expect(beforeCalls).toBe(1);
		expect(afterCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
	});

	it("runs delete before/after hooks and the scoped tool exactly once", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-delete-once-"));
		tempDirs.push(cwd);
		writeFileSync(join(cwd, "one.txt"), "once");
		let beforeCalls = 0;
		let afterCalls = 0;
		let executions = 0;
		const { handlers, events } = createDeleteHarness(cwd, {
			before: async () => {
				beforeCalls++;
				return undefined;
			},
			after: async () => {
				afterCalls++;
				return undefined;
			},
			onExecute: () => executions++,
		});

		const result = await handlers.delete?.({
			$typeName: "agent.v1.DeleteArgs",
			path: "one.txt",
			toolCallId: "delete-once",
		});
		expect(result).toMatchObject({ isError: false });
		expect(existsSync(join(cwd, "one.txt"))).toBe(false);
		expect({ beforeCalls, afterCalls, executions }).toEqual({ beforeCalls: 1, afterCalls: 1, executions: 1 });
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
	});

	it.each([
		["an absolute path", (cwd: string): string => join(cwd, "absolute.txt")],
		["a workspace escape", (_cwd: string): string => "../outside.txt"],
	] as const)("rejects %s", async (_label, pathFor) => {
		const parent = mkdtempSync(join(tmpdir(), "cursor-delete-path-"));
		tempDirs.push(parent);
		const cwd = join(parent, "workspace");
		mkdirSync(cwd);
		writeFileSync(join(parent, "outside.txt"), "keep");
		writeFileSync(join(cwd, "absolute.txt"), "keep");
		const { handlers } = createDeleteHarness(cwd);

		const result = await handlers.delete?.({
			$typeName: "agent.v1.DeleteArgs",
			path: pathFor(cwd),
			toolCallId: "delete-path",
		});
		expect(result).toMatchObject({ isError: true });
		expect(existsSync(join(parent, "outside.txt"))).toBe(true);
		expect(existsSync(join(cwd, "absolute.txt"))).toBe(true);
	});

	it("rejects recursive directory deletion", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-delete-dir-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, "dir"));
		writeFileSync(join(cwd, "dir", "child.txt"), "keep");
		const { handlers } = createDeleteHarness(cwd);
		const result = await handlers.delete?.({
			$typeName: "agent.v1.DeleteArgs",
			path: "dir",
			toolCallId: "delete-dir",
		});
		expect(result).toMatchObject({ isError: true });
		expect(existsSync(join(cwd, "dir", "child.txt"))).toBe(true);
	});

	it("honors a per-exec AbortSignal before deletion", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-delete-abort-"));
		tempDirs.push(cwd);
		writeFileSync(join(cwd, "abort.txt"), "keep");
		const { handlers } = createDeleteHarness(cwd);
		const controller = new AbortController();
		controller.abort();

		const result = await handlers.delete?.(
			{ $typeName: "agent.v1.DeleteArgs", path: "abort.txt", toolCallId: "delete-abort" },
			{ signal: controller.signal },
		);
		expect(result).toMatchObject({ isError: true });
		expect(existsSync(join(cwd, "abort.txt"))).toBe(true);
	});

	it("deletes only an in-workspace symlink and leaves its target intact", async () => {
		const parent = mkdtempSync(join(tmpdir(), "cursor-delete-link-"));
		tempDirs.push(parent);
		const cwd = join(parent, "workspace");
		mkdirSync(cwd);
		const target = join(parent, "target.txt");
		writeFileSync(target, "keep");
		symlinkSync(target, join(cwd, "link.txt"));
		const { handlers } = createDeleteHarness(cwd);

		const result = await handlers.delete?.({
			$typeName: "agent.v1.DeleteArgs",
			path: "link.txt",
			toolCallId: "delete-link",
		});
		expect(result).toMatchObject({ isError: false });
		expect(existsSync(join(cwd, "link.txt"))).toBe(false);
		expect(existsSync(target)).toBe(true);
	});
});
