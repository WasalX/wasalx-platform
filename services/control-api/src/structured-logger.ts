import type { LoggerService } from "@nestjs/common";
import { recordStructuredLog, safeErrorCode } from "@wasalx/observability";

export class StructuredLogger implements LoggerService {
  log(_message: unknown, context?: string) {
    recordStructuredLog("info", "nestjs.log", { component: boundedContext(context) });
  }

  warn(_message: unknown, context?: string) {
    recordStructuredLog("warn", "nestjs.warning", { component: boundedContext(context) });
  }

  error(message: unknown, _trace?: string, context?: string) {
    recordStructuredLog("error", "nestjs.error", {
      component: boundedContext(context),
      error_code: safeErrorCode(message),
    });
  }

  debug(_message: unknown, context?: string) {
    if (process.env.LOG_LEVEL === "debug") {
      recordStructuredLog("debug", "nestjs.debug", { component: boundedContext(context) });
    }
  }

  verbose(_message: unknown, context?: string) {
    if (process.env.LOG_LEVEL === "debug") {
      recordStructuredLog("debug", "nestjs.verbose", { component: boundedContext(context) });
    }
  }
}

function boundedContext(value: string | undefined) {
  return value?.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "nestjs";
}
