import type { Snapshot, SnapshotKind } from "./api";

// How backend snapshots read (docs/page-backends.md, "Snapshots").

/** As many manual snapshots as a page keeps; past it, taking one is refused. */
export const MAX_MANUAL_SNAPSHOTS = 10;

const kinds: Record<SnapshotKind, string> = {
  version: "Version",
  daily: "Daily",
  manual: "Manual",
  "before-restore": "Before a restore",
  "before-import": "Before an import",
  "before-wipe": "Before a reset",
};

/** Why the snapshot was taken, in a few words. */
export const kindLabel = (k: SnapshotKind | string) => kinds[k as SnapshotKind] ?? k;

/** The snapshot in a phrase: its label, the version that left it, or why it was taken. */
export function describeSnapshot(s: Snapshot): string {
  if (s.kind === "manual" && s.label) return `“${s.label}”`;
  if (s.kind === "version" && s.version) return `the data as v${s.version} left it`;
  return `“${kindLabel(s.kind)}”`;
}

/** The newest snapshot of the data version v left, if any: what restoring v can bring back. */
export function versionSnapshot(snapshots: Snapshot[], v: number): Snapshot | undefined {
  return snapshots
    .filter((s) => s.kind === "version" && s.version === v)
    .reduce<Snapshot | undefined>((a, s) => (!a || Date.parse(s.createdAt) > Date.parse(a.createdAt) ? s : a), undefined);
}
