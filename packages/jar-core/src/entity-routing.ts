import type {
  LoadedEntityConfig,
  LoadedPlatformIdentityConfig,
  LoadedRuntimeConfig,
} from "./config.js";
import { listThreads, type ThreadListItem } from "./lanes/index.js";

export type Platform = "slack" | "telegram";

export type IdentityTarget = {
  identityId: string;
  platform: Platform;
  scope: string;
};

export type RoutedIdentityThread = {
  identity: LoadedPlatformIdentityConfig;
  entity: LoadedEntityConfig;
  threadId: string;
  platform: Platform;
  scope: string;
};

const sessionPrefix = "identity";

export const getEntityById = (
  config: LoadedRuntimeConfig,
  entityId: string,
): LoadedEntityConfig | undefined => {
  return config.entities[entityId];
};

export const getPlatformIdentityById = (
  config: LoadedRuntimeConfig,
  identityId: string,
): LoadedPlatformIdentityConfig | undefined => {
  return config.platformIdentities[identityId];
};

export const resolveIdentitySessionId = (target: IdentityTarget): string => {
  const raw = `${sessionPrefix}:${target.identityId}:${target.platform}:${target.scope}`;
  return raw.replaceAll(":", "__").replaceAll("/", "_");
};

export const parseIdentitySessionId = (
  sessionId: string,
): { identityId: string; platform: Platform; scope: string } | null => {
  const parts = sessionId.split("__");
  if (parts.length < 4 || parts[0] !== sessionPrefix) {
    return null;
  }

  const [, identityId, platform, ...scopeParts] = parts;
  if ((platform !== "slack" && platform !== "telegram") || !identityId) {
    return null;
  }

  return {
    identityId,
    platform,
    scope: scopeParts.join("__"),
  };
};

export const resolveIdentityThread = (
  config: LoadedRuntimeConfig,
  target: IdentityTarget,
): RoutedIdentityThread => {
  const identity = getPlatformIdentityById(config, target.identityId);
  if (identity === undefined) {
    throw new Error(`Unknown platform identity \"${target.identityId}\"`);
  }
  if (identity.platform !== target.platform) {
    throw new Error(
      `Platform identity \"${target.identityId}\" is bound to ${identity.platform}, not ${target.platform}`,
    );
  }

  const entity = getEntityById(config, identity.entityId);
  if (entity === undefined) {
    throw new Error(
      `Platform identity \"${target.identityId}\" references unknown entity \"${identity.entityId}\"`,
    );
  }

  return {
    identity,
    entity,
    threadId: resolveIdentitySessionId(target),
    platform: target.platform,
    scope: target.scope,
  };
};

export const findMostRecentIdentityThread = async (
  config: LoadedRuntimeConfig,
  identityId: string,
): Promise<RoutedIdentityThread | null> => {
  const identity = getPlatformIdentityById(config, identityId);
  if (identity === undefined) {
    throw new Error(`Unknown platform identity \"${identityId}\"`);
  }
  const entity = getEntityById(config, identity.entityId);
  if (entity === undefined) {
    throw new Error(
      `Platform identity \"${identityId}\" references unknown entity \"${identity.entityId}\"`,
    );
  }

  const threads = await listThreads(config.sessions.rootDir);
  const match = threads.find((thread) => parseIdentitySessionId(thread.threadId)?.identityId === identityId);
  if (match === undefined) {
    return null;
  }

  const parsed = parseIdentitySessionId(match.threadId);
  if (parsed === null) {
    return null;
  }

  return {
    identity,
    entity,
    threadId: match.threadId,
    platform: parsed.platform,
    scope: parsed.scope,
  };
};

export const sessionBelongsToIdentity = (
  session: ThreadListItem,
  identityId: string,
): boolean => {
  return parseIdentitySessionId(session.threadId)?.identityId === identityId;
};
