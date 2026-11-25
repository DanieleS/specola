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

/** The public link a request came through (ctx.role is then "public"). */
export interface LinkInfo {
  readonly id: string;
  readonly label: string;
}

/**
 * An anonymous visitor of a public link: one per link and device, kept in a
 * cookie, made on its first write or backend call.
 */
export interface VisitorInfo {
  /** Stable for this visitor on this link. */
  readonly id: string;
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
  /**
   * The public link's anonymous visitor, when ctx.role is "public" and the
   * visitor has one (it may not, past the link's cap on visitors).
   */
  readonly visitor: VisitorInfo | null;
  readonly page: PageInfo;
  /** SQLite shared by everyone on this page, opened on first use (WAL). */
  readonly db: DatabaseSync;
  /**
   * SQLite private to ctx.user, or to ctx.visitor on a public link (at most
   * 16 MiB), opened on first use; null when there is neither.
   */
  readonly userDb: DatabaseSync | null;
  /** The page's file store. */
  readonly files: FileStore;
  /**
   * The secrets the manifest declares that the page's owner has set, by
   * name; a secret not set yet is missing. Values are set in Specola's UI
   * only, never by code or agents. Under `vite dev` they come from .env and
   * the environment (declared names only).
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Pushes data to the pages open on the page that subscribed to topic
   * (specola.subscribe in the app); with `to` (a user's sub), only to that
   * user's. topic is 1 to 128 of [A-Za-z0-9_.:/-]; data must be
   * JSON-serialisable, at most 7 KiB serialised; otherwise it throws a
   * TypeError. Fire and forget, best effort: no delivery confirmation, no
   * replay for pages that were not listening, and at most 50 pushes a second
   * per page (the rest are dropped, with a line in the backend log).
   * Public-link visitors only get topics in the manifest's topics.public,
   * and never targeted pushes.
   */
  publish(topic: string, data: unknown, opts?: { to?: string }): void;
  /** Keeps the worker alive, after the response, until p settles. */
  waitUntil(p: Promise<unknown>): void;
  /** console: lines go to the page's backend log. */
  readonly log: Console;
}

/**
 * A scheduled job firing (cron in the manifest). It runs with
 * ctx.role "cron", no user (ctx.user and ctx.userDb are null) and at most
 * 5 minutes. Missed runs are not caught up.
 */
export interface ScheduledEvent {
  /** The job's name, as declared in the manifest's cron. */
  readonly name: string;
  /** The slot it fires for, in milliseconds since the epoch (UTC schedules). */
  readonly scheduledTime: number;
}

/**
 * The server entry's default export. request.url is
 * `https://page.invalid/<path>?<query>`: the path the page asked for, on a
 * placeholder origin. Every request is untrusted input: whoever can open the
 * page can send anything; decide with ctx.user and ctx.role.
 */
export interface Handler {
  /** Answers specola.fetch calls (and, for the manifest's public routes, public-link visitors). */
  fetch?(request: Request, ctx: Ctx): Response | Promise<Response>;
  /**
   * Runs the manifest's cron jobs, all of them: tell them apart by
   * event.name. A job without this handler is recorded as "no-handler".
   */
  scheduled?(event: ScheduledEvent, ctx: Ctx): void | Promise<void>;
}
