import { describe, expect, test } from "bun:test";
import { defaultImageName } from "./docker";

describe("defaultImageName", () => {
  test("uses the basename of the host repo path", () => {
    expect(defaultImageName("/Users/me/projects/sanddune")).toBe(
      "sanddune:sanddune",
    );
  });

  test("strips trailing slashes", () => {
    expect(defaultImageName("/Users/me/projects/sanddune/")).toBe(
      "sanddune:sanddune",
    );
    expect(defaultImageName("/Users/me/projects/sanddune///")).toBe(
      "sanddune:sanddune",
    );
  });

  test("lowercases", () => {
    expect(defaultImageName("/Users/me/Projects/MyRepo")).toBe(
      "sanddune:myrepo",
    );
  });

  test("sanitizes invalid characters to '-'", () => {
    expect(defaultImageName("/Users/me/My Repo (v2)")).toBe(
      "sanddune:my-repo--v2-",
    );
  });

  test("preserves underscores, dots, and hyphens", () => {
    expect(defaultImageName("/Users/me/my_repo.dir-name")).toBe(
      "sanddune:my_repo.dir-name",
    );
  });

  test("falls back to 'local' when the path has no usable basename", () => {
    expect(defaultImageName("/")).toBe("sanddune:local");
    expect(defaultImageName("")).toBe("sanddune:local");
  });

  test("handles backslashes (Windows-style paths)", () => {
    expect(defaultImageName("C:\\Users\\me\\projects\\sanddune")).toBe(
      "sanddune:sanddune",
    );
  });
});
