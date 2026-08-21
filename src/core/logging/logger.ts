/**
 * Structured logging.
 *
 * Every log line goes to stdout for local development AND (when it carries a
 * project/agent-run/task association or is WARN+) into the LogEntry table so the
 * dashboard's Logs view shows what the system actually did. DB writes are
 * fire-and-forget so logging can never break the thing it is observing.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import type { LogLevel } from "@/core/types/enums";

export interface LogContext {
  projectId?: string;
  agentRunId?: string;
  taskId?: string;
  workflowRunId?: string;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "INFO";
const QUIET = process.env.LOG_SILENT === "true";

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly base: LogContext = {},
  ) {}

  child(scope: string, ctx: LogContext = {}): Logger {
    return new Logger(`${this.scope}:${scope}`, { ...this.base, ...ctx });
  }

  debug(message: string, ctx: LogContext = {}) {
    return this.emit("DEBUG", message, ctx);
  }
  info(message: string, ctx: LogContext = {}) {
    return this.emit("INFO", message, ctx);
  }
  warn(message: string, ctx: LogContext = {}) {
    return this.emit("WARN", message, ctx);
  }
  error(message: string, ctx: LogContext = {}) {
    return this.emit("ERROR", message, ctx);
  }

  private emit(level: LogLevel, message: string, ctx: LogContext) {
    const merged = { ...this.base, ...ctx };
    if (LEVEL_RANK[level] >= LEVEL_RANK[MIN_LEVEL] && !QUIET) {
      const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${this.scope} - ${message}`;
      const extras = Object.keys(merged).length ? ` ${JSON.stringify(merged)}` : "";
      if (level === "ERROR") console.error(line + extras);
      else if (level === "WARN") console.warn(line + extras);
      else console.log(line + extras);
    }

    const persist = Boolean(merged.projectId || merged.agentRunId || merged.taskId) || LEVEL_RANK[level] >= 30;
    if (!persist) return;

    const { projectId, agentRunId, taskId, ...rest } = merged;
    void prisma.logEntry
      .create({
        data: {
          level,
          scope: this.scope,
          message: message.slice(0, 2000),
          contextJson: writeJson(rest),
          projectId: projectId as string | undefined,
          agentRunId: agentRunId as string | undefined,
          taskId: taskId as string | undefined,
        },
      })
      .catch((e) => {
        if (!QUIET) console.error("[logger] failed to persist log entry:", e?.message ?? e);
      });
  }
}

export const logger = new Logger("aios");

export function scopedLogger(scope: string, ctx: LogContext = {}) {
  return new Logger(scope, ctx);
}
