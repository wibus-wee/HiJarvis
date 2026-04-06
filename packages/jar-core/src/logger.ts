import { Writable } from "node:stream";
import process from "node:process";

import pino from "pino";
import type {
  DestinationStream,
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
  LevelWithSilent,
} from "pino";
import pinoPretty from "pino-pretty";

export const logLevels = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof logLevels)[number];

export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

export type LogFields = Record<string, LogValue>;

export type Logger = {
  level: LogLevel;
  child: (context: LogFields) => Logger;
  error: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  debug: (event: string, fields?: LogFields) => void;
  isLevelEnabled: (level: LogLevel) => boolean;
  drain: () => Promise<void>;
};

export type LoggerOptions = {
  level?: LogLevel;
  stderr?: boolean;
  filePath?: string;
  now?: () => Date;
  stderrWriter?: Pick<NodeJS.WriteStream, "write">;
};

type LoggerState = {
  level: LogLevel;
  runtime: PinoLogger;
};

const redactPaths = [
  "apiKey",
  "api_key",
  "authorization",
  "botToken",
  "signingSecret",
  "appToken",
  "token",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.botToken",
  "*.signingSecret",
  "*.appToken",
  "*.token",
  "headers.authorization",
  "*.headers.authorization",
  "providerConfig.apiKey",
  "platform.slack.botToken",
  "platform.slack.appToken",
  "platform.slack.signingSecret",
];

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const level = options.level ?? "info";
  const streams: DestinationStream[] = [];

  if (options.stderr ?? true) {
    streams.push(createPrettyStream(options));
  }

  if (options.filePath) {
    streams.push(
      pino.destination({
        dest: options.filePath,
        mkdir: true,
        sync: true,
      }),
    );
  }

  const runtime = streams.length === 0
    ? pino({ enabled: false })
    : pino(createPinoOptions(options, level), pino.multistream(streams));

  return buildLogger({
    level,
    runtime,
  });
};

const buildLogger = (state: LoggerState): Logger => {
  return {
    level: state.level,
    child: (context) =>
      buildLogger({
        ...state,
        runtime: state.runtime.child(normalizeFields(context)),
      }),
    error: (event, fields) => writeLog(state, "error", event, fields),
    warn: (event, fields) => writeLog(state, "warn", event, fields),
    info: (event, fields) => writeLog(state, "info", event, fields),
    debug: (event, fields) => writeLog(state, "debug", event, fields),
    isLevelEnabled: (level) => state.runtime.isLevelEnabled(level),
    drain: async () =>
      new Promise<void>((resolve) => {
        state.runtime.flush(() => resolve());
      }),
  };
};

const writeLog = (
  state: LoggerState,
  level: LogLevel,
  event: string,
  fields?: LogFields,
): void => {
  state.runtime[level](normalizeFields(fields), event);
};

const normalizeFields = (fields?: LogFields): Record<string, LogValue> => {
  if (!fields) {
    return {};
  }

  const normalized: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
};

const createPinoOptions = (
  options: LoggerOptions,
  level: LogLevel,
): PinoLoggerOptions => {
  return {
    level: toPinoLevel(level),
    base: null,
    timestamp: () => `,"time":"${(options.now ?? (() => new Date()))().toISOString()}"`,
    redact: {
      paths: redactPaths,
      censor: "[Redacted]",
    },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: () => ({}),
    },
  };
};

const createPrettyStream = (options: LoggerOptions): DestinationStream => {
  return pinoPretty({
    colorize: false,
    destination: toWritableStream(options.stderrWriter ?? process.stderr),
    ignore: "pid,hostname",
    levelFirst: true,
    messageFormat: "{msg}",
    singleLine: true,
    sync: true,
    translateTime: "SYS:standard",
  });
};

const toWritableStream = (
  writer: Pick<NodeJS.WriteStream, "write">,
): NodeJS.WritableStream => {
  if (writer === process.stderr) {
    return process.stderr;
  }

  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        writer.write(chunk.toString());
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
};

const toPinoLevel = (level: LogLevel): LevelWithSilent => {
  return level;
};
