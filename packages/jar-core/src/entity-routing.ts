import crypto from "node:crypto";

import type {
  LoadedEntityConfig,
  LoadedPlatformIdentityConfig,
  LoadedRuntimeConfig,
} from "./config.js";
import { listSessions, type SessionListItem } from "./session-store.js";

export type Platform = "slack" | "telegram";

export type IdentityTarget = {
  identityId: string;
  platform: Platform;
  scope: string;
};

export type RoutedIdentityThread = {
  identity: LoadedPlatformIdentityConfig;
  entity: LoadedEntityConfig;
  sessionId: string;
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
    sessionId: resolveIdentitySessionId(target),
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

  const sessions = await listSessions(config.sessions.rootDir);
  const match = sessions.find((session) => parseIdentitySessionId(session.sessionId)?.identityId === identityId);
  if (!match) {
    return null;
  }

  const parsed = parseIdentitySessionId(match.sessionId);
  if (parsed === null) {
    return null;
  }

  return {
    identity,
    entity,
    sessionId: match.sessionId,
    platform: parsed.platform,
    scope: parsed.scope,
  };
};

export const findMostRecentThreadForEntity = async (
  config: LoadedRuntimeConfig,
  entityId: string,
): Promise<RoutedIdentityThread | null> => {
  const entity = getEntityById(config, entityId);
  if (entity === undefined) {
    throw new Error(`Unknown Jarvis entity \"${entityId}\"`);
  }

  const identityIds = Object.values(config.platformIdentities)
    .filter((identity) => identity.entityId === entityId)
    .map((identity) => identity.id);
  if (identityIds.length === 0) {
    return null;
  }

  const sessions = await listSessions(config.sessions.rootDir);
  const match = sessions.find((session) => {
    const parsed = parseIdentitySessionId(session.sessionId);
    return parsed !== null && identityIds.includes(parsed.identityId);
  });
  if (!match) {
    return null;
  }

  const parsed = parseIdentitySessionId(match.sessionId);
  if (parsed === null) {
    return null;
  }

  const identity = getPlatformIdentityById(config, parsed.identityId);
  if (identity === undefined) {
    return null;
  }

  return {
    identity,
    entity,
    sessionId: match.sessionId,
    platform: parsed.platform,
    scope: parsed.scope,
  };
};

export const createEphemeralSideQuerySessionId = (identityId: string): string => {
  return `${sessionPrefix}__sidequery__${identityId}__${crypto.randomBytes(6).toString("hex")}`;
};

export const sessionBelongsToIdentity = (
  session: SessionListItem,
  identityId: string,
): boolean => {
  return parseIdentitySessionId(session.sessionId)?.identityId === identityId;
};
