// 全局日志入口：pino 结构化日志，stdout + 文件双写。
// 不用 pino transport（worker thread 与 Next bundling 有坑），文件写走 pino.destination。
// HMR 安全单例（挂 globalThis，同 storage.ts 的 getDefaultStorage 模式）；
// 不依赖 Next.js，sim/ 脚本（tsx）与 vitest 同样可用。
import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_LOG_FILE = "data/app.log";
const DEFAULT_LLM_LOG_FILE = "data/llm-calls.jsonl";

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function baseOpts(level?: string): pino.LoggerOptions {
  return {
    level: level ?? process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/** 独立构造一个只写指定文件的 logger（测试用：注入临时目录，避开全局单例） */
export function createFileLogger(
  logFile: string,
  opts: { level?: string; component?: string } = {},
): pino.Logger {
  ensureDir(logFile);
  const logger = pino(
    { ...baseOpts(opts.level), base: opts.component ? { component: opts.component } : undefined },
    pino.destination({ dest: logFile, sync: true }),
  );
  return logger;
}

interface LoggerBundle {
  logger: pino.Logger;
  /** LLM 调用专用（component=llm_call）：除全局输出外单独落一份 JSONL 便于采集 */
  llmLogger: pino.Logger;
}

function buildBundle(): LoggerBundle {
  const logFile = process.env.LOG_FILE ?? DEFAULT_LOG_FILE;
  const llmLogFile = process.env.LLM_LOG_FILE ?? DEFAULT_LLM_LOG_FILE;
  ensureDir(logFile);
  ensureDir(llmLogFile);
  const opts = baseOpts();
  const stdout = { stream: process.stdout };
  const appDest = pino.destination({ dest: logFile, sync: true });
  const llmDest = pino.destination({ dest: llmLogFile, sync: true });
  const logger = pino(opts, pino.multistream([stdout, { stream: appDest }]));
  const llmLogger = pino(
    opts,
    pino.multistream([stdout, { stream: appDest }, { stream: llmDest }]),
  ).child({ component: "llm_call" });
  return { logger, llmLogger };
}

// Next dev 热更新会重复加载模块，单例挂 globalThis 避免反复开文件句柄
const globalLog = globalThis as unknown as { __appLoggers?: LoggerBundle };

function bundle(): LoggerBundle {
  globalLog.__appLoggers ??= buildBundle();
  return globalLog.__appLoggers;
}

export function getLogger(): pino.Logger {
  return bundle().logger;
}

export function getLLMLogger(): pino.Logger {
  return bundle().llmLogger;
}

export function createChildLogger(component: string): pino.Logger {
  return bundle().logger.child({ component });
}
