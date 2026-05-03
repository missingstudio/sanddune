import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "./core";
import { createWorktree, interactive } from "./index";
import { docker } from "./sandboxes/docker";
import { noSandbox } from "./sandboxes/no-sandbox";
import { podman } from "./sandboxes/podman";
import { vercel } from "./sandboxes/vercel";

describe("entry-point stubs throw NotImplementedError", () => {
  test("createWorktree", () => {
    expect(() => createWorktree()).toThrow(NotImplementedError);
    expect(() => createWorktree()).toThrow(
      /^createWorktree is not implemented$/,
    );
  });

  test("interactive", () => {
    expect(() => interactive({} as never)).toThrow(NotImplementedError);
    expect(() => interactive({} as never)).toThrow(
      /^interactive is not implemented$/,
    );
  });
});

describe("sandbox provider factories", () => {
  test("docker returns a bind-mount provider", () => {
    const provider = docker();
    expect(provider.kind).toBe("bind-mount");
    expect(provider.name).toBe("docker");
    expect(typeof provider.create).toBe("function");
  });

  test("podman throws NotImplementedError", () => {
    expect(() => podman()).toThrow(NotImplementedError);
    expect(() => podman()).toThrow(/^podman is not implemented$/);
  });

  test("vercel throws NotImplementedError", () => {
    expect(() => vercel()).toThrow(NotImplementedError);
    expect(() => vercel()).toThrow(/^vercel is not implemented$/);
  });

  test("noSandbox throws NotImplementedError", () => {
    expect(() => noSandbox()).toThrow(NotImplementedError);
    expect(() => noSandbox()).toThrow(/^noSandbox is not implemented$/);
  });
});
