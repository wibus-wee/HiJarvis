import os from "node:os";
import path from "node:path";

let stateDirOverride: string | undefined;

export function setStateDir(dir?: string): void {
  const trimmed = dir?.trim();
  stateDirOverride = trimmed ? trimmed : undefined;
}

/** Resolve the SDK state directory. */
export function resolveStateDir(): string {
  return stateDirOverride ?? path.join(os.homedir(), ".wechat-sdk");
}
