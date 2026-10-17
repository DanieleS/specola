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
  /** Where to load the rendered page from; may be on a separate origin. */
  viewUrl: string;
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
};

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
  restoreVersion: (id: string, from: number) =>
    req<{ version: number }>("POST", `/api/pages/${id}/versions`, { restoreFrom: from }),
  pageData: (id: string) => req<Record<string, string>>("GET", `/api/pages/${id}/data`),
  updatePageData: (id: string, change: { set?: Record<string, string>; remove?: string[] }) =>
    req<void>("PATCH", `/api/pages/${id}/data`, change),
  clearPageData: (id: string) => req<void>("DELETE", `/api/pages/${id}/data`),
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
};
