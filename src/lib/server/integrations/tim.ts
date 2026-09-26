import { stripVTControlCharacters } from "node:util";
import type { Action } from "../classifier/schemas";

export type TimPlanAction = Extract<
  Action,
  { type: "tim.plan.create" | "tim.plan.create_and_execute" }
>;

export type TimQueueMode = "default" | "queued";

export interface TimProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TimProcess = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<TimProcessResult>;

export interface TimPlanCommandResult {
  status: "succeeded" | "failed" | "needs_reconciliation";
  planId: string | null;
  queueMode: TimQueueMode;
  commandOutcome: {
    state: "succeeded" | "failed" | "uncertain";
    exitCode: number;
    stdout: string;
    stderr: string;
  };
}

export interface TimCli {
  createPlan(action: TimPlanAction, cwd: string): Promise<TimPlanCommandResult>;
}

/** Run a command without a shell and collect both output streams. */
export const runTimProcess: TimProcess = async (command, args, { cwd }) => {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (child.signalCode) {
    throw new Error(`Tim process was interrupted by ${child.signalCode}.`);
  }
  return { exitCode, stdout, stderr };
};

/** Parse the message printed by Tim's `tim add` command. */
export function parseTimPlanId(stdout: string): string | null {
  const plainOutput = stripVTControlCharacters(stdout);
  return plainOutput.match(/Created plan stub:\s*plan\s+(\d+)\b/i)?.[1] ?? null;
}

function argsForAction(action: TimPlanAction): string[] {
  return [
    "add",
    ...(action.type === "tim.plan.create_and_execute" ? ["--simple", "--status", "queued"] : []),
    `--details=${action.description}`,
    "--",
    action.description,
  ];
}

/** Build the Tim CLI adapter. The executable comes from service configuration, never model data. */
export function createTimCli(options: { process?: TimProcess; executable?: string } = {}): TimCli {
  const runProcess = options.process ?? runTimProcess;
  const executable = options.executable ?? "tim";

  return {
    async createPlan(action, cwd) {
      const result = await runProcess(executable, argsForAction(action), { cwd });
      const queueMode: TimQueueMode =
        action.type === "tim.plan.create_and_execute" ? "queued" : "default";
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          planId: null,
          queueMode,
          commandOutcome: { state: "failed", ...result },
        };
      }

      const planId = parseTimPlanId(result.stdout);
      if (!planId) {
        return {
          status: "needs_reconciliation",
          planId: null,
          queueMode,
          commandOutcome: { state: "uncertain", ...result },
        };
      }

      return {
        status: "succeeded",
        planId,
        queueMode,
        commandOutcome: { state: "succeeded", ...result },
      };
    },
  };
}
