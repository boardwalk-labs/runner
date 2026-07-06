import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  isControlSignal,
  type BoardwalkTool,
  type SleepControlSignal,
} from "./types.js";

function fakeTool(name: string): BoardwalkTool<{ x: number }, { ok: true }> {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    secretsRequired: [],
    invoke: () => Promise.resolve({ ok: true } as const),
  };
}

describe("isControlSignal", () => {
  it("returns true for sleep signals", () => {
    const sig: SleepControlSignal = { __signal: "sleep", wakeAtMs: 1 };
    expect(isControlSignal(sig)).toBe(true);
  });

  it("returns true for wait_for_child signals", () => {
    expect(isControlSignal({ __signal: "wait_for_child", childRunId: "x" })).toBe(true);
  });

  it("returns false for plain tool returns", () => {
    expect(isControlSignal({ ok: true })).toBe(false);
    expect(isControlSignal(null)).toBe(false);
    expect(isControlSignal("hi")).toBe(false);
    expect(isControlSignal(undefined)).toBe(false);
  });
});

describe("ToolRegistry", () => {
  it("registers and looks up tools by name", () => {
    const reg = new ToolRegistry();
    const t = fakeTool("echo");
    reg.register(t);
    expect(reg.get("echo")).toBe(t);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("nope")).toBe(false);
  });

  it("rejects double-registration", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("echo"));
    expect(() => {
      reg.register(fakeTool("echo"));
    }).toThrow(/already registered/);
  });

  it("list() returns sorted tool names", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("zebra"));
    reg.register(fakeTool("alpha"));
    reg.register(fakeTool("mike"));
    expect(reg.list()).toEqual(["alpha", "mike", "zebra"]);
  });

  describe("materializeFor", () => {
    it("filters the registry down to the granted tools", () => {
      const reg = new ToolRegistry();
      reg.register(fakeTool("a"));
      reg.register(fakeTool("b"));
      reg.register(fakeTool("c"));
      const out = reg.materializeFor([{ name: "a" }, { name: "c" }]);
      expect(out.tools.map((t) => t.name)).toEqual(["a", "c"]);
      expect(out.missing).toEqual([]);
    });

    it("collects unknown grants into `missing` rather than throwing", () => {
      const reg = new ToolRegistry();
      reg.register(fakeTool("a"));
      const out = reg.materializeFor([{ name: "a" }, { name: "ghost" }, { name: "phantom" }]);
      expect(out.tools.map((t) => t.name)).toEqual(["a"]);
      expect(out.missing).toEqual(["ghost", "phantom"]);
    });
  });
});
