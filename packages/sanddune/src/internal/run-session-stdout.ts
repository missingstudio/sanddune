import type { AgentStreamEvent } from "../core";
import type { RunSession } from "./run-session";

export type TerminalWriter = (chunk: string) => void;

export interface OpenStdoutRunSessionInput {
  readonly name?: string;
  readonly writer?: TerminalWriter;
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
  // Text events are dropped on purpose — agent narration would flood the
  // screen mid-spinner.
}
