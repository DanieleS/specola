// Types for a page backend: the server entry given to specola({ server }),
// whose default export Specola's runner calls (docs/page-backends.md,
// "Handler contract"). In server/index.ts:
//
//   import type { Handler } from '@specola/vite-plugin/server';
//   export default { async fetch(request, ctx) { … } } satisfies Handler;
//
// ctx.db and ctx.userDb are node:sqlite databases: their types come from
// @types/node (22.13 or newer) in the project.

import type { DatabaseSync } from 'node:sqlite';

/** The signed-in user a request comes from. */
export interface User {
  /** A stable, opaque id: key per-user data by it, not by email. */
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Who is calling: the page's owner, an editor or a viewer; "public" for an
 * anonymous visitor through a public link; "cron" for a scheduled job.
 */
export type Role = 'owner' | 'editor' | 'viewer' | 'public' | 'cron';

/** The page the backend belongs to, and the version running. */
export interface PageInfo {
  readonly id: string;
  readonly version: number;
  readonly title: string;
}

/** The public link a request came through. */
export interface LinkInfo {
  readonly id: string;
  readonly label: string;
}

/** A file of the page's store, as listed. */
export interface FileInfo {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  /** RFC 3339. */
  readonly updatedAt: string;
}

/** A stored file, as read. */
export interface StoredFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly contentType: string;
}

/**
 * The page's key/value file store, on disk next to its databases. Keys are
 * like bundle paths ("uploads/2024/photo.jpg": no leading "/", no empty,
 * "." or ".." segments, no "\", "?", "#" or "%").
 */
export interface FileStore {
  /**
   * Stores body under key, replacing what was there. body is anything
   * `new Response(body)` accepts: a string, bytes, a Blob or File (whose
   * type is the default content type), a ReadableStream (request.body)…
   */
  put(key: string, body: NonNullable<ConstructorParameters<typeof Response>[0]>, opts?: { contentType?: string }): Promise<{ key: string; size: number; contentType: string }>;
  /** The file, or null when key is not stored. */
  get(key: string): Promise<StoredFile | null>;
  /** Removes key; resolves to whether it was stored. */
  delete(key: string): Promise<boolean>;
  /** The keys starting with prefix (all by default), sorted. */
  list(prefix?: string): Promise<FileInfo[]>;
}

/** What a handler gets with each call. */
export interface Ctx {
  /** null for an anonymous public-link visitor and for scheduled jobs. */
  readonly user: User | null;
  readonly role: Role;
  /** The public link used, if any. */
  readonly link: LinkInfo | null;
  readonly page: PageInfo;
  /** SQLite shared by everyone on this page, opened on first use (WAL). */
  readonly db: DatabaseSync;
  /** SQLite private to ctx.user, opened on first use; null when there is no user. */
  readonly userDb: DatabaseSync | null;
  /** The page's file store. */
  readonly files: FileStore;
  /** The secrets the manifest declares, by name; a secret not set yet is missing. */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Pushes data to the pages open on topic (to one user with `to`).
   * Not available yet: it logs a warning and drops the event.
   */
  publish(topic: string, data: unknown, opts?: { to?: string }): void;
  /** Keeps the worker alive, after the response, until p settles. */
  waitUntil(p: Promise<unknown>): void;
  /** console: lines go to the page's backend log. */
  readonly log: Console;
}

/** A scheduled job firing (cron in the manifest). */
export interface ScheduledEvent {
  readonly name: string;
  /** Milliseconds since the epoch. */
  readonly scheduledTime: number;
}

/**
 * The server entry's default export. request.url is
 * `https://page.invalid/<path>?<query>`: the path the page asked for, on a
 * placeholder origin. Every request is untrusted input: whoever can open the
 * page can send anything; decide with ctx.user and ctx.role.
 */
export interface Handler {
  fetch?(request: Request, ctx: Ctx): Response | Promise<Response>;
  scheduled?(event: ScheduledEvent, ctx: Ctx): void | Promise<void>;
}
