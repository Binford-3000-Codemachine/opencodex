/**
 * The read-only management surface a Remote Link Child may reach on its Home (#6957).
 *
 * Default deny: a path is readable only when it is listed here, the method is GET or HEAD, and
 * the query does not ask the Home to refresh upstream state. Everything else is refused on both
 * ends: the Child's listener and CLI refuse before sending, and the Home's link listener answers
 * 404 for any other path under the prefix. No route here returns a credential value; provider
 * and account projections report presence and masked identities only.
 */
export const LINK_MANAGEMENT_PREFIX = "/v1/link-management";
/** The Home's OpenCodex-owned Codex settings a Child applies when it syncs. */
export const LINK_CODEX_SETTINGS_PATH = `${LINK_MANAGEMENT_PREFIX}/codex-settings`;

export const LINK_MANAGEMENT_READ_PATHS: readonly string[] = [
  "/api/system/health",
  "/api/startup-health",
  "/api/providers",
  "/api/models",
  "/api/settings",
  "/api/usage",
  "/api/effort-caps",
  "/api/injection-model",
  "/api/shadow-call-settings",
  "/api/sidecar-settings",
  "/api/v2",
  "/api/provider-quotas",
  "/api/codex-auth/active",
  "/api/codex-auth/accounts",
  "/api/oauth/accounts",
  "/api/providers/keys",
  "/api/oauth/providers",
  "/api/subagent-models",
  "/api/subagent-model-fallback",
  "/api/catalog",
  "/api/system/memory",
  "/api/provider-presets",
  "/api/model-presets",
  "/api/provider-context-caps",
];
const READ_PATHS = new Set(LINK_MANAGEMENT_READ_PATHS);
/** Query keys that make a read trigger upstream work on the Home. */
const REFRESH_KEYS = ["refresh", "reload", "force"];

/** Is `method path?query` (a Home management path, without the link prefix) readable over the link? */
export function linkManagementReadAllowed(method: string, pathname: string, search: URLSearchParams | string = ""): boolean {
  const upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") return false;
  if (!READ_PATHS.has(pathname)) return false;
  const query = typeof search === "string" ? new URLSearchParams(search) : search;
  return !REFRESH_KEYS.some(key => query.has(key));
}

/** The Home management URL a prefixed link request names, or null when it names none. */
export function linkManagementTarget(url: URL): URL | null {
  if (!url.pathname.startsWith(`${LINK_MANAGEMENT_PREFIX}/api/`)) return null;
  const target = new URL(url.href);
  target.pathname = url.pathname.slice(LINK_MANAGEMENT_PREFIX.length);
  return target;
}

/** Home side: may the hub-link listener dispatch this request to the link management handler? */
export function linkManagementRouteAllowed(url: URL, req: Request): boolean {
  if (req.headers.has("upgrade")) return false;
  if (url.pathname === LINK_CODEX_SETTINGS_PATH) return req.method === "GET" && url.search === "";
  const target = linkManagementTarget(url);
  return target !== null && linkManagementReadAllowed(req.method, target.pathname, target.searchParams);
}

export function isLinkManagementPath(pathname: string): boolean {
  return pathname === LINK_MANAGEMENT_PREFIX || pathname.startsWith(`${LINK_MANAGEMENT_PREFIX}/`);
}

/**
 * The one refusal every management surface on a link Child uses: the dashboard relay, the CLI,
 * and the Child's listener. It names the Home and the link and never suggests a relay transport.
 * `homePhrase` is "Home <name>" or "its Home" when the Child does not know the Home's name.
 */
export function linkChildManagementRefusal(homePhrase: string, linkId: string, operation = "This management command"): string {
  return `This machine is a Remote Link Child managed by ${homePhrase} (link ${linkId}). `
    + `${operation} runs on the Home, not on this Child: use the Home's dashboard or run the command there. No request was sent.`;
}
