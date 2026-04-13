import type { LoadedRuntimeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { MessageIngressCommand } from "../ingress.js";
import {
  createFileSystemConversationStateStore,
  createFileSystemEventLogStore,
  createFileSystemExecutionAuditStore,
  createFileSystemUsageStore,
} from "../persistence.js";
import type { StoresContext } from "./types.js";

export const initStores = (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
): StoresContext => ({
  config,
  command,
  logger,
  stateStore: createFileSystemConversationStateStore(),
  auditStore: createFileSystemExecutionAuditStore(),
  eventStore: createFileSystemEventLogStore(),
  usageStore: createFileSystemUsageStore(config.sessions.rootDir),
  startTime: Date.now(),
});
