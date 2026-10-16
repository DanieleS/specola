export type TreeItem = {
  id: string;
  kind: "folder" | "page";
  name: string;
  slug: string;
  version?: number;
  updatedAt: string;
};

export type PageMeta = {
  id: string;
  name: string;
  slug: string;
  folderId: string | null;
  version: number;
  updatedAt: string;
};

export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
  }
}

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
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : (res.text() as unknown)) as Promise<T>;
}

export const api = {
  me: () => req<{ sub: string; email: string }>("GET", "/api/me"),
  tree: (parent?: string | null) =>
    req<TreeItem[]>("GET", "/api/tree" + (parent ? `?parent=${encodeURIComponent(parent)}` : "")),
  createFolder: (name: string, parentId: string | null) =>
    req<{ id: string }>("POST", "/api/folders", { name, parentId }),
  createPage: (name: string, html: string, folderId: string | null) =>
    req<{ id: string; version: number }>("POST", "/api/pages", { name, html, folderId }),
  pageMeta: (id: string) => req<PageMeta>("GET", `/api/pages/${id}`),
};
