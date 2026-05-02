import { randomBytes } from "node:crypto";

export function newRunId(): string {
  const date = new Date();
  const stamp =
    date.getUTCFullYear().toString().padStart(4, "0") +
    (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    date.getUTCDate().toString().padStart(2, "0") +
    "-" +
    date.getUTCHours().toString().padStart(2, "0") +
    date.getUTCMinutes().toString().padStart(2, "0") +
    date.getUTCSeconds().toString().padStart(2, "0");
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}
