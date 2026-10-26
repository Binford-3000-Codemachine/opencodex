import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";

/**
 * Codex desktop-app locations shared by runtime discovery and the exec
 * boundary. Kept in one small module so runtime.ts (selection) and
 * exec-boundary.ts (trust gate) classify the same canonical paths without a
 * module cycle.
 */
export interface MacCodexAppDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Canonicalizer; the exec boundary injects its own so both classify identically. */
  realpath?: (path: string) => string | null;
}

/** Conventional Codex desktop bundles, ordered system before user. */
export function macCodexAppBundles(deps: MacCodexAppDeps): string[] {
  const env = deps.env ?? process.env;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return ["/Applications/ChatGPT.app", posix.join(home, "Applications/ChatGPT.app")];
}

export function macCodexAppCommands(deps: MacCodexAppDeps): string[] {
  return macCodexAppBundles(deps).flatMap(bundle => [
    bundle + "/Contents/Resources/codex-cli/bin/codex", bundle + "/Contents/Resources/codex",
  ]);
}

export function realpathOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * Classify any path inside either bundle, including backing executables, by normalized and
 * canonical forms with a segment boundary: a symlinked HOME (or /tmp -> /private/tmp) must not
 * let a canonical bundle path skip the identity check or the handover exclusion.
 */
export function macCodexAppBundleFor(command: string, deps: MacCodexAppDeps): string | undefined {
  if ((deps.platform ?? process.platform) !== "darwin" || !posix.isAbsolute(command)) return undefined;
  const realpath = deps.realpath ?? realpathOrNull;
  const forms = [posix.normalize(command), realpath(command)].filter((form): form is string => Boolean(form));
  return macCodexAppBundles(deps).find(bundle => {
    const roots = [posix.normalize(bundle), realpath(bundle)].filter((root): root is string => Boolean(root));
    return forms.some(form => roots.some(root => form.startsWith(root + "/")));
  });
}
