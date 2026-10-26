import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Launch and restore execute code from a discovered bundle, so the bundle must be
 * OpenAI-signed and pass ownership/permission checks along its filesystem path. Bundle
 * identifier alone (what discovery checks) is plain text in Info.plist that anyone can copy.
 */
export const OPENAI_TEAM_ID = "2DC432GLL2";

const CODESIGN = "/usr/bin/codesign";
const CODESIGN_TIMEOUT_MS = 30_000;

export interface BundleTrustDeps {
  readonly uid: number;
  readonly adminGroupId?: number;
  stat(path: string): { uid: number; gid?: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null;
  codesign(args: readonly string[]): { status: number | null; output: string };
}

export { defaultAsyncBundleTrustDeps, untrustedChatgptBundleReasonAsync } from "./bundle-trust-async";
export type { AsyncBundleTrustDeps, TrustCommandSpawn } from "./bundle-trust-async";

export function bundleTrustStat(path: string): ReturnType<BundleTrustDeps["stat"]> {
  try {
    const s = lstatSync(path);
    return { uid: s.uid, gid: s.gid, mode: s.mode, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
  } catch { return null; }
}

export function defaultBundleTrustDeps(): BundleTrustDeps {
  const admin = spawnSync("/usr/bin/dscl", [".", "-read", "/Groups/admin", "PrimaryGroupID"], {
    encoding: "utf8", timeout: 5000,
  });
  const adminId = admin.status === 0 ? /^PrimaryGroupID: ([0-9]+)\s*$/.exec(admin.stdout)?.[1] : undefined;
  return {
    adminGroupId: adminId === undefined ? undefined : Number(adminId),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    stat: bundleTrustStat,
    codesign(args) {
      const result = spawnSync(CODESIGN, [...args], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS });
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
  };
}

type FilesystemTrustDeps = Omit<BundleTrustDeps, "codesign">;

function ownedSafely(deps: FilesystemTrustDeps, path: string, kind: "file" | "directory"): string | null {
  const s = deps.stat(path);
  if (!s) return "is missing";
  if (s.isSymbolicLink) return "is a symbolic link";
  if (kind === "file" ? !s.isFile : !s.isDirectory) return `is not a ${kind}`;
  if (s.uid !== 0 && s.uid !== deps.uid) return "is owned by another user";
  if ((s.mode & 0o022) !== 0) return "is writable by group or others";
  return null;
}

/** Protect the bundle's directory entry all the way to the filesystem root. */
function untrustedAncestorReason(bundleRoot: string, deps: FilesystemTrustDeps): string | null {
  for (let dir = dirname(bundleRoot); ; dir = dirname(dir)) {
    const s = deps.stat(dir);
    if (!s || !s.isDirectory || s.isSymbolicLink) return `${dir} is not a regular ancestor directory`;
    if (s.uid !== 0 && s.uid !== deps.uid) return `${dir} is owned by another user`;
    // A trusted sticky parent protects the already-checked child from replacement.
    // Root-owned admin-group install containers are privileged OS-controlled paths;
    // resolve that group from the local directory service rather than assuming a GID.
    const sticky = (s.mode & 0o1000) !== 0;
    const privileged = s.uid === 0 && (s.mode & 0o002) === 0
      && deps.adminGroupId !== undefined && s.gid === deps.adminGroupId;
    if ((s.mode & 0o022) !== 0 && !sticky && !privileged) return `${dir} is writable by group or others`;
    if (dirname(dir) === dir) return null;
  }
}

/** Shared filesystem policy; the callers separately verify both code signatures. */
export function untrustedBundleFilesystemReason(
  bundleRoot: string,
  binary: string | undefined = undefined,
  deps: FilesystemTrustDeps,
): string | null {
  const label = binary === undefined ? "app executable" : "app-server binary";
  binary ??= join(bundleRoot, "Contents", "MacOS", "ChatGPT");
  const inside = relative(bundleRoot, binary);
  if (!inside || inside.startsWith("..") || inside.startsWith(sep)) return `the ${label} is outside the bundle`;
  const fileProblem = ownedSafely(deps, binary, "file");
  if (fileProblem) return `the ${label} ${fileProblem}`;
  for (let dir = dirname(binary); ; dir = dirname(dir)) {
    const dirProblem = ownedSafely(deps, dir, "directory");
    if (dirProblem) return `${dir} ${dirProblem}`;
    if (dir === bundleRoot || dirname(dir) === dir) break;
  }
  const ancestorProblem = untrustedAncestorReason(bundleRoot, deps);
  if (ancestorProblem) return ancestorProblem;
  return null;
}

export function bundleSignatureDetailsReason(target: string, details: { status: number | null; output: string }): string | null {
  return details.status !== 0 || !new RegExp(`^TeamIdentifier=${OPENAI_TEAM_ID}$`, "m").test(details.output)
    ? `${target} is not signed by OpenAI (team ${OPENAI_TEAM_ID})` : null;
}

/**
 * Null when the bundle root and selected executable pass filesystem and OpenAI signature checks.
 * Restore omits the app-server binary and validates the app shell instead. Directories and the
 * binary must be owned by root or this user, non-symlink, and not group/other-writable;
 * ancestors also pass POSIX directory-entry replacement checks through the filesystem root.
 */
export function untrustedChatgptBundleReason(
  bundleRoot: string,
  binary: string | undefined = undefined,
  deps: BundleTrustDeps = defaultBundleTrustDeps(),
): string | null {
  const filesystemProblem = untrustedBundleFilesystemReason(bundleRoot, binary, deps);
  if (filesystemProblem) return filesystemProblem;
  binary ??= join(bundleRoot, "Contents", "MacOS", "ChatGPT");
  for (const target of [bundleRoot, binary]) {
    if (deps.codesign(["--verify", "--strict", target]).status !== 0) return `${target} failed code-signature verification`;
    const detailsProblem = bundleSignatureDetailsReason(target, deps.codesign(["-dv", "--verbose=2", target]));
    if (detailsProblem) return detailsProblem;
  }
  return null;
}
