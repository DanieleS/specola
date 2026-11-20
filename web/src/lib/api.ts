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
  /** The current version is an SPA bundle (docs/spa-bundles.md). */
  bundle?: boolean;
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
  ) {
    super(message);
  }
}

/** Set by the service worker on an API response served from its cache. */
export const OFFLINE_HEADER = "X-Specola-Offline";

// Fired on any 401 so the app can swap to the login screen. We never redirect
// automatically: the user starts the login from an explicit button, so a
// failing login cannot turn into a redirect loop.
export const UNAUTHORIZED_EVENT = "specola:unauthorized";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Unauthorized();
  }
  if (!res.ok) throw new HttpError(res.status, (await res.text()) || res.statusText);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return (await res.text()) as T;
  const data = await res.json();
  if (res.headers.has(OFFLINE_HEADER) && data && typeof data === "object" && !Array.isArray(data)) data.offline = true;
  return data as T;
}

export const api = {
  me: () => req<{ sub: string; email: string; offline?: boolean }>("GET", "/api/me"),
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
