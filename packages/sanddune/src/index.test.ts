import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "@missingstudio/sanddune-core";
import {
  createSandbox,
  createWorktree,
  interactive,
  run,
} from "./index";
import { docker } from "./sandboxes/docker";
import { noSandbox } from "./sandboxes/no-sandbox";
import { podman } from "./sandboxes/podman";
import { vercel } from "./sandboxes/vercel";

describe("entry-point stubs throw NotImplementedError", () => {
  test("run", () => {
    expect(() => run({} as never)).toThrow(NotImplementedError);
    expect(() => run({} as never)).toThrow(/^run is not implemented$/);
  });

  test("createSandbox", () => {
    expect(() => createSandbox({} as never)).toThrow(NotImplementedError);
    expect(() => createSandbox({} as never)).toThrow(
      /^createSandbox is not implemented$/,
    );
  });

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

describe("sandbox provider factories throw NotImplementedError", () => {
  test("docker", () => {
    expect(() => docker()).toThrow(NotImplementedError);
    expect(() => docker()).toThrow(/^docker is not implemented$/);
  });

  test("podman", () => {
    expect(() => podman()).toThrow(NotImplementedError);
    expect(() => podman()).toThrow(/^podman is not implemented$/);
  });

  test("vercel", () => {
    expect(() => vercel()).toThrow(NotImplementedError);
    expect(() => vercel()).toThrow(/^vercel is not implemented$/);
  });

  test("noSandbox", () => {
    expect(() => noSandbox()).toThrow(NotImplementedError);
    expect(() => noSandbox()).toThrow(/^noSandbox is not implemented$/);
  });
});
