import path from "node:path";

export const resolveThreadDir = (rootDir: string, threadId: string): string => {
  return path.join(path.resolve(rootDir), "threads", threadId);
};

export const resolveLaneDir = (
  rootDir: string,
  threadId: string,
  laneId: string,
): string => {
  return path.join(resolveThreadDir(rootDir, threadId), "lanes", laneId);
};

export const resolveTapePath = (
  rootDir: string,
  threadId: string,
  laneId: string,
): string => {
  return path.join(resolveLaneDir(rootDir, threadId, laneId), "tape.jsonl");
};
