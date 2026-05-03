import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "./core";
import { docker } from "./sandboxes/docker";
import { noSandbox } from "./sandboxes/no-sandbox";
import { podman } from "./sandboxes/podman";
import { vercel } from "./sandboxes/vercel";

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

  test("noSandbox returns a no-sandbox provider", () => {
    const provider = noSandbox();
    expect(provider.kind).toBe("no-sandbox");
    expect(provider.name).toBe("no-sandbox");
  });

  test("noSandbox carries env when supplied", () => {
    const provider = noSandbox({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });
});
