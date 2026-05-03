import type { AgentStreamEvent } from "../core";
import type { RunSession } from "./run-session";

/** Minimal sink for **terminal mode** rendering — defaults to
 *  `process.stdout.write`. Tests substitute a string-collecting writer to
 *  assert against rendered output. */
export type TerminalWriter = (chunk: string) => void;

export interface OpenStdoutRunSessionInput {
  readonly name?: string;
  /** Test seam — when omitted, writes go to `process.stdout`. */
  readonly writer?: TerminalWriter;
  /** Test seam — when omitted, the renderer asks the real `process.stdout`
   *  whether it's a TTY. Spinners / interactive redraws are emitted only
   *  when this is true; otherwise rendering is line-oriented (suitable for
   *  CI logs and snapshot tests). */
  readonly isTTY?: boolean;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const STYLES = {
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  green: `${ESC}32m`,
  red: `${ESC}31m`,
  cyan: `${ESC}36m`,
  yellow: `${ESC}33m`,
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Renders a **terminal mode** session. Spinners run only when `isTTY` is
 *  true; the line-mode fallback emits one line per state change so CI logs
 *  and tests stay parseable. `logFilePath` is always `undefined`, matching
 *  the contract that the run log file is the file-mode artifact. */
export async function openStdoutRunSession(
  input: OpenStdoutRunSessionInput = {},
): Promise<RunSession> {
  const writer: TerminalWriter =
    input.writer ?? ((chunk) => process.stdout.write(chunk));
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);
  const prefix = input.name !== undefined ? `[${input.name}] ` : "";

  let activeIteration: number | undefined;
  let frame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;

  const stopSpinner = () => {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    if (isTTY && activeIteration !== undefined) {
      writer(`\r${ESC}2K`);
    }
  };

  const drawSpinner = () => {
    if (!isTTY || activeIteration === undefined) return;
    const ch = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
    writer(
      `\r${ESC}2K${STYLES.cyan}${ch}${RESET} ${prefix}${STYLES.bold}iteration ${activeIteration}${RESET} ${STYLES.dim}working…${RESET}`,
    );
    frame += 1;
  };

  const writeLine = (line: string) => {
    stopSpinner();
    writer(`${prefix}${line}\n`);
  };

  // Header.
  writeLine(`${STYLES.cyan}▶${RESET} ${STYLES.bold}sanddune run starting${RESET}`);

  let ended = false;
  const end = (status: "ok" | "error", message?: string) => {
    if (ended) return;
    ended = true;
    stopSpinner();
    if (status === "ok") {
      writeLine(
        `${STYLES.green}✓${RESET} ${STYLES.bold}run completed${RESET}`,
      );
    } else {
      writeLine(
        `${STYLES.red}✗${RESET} ${STYLES.bold}run failed${RESET}: ${
          message ?? "unknown error"
        }`,
      );
    }
  };

  return {
    logFilePath: undefined,
    logger: {
      iterationStarted: async (iteration) => {
        activeIteration = iteration;
        if (isTTY) {
          frame = 0;
          drawSpinner();
          spinnerTimer = setInterval(drawSpinner, SPINNER_INTERVAL_MS);
        } else {
          writeLine(
            `${STYLES.cyan}…${RESET} iteration ${iteration} starting`,
          );
        }
      },
      iterationEnded: async (iteration, commitSha) => {
        stopSpinner();
        activeIteration = undefined;
        const tail = commitSha
          ? `committed ${STYLES.dim}${commitSha.slice(0, 12)}${RESET}`
          : `${STYLES.yellow}no commit${RESET}`;
        writeLine(`${STYLES.green}✓${RESET} iteration ${iteration} — ${tail}`);
      },
    },
    recordAgentEvent: (event) => renderAgentEvent(event, writeLine),
    endOk: async () => end("ok"),
    endError: async (message) => end("error", message),
  };
}

function renderAgentEvent(
  event: AgentStreamEvent,
  writeLine: (s: string) => void,
): void {
  if (event.type === "toolCall") {
    writeLine(`  ${STYLES.dim}→ tool: ${event.name}${RESET}`);
  }
  // Text events are intentionally silent in terminal mode — the agent's
  // running narration would flood the screen mid-spinner. Summaries land via
  // iterationEnded / endOk.
}
