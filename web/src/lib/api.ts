export type Role = "owner" | "editor" | "viewer";

export type TreeItem = {
  id: string;
  kind: "folder" | "page";
  name: string;
  slug: string;
  version?: number;
  updatedAt: string;
  role: Role;
  shared: boolean;
  /** Starred by the caller. Absent on search results. */
  favorite?: boolean;
  /** A folder with conventions for agents set on it. */
  conventions?: boolean;
  /**
   * Archived list only: when this page's backend data will be purged (RFC
   * 3339), set from a week ahead (docs/page-backends.md, "Data lifecycle").
   * On a folder, the first purge among the pages inside it.
   */
  backendPurgeAt?: string;
};

export type PageMeta = {
  id: string;
  name: string;
  slug: string;
  folderId: string | null;
  version: number;
  updatedAt: string;
  role: Role;
  shared: boolean;
  favorite: boolean;
  /** Has a public link that hasn't expired. Only ever set for the owner. */
  public: boolean;
  /** Where to load the rendered page from; may be on a separate origin. */
  viewUrl: string;
  /** Where the page is installed as an app (docs/page-apps.md). */
  appUrl?: string;
  /** The current version is an SPA bundle (docs/spa-bundles.md). */
  bundle?: boolean;
  /** The current version has a backend (docs/page-backends.md): only it can be opened. */
  backend?: boolean;
  /**
   * The runner holds data for this page (its backend has been called), even
   * if the current version has no backend: the Backend panel shows it.
   */
  backendData?: boolean;
  /** When that data will be purged, for a dormant page, from a week ahead (RFC 3339). */
  backendPurgeAt?: string;
  /** Secrets the current version declares with no value set (owners and editors only). */
  backendSecretsMissing?: string[];
  /** Set when this is a copy kept by the service worker, read offline. */
  offline?: boolean;
};

export type Share = {
  sub: string;
  email?: string;
  name?: string;
  role: "viewer" | "editor";
  createdAt: string;
};

/** A link that shows a page to anyone holding it, without signing in. */
export type PublicLink = {
  id: string;
  /** Pinned to this version; follows the current one when absent. */
  version?: number;
  label?: string;
  createdBy?: string;
  createdAt: string;
  expiresAt?: string;
  expired: boolean;
  lastUsedAt?: string;
  views: number;
};

export type SearchResult = TreeItem & {
  /** Safe HTML from the server: escaped text, matches wrapped in <mark>. */
  snippet: string;
};

export type ItemKind = "page" | "folder";

export type VersionInfo = {
  version: number;
  sizeBytes: number;
  createdAt: string;
  editedBy?: string;
  restoredFrom?: number;
  /** What changed, as written by whoever published it. */
  note?: string;
  /** This version is an SPA bundle. */
  bundle?: boolean;
  /** This version has a backend. */
  backend?: boolean;
  /**
   * It can be opened: it is the current version, or neither it nor the
   * current one has a backend. The others are history (and can be restored).
   */
  viewable?: boolean;
};

/** Whether page backends are configured on this instance, and reachable now. */
export type BackendsState = { enabled: boolean; available: boolean };

export type Me = { sub: string; email: string; backends?: BackendsState; offline?: boolean };

/** A line of a page's backend log (console output, errors, crashes). */
export type BackendLogLine = {
  seq: number;
  /** RFC 3339. */
  time: string;
  level: "log" | "info" | "warn" | "error";
  text: string;
  /** Names the line in an error the page got ({"error":"backend-error","ref"}). */
  ref?: string;
};

/** Why a backend snapshot was taken (docs/page-backends.md, "Snapshots"). */
export type SnapshotKind = "version" | "daily" | "manual" | "before-restore" | "before-import" | "before-wipe";

/** A copy of all of a page's backend data, which an owner can restore. */
export type Snapshot = {
  id: string;
  kind: SnapshotKind;
  /** Manual snapshots: what the owner called it. */
  label?: string;
  /** Version snapshots: the version that was leaving, whose data this is. */
  version?: number;
  /** RFC 3339. */
  createdAt: string;
  sizeBytes: number;
};

/** A page's backend data: how much room it takes, and its snapshots, newest first. */
export type BackendData = {
  usage: { pageBytes: number; pageLimit: number; snapshotBytes: number; snapshotLimit: number };
  snapshots: Snapshot[];
};

/** A bundle version's files, other than index.html. */
export type VersionFiles = {
  bundle: boolean;
  /** Where the files are served, ending in "/"; "" for a plain version. */
  base: string;
  files: { path: string; size: number; contentType: string; sha256: string }[];
};

/** A link to publish a bundle with, valid 30 minutes. */
export type BundleUpload = {
  uploadUrl: string;
  expiresAt: string;
  /** The command that builds and publishes the app, run in its project. */
  command: string;
  /** The command that installs this instance's Vite plugin. */
  pluginInstall: string;
};

/** A page agents take colours, typography and components from. */
export type StyleRef = { id: string; name: string; version: number; folderId: string | null };

/** How agents publish for this user: they choose, or always a bundle. */
export type PublishMode = "auto" | "bundle";

/** The user's defaults for agents publishing through the MCP. */
export type Preferences = {
  mode: PublishMode;
  text: string;
  /** The stored reference; styleRef describes it, null if the page can no longer be seen. */
  styleRefId: string | null;
  styleRef: StyleRef | null;
  updatedAt?: string;
};

/** The conventions set on one folder. */
export type Conventions = {
  folderId: string;
  folderName: string;
  /** From the top of the folder's tree; folders the reader can't see are "…". */
  path: string;
  text: string;
  styleRefId: string | null;
  styleRef: StyleRef | null;
  /** Who wrote them, by name and email. */
  updatedBy: string;
  updatedAt: string;
};

export type FolderConventions = {
  /** Set on this folder. */
  own: Conventions | null;
  /** In force here: own, or inherited from the nearest folder above. */
  effective: Conventions | null;
  /** The caller owns the folder. */
  canEdit: boolean;
};

/** Longest text of preferences or conventions, in characters. */
export const MAX_PREFERENCE_CHARS = 4000;

const aclPath = (kind: ItemKind, id: string) => `/api/${kind}s/${id}/acl`;

export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The X-Specola-Error code, when the server named one. */
    readonly code = "",
  ) {
    super(message);
  }

  /** The message of a JSON error ({"error","message"}), else the body as it came. */
  get detail(): string {
    try {
      const j = JSON.parse(this.message);
      if (j && typeof j.message === "string") return j.message;
    } catch {
      // Plain text.
    }
    return this.message;
  }
}

// What the backend data routes' codes mean to the person who clicked
// (docs/page-backends.md, "Wire formats for data"). The others say the
// server's own message.
const backendCodes: Record<string, string> = {
  "backend-disabled": "Page backends are not enabled on this instance.",
  "backend-unavailable": "The backend runner is not available right now. Try again in a moment.",
  "backend-timeout": "The backend runner took too long to answer. Try again in a moment.",
  "backend-crashed": "The backend runner failed before answering. Try again in a moment.",
  "too-many-snapshots": "This page already has 10 manual snapshots: delete one to take another.",
  "snapshot-quota": "This page's snapshots are over their quota: delete manual snapshots to make room.",
  "not-manual": "Only manual snapshots can be deleted; the automatic ones go by themselves.",
  "no-data": "You have no data on this page.",
  "body-too-large": "The file is too large: an import can be at most 1 GiB.",
};

/** A readable sentence for an error of a backend data call. */
export function backendErrorMessage(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.code === "bad-import") return `This file can't be imported: ${e.detail.trim().replace(/[.]?$/, ".")}`;
    if (backendCodes[e.code]) return backendCodes[e.code];
    // forbidden says who may ("only the page's owners can …"), and the rest
    // say what is wrong: as a sentence.
    return sentence(e.detail) || `The server answered ${e.status}.`;
  }
  if (e instanceof Unauthorized) return "You're signed out. Sign in again and retry.";
  return e instanceof Error ? e.message : String(e);
}

const sentence = (t: string) => {
  t = t.trim();
  return t && t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
};

/** Bytes in the units people read: 1.5 MB, 2 GB. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Set by the service worker on an API response served from its cache. */
export const OFFLINE_HEADER = "X-Specola-Offline";

// Fired on any 401 so the app can swap to the login screen. We never redirect
// automatically: the user starts the login from an explicit button, so a
// failing login cannot turn into a redirect loop.
export const UNAUTHORIZED_EVENT = "specola:unauthorized";

function unauthorized(): never {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  throw new Unauthorized();
}

async function fail(res: Response): Promise<never> {
  if (res.status === 401) unauthorized();
  throw new HttpError(res.status, (await res.text()) || res.statusText, res.headers.get("X-Specola-Error") ?? "");
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) await fail(res);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return (await res.text()) as T;
  const data = await res.json();
  if (res.headers.has(OFFLINE_HEADER) && data && typeof data === "object" && !Array.isArray(data)) data.offline = true;
  return data as T;
}

// An upload with progress, which fetch can't report: XMLHttpRequest can.
// The answer is handled as req() handles one.
function upload<T>(url: string, body: Blob, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.withCredentials = true;
    x.setRequestHeader("Content-Type", "application/zip");
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onerror = () => reject(new Error("The upload failed: check the connection and try again."));
    x.onabort = () => reject(new Error("The upload was cancelled."));
    x.onload = () => {
      const res = new Response(x.status === 204 ? null : x.responseText, {
        status: x.status,
        statusText: x.statusText,
        headers: { "X-Specola-Error": x.getResponseHeader("X-Specola-Error") ?? "" },
      });
      if (!res.ok) {
        fail(res).catch(reject);
        return;
      }
      try {
        resolve(JSON.parse(x.responseText) as T);
      } catch {
        resolve(x.responseText as T);
      }
    };
    x.send(body);
  });
}

export const api = {
  me: () => req<Me>("GET", "/api/me"),
  tree: (parent?: string | null) =>
    req<TreeItem[]>("GET", "/api/tree" + (parent ? `?parent=${encodeURIComponent(parent)}` : "")),
  createFolder: (name: string, parentId: string | null) =>
    req<{ id: string }>("POST", "/api/folders", { name, parentId }),
  createPage: (name: string, html: string, folderId: string | null, note: string) =>
    req<{ id: string; version: number }>("POST", "/api/pages", { name, html, folderId, note }),
  pageMeta: (id: string) => req<PageMeta>("GET", `/api/pages/${id}`),
  shared: () => req<TreeItem[]>("GET", "/api/shared"),
  archived: () => req<TreeItem[]>("GET", "/api/archived"),
  favorites: () => req<TreeItem[]>("GET", "/api/favorites"),
  setFavorite: (kind: ItemKind, id: string, on: boolean) =>
    req<void>(on ? "PUT" : "DELETE", `/api/${kind}s/${id}/favorite`),
  versions: (id: string) => req<VersionInfo[]>("GET", `/api/pages/${id}/versions`),
  versionFiles: (id: string, v: number) => req<VersionFiles>("GET", `/api/pages/${id}/versions/${v}/files`),
  /** A link to publish a bundle: a new page in folderId, or a new version of page id. */
  bundleUpload: (
    r: { kind: "new"; title: string; folderId: string | null; note?: string } | { kind: "version"; id: string; note?: string },
  ) => req<BundleUpload>("POST", "/api/bundle-uploads", r),
  restoreVersion: (id: string, from: number) =>
    req<{ version: number }>("POST", `/api/pages/${id}/versions`, { restoreFrom: from }),
  /** The backend log lines of page id after since (owners and editors). */
  backendLogs: (id: string, since = 0) =>
    req<{ lines: BackendLogLine[] }>("GET", `/api/pages/${id}/backend/logs?since=${since}`),
  /** Page id's backend data usage and snapshots (owners and editors). */
  backendData: (id: string) => req<BackendData>("GET", `/api/pages/${id}/backend/data`),
  /** A manual snapshot (owners), labelled with 1 to 100 characters. */
  createSnapshot: (id: string, label: string) =>
    req<Snapshot>("POST", `/api/pages/${id}/backend/snapshots`, { label }),
  /** Deletes a manual snapshot (owners). */
  deleteSnapshot: (id: string, sid: string) =>
    req<void>("DELETE", `/api/pages/${id}/backend/snapshots/${encodeURIComponent(sid)}`),
  /** Replaces all of the page's data with a snapshot (owners); before is the one taken first. */
  restoreSnapshot: (id: string, sid: string) =>
    req<{ before: Snapshot }>("POST", `/api/pages/${id}/backend/snapshots/${encodeURIComponent(sid)}/restore`),
  /** Where the export zip downloads from (owners and editors); it can be large, so it isn't read here. */
  backendExportUrl: (id: string) => `/api/pages/${id}/backend/export`,
  /** Replaces the page's shared data and files with a zip in the export format (owners). */
  importBackend: (id: string, zip: Blob, onProgress?: (fraction: number) => void) =>
    upload<{ before: Snapshot }>(`/api/pages/${id}/backend/import`, zip, onProgress),
  /** Resets the shared data and files, or every user's own data (owners). */
  wipeBackend: (id: string, scope: "shared" | "users") =>
    req<{ before: Snapshot }>("POST", `/api/pages/${id}/backend/wipe`, { scope }),
  /** The caller's own database on the page; HttpError no-data when they have none. */
  myData: async (id: string) => {
    const res = await fetch(`/api/pages/${id}/backend/my-data`, { credentials: "same-origin" });
    if (!res.ok) await fail(res);
    return res.blob();
  },
  /** Deletes the caller's own database on the page (fine when there is none). */
  deleteMyData: (id: string) => req<void>("DELETE", `/api/pages/${id}/backend/my-data`),
  /** The user's localStorage for page id; written by pagedata.ts. */
  pageData: (id: string) => req<Record<string, string>>("GET", `/api/pages/${id}/data`),
  rename: (kind: ItemKind, id: string, name: string) => req<void>("PATCH", `/api/${kind}s/${id}`, { name }),
  move: (kind: ItemKind, id: string, parentId: string | null) =>
    req<void>("PATCH", `/api/${kind}s/${id}`, { parentId }),
  archive: (kind: ItemKind, id: string) => req<void>("POST", `/api/${kind}s/${id}/archive`),
  unarchive: (kind: ItemKind, id: string) => req<void>("POST", `/api/${kind}s/${id}/unarchive`),
  search: (q: string) => req<SearchResult[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  shares: (kind: ItemKind, id: string) => req<Share[]>("GET", aclPath(kind, id)),
  share: (kind: ItemKind, id: string, email: string, role: Share["role"]) =>
    req<void>("PUT", aclPath(kind, id), { email, role }),
  setShareRole: (kind: ItemKind, id: string, sub: string, role: Share["role"]) =>
    req<void>("PUT", aclPath(kind, id), { sub, role }),
  unshare: (kind: ItemKind, id: string, sub: string) =>
    req<void>("DELETE", `${aclPath(kind, id)}?sub=${encodeURIComponent(sub)}`),
  publicLinks: (id: string) => req<PublicLink[]>("GET", `/api/pages/${id}/links`),
  /** The returned url is the only time the link can be had. */
  createPublicLink: (id: string, opts: { label?: string; version?: number; expiresInDays?: number }) =>
    req<PublicLink & { url: string }>("POST", `/api/pages/${id}/links`, opts),
  revokePublicLink: (id: string, link: string) => req<void>("DELETE", `/api/pages/${id}/links/${link}`),
  preferences: () => req<Preferences>("GET", "/api/me/preferences"),
  setPreferences: (p: { mode: PublishMode; text: string; styleRefId: string | null }) =>
    req<Preferences>("PUT", "/api/me/preferences", p),
  folderConventions: (id: string) => req<FolderConventions>("GET", `/api/folders/${id}/conventions`),
  /** Empty text and no reference remove them. */
  setFolderConventions: (id: string, text: string, styleRefId: string | null) =>
    req<FolderConventions>("PUT", `/api/folders/${id}/conventions`, { text, styleRefId }),
  deleteFolderConventions: (id: string) => req<FolderConventions>("DELETE", `/api/folders/${id}/conventions`),
};

// --- secrets & cron (web-A) ---
// Page secrets and scheduled jobs (docs/page-backends.md, "Wire formats for
// steps 3–7"), for the Secrets and Jobs tabs of the Backend panel.

/**
 * A secret's name and state: never its value, which nobody can read back.
 * declared: the current version names it; set: it has a value.
 */
export type SecretInfo = {
  name: string;
  declared: boolean;
  set: boolean;
  /** RFC 3339, when set. */
  updatedAt?: string;
  /** Who set it last. */
  updatedBy?: string;
};

/** What a secret's name must look like, as the manifest and the server check it. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Longest secret value, in UTF-8 bytes. */
export const MAX_SECRET_BYTES = 8 << 10;

/** How a scheduled job's last run ended ("unavailable": the runner couldn't be reached; "skipped": not run). */
export type CronStatus = "ok" | "no-handler" | "error" | "timeout" | "unavailable" | "skipped";

/** A scheduled job the current version declares, and how it last ran. */
export type CronJob = {
  name: string;
  /** Five cron fields, UTC. */
  schedule: string;
  /** RFC 3339; null while none is due (the page is archived, say). */
  nextRunAt: string | null;
  lastRunAt?: string;
  lastStatus?: CronStatus | string;
  /** The message and the log ref of a failed run, "message (ref r…)". */
  lastError?: string;
  lastDurationMs?: number;
};

/** The page meta's backendSecretsMissing (owners and editors): declared names with no value. */
export function secretsMissing(meta: PageMeta | null | undefined): string[] {
  const m = meta?.backendSecretsMissing;
  return Array.isArray(m) ? m : [];
}

export const secretsApi = {
  /** Names declared by the current version plus any set (owners and editors). */
  list: (id: string) => req<{ secrets: SecretInfo[] | null }>("GET", `/api/pages/${id}/secrets`),
  /** Sets or replaces a value (owners). */
  set: (id: string, name: string, value: string) =>
    req<void>("PUT", `/api/pages/${id}/secrets/${encodeURIComponent(name)}`, { value }),
  /** Removes a value (owners); fine when there is none. */
  remove: (id: string, name: string) => req<void>("DELETE", `/api/pages/${id}/secrets/${encodeURIComponent(name)}`),
  /** The current version's scheduled jobs (owners and editors). */
  cron: (id: string) => req<{ jobs: CronJob[] | null }>("GET", `/api/pages/${id}/backend/cron`),
};

// --- push (sdk-B) ---
// A page backend's pushes (docs/page-backends.md, "Realtime push"): the data
// of each `event: message` on GET /api/pages/{id}/events, relayed to the frame
// as {op:"event", topic, data} by pagedata.ts.

/** One push, as the event stream sends it: what ctx.publish(topic, data) published. */
export type PushMessage = { topic: string; data: unknown };
