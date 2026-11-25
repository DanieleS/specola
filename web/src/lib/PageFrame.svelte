<script lang="ts" module>
  /** A version's view URL: viewUrl may already carry a query (a view token). */
  export function viewSrc(viewUrl: string, v: number) {
    const u = new URL(viewUrl, location.href);
    u.searchParams.set("v", String(v));
    return u.toString();
  }
</script>

<script lang="ts">
  // The sandboxed frame showing a page, in the viewer and in a page app
  // (docs/page-apps.md): online from its view URL, offline from the copy
  // this device keeps, with the page's storage, its backend calls and pushes
  // served over the port (pagedata.ts).
  import { untrack } from "svelte";
  import type { PageMeta } from "./api";
  import { backends } from "./backends.svelte";
  import * as offline from "./offline.svelte";
  import { serveStorage, storageName, type Backend } from "./pagedata";

  let {
    id,
    meta,
    version,
    readOffline,
    bundle = false,
    reloads = 0,
    onsuperseded,
  }: {
    id: string;
    meta: PageMeta;
    /** The version to show. The caller doesn't pass one that can't be opened. */
    version: number;
    /** Show the copy kept on this device, not the server's. */
    readOffline: boolean;
    /** The version is a bundle: said when it isn't kept whole. */
    bundle?: boolean;
    /** Bumped to load the frame again when the version stays the same. */
    reloads?: number;
    /** A backend call was refused because a newer version is current. */
    onsuperseded?: () => void;
  } = $props();

  // Only the current version can have a backend that runs.
  let hasBackend = $derived(!!meta.backend && version === meta.version);
  let src = $derived(!readOffline && meta.viewUrl ? viewSrc(meta.viewUrl, version) : "");
  let offlineSrc = $state("");
  // The kept bundle's files for the page in offlineSrc, if it is one.
  let offlineFiles: offline.BundleFile[] | undefined;
  let missing = $state(false);
  let host = $state<HTMLDivElement>();

  // Offline, show the kept copy from a blob URL in the same sandbox. A
  // bundle runs from its kept files, which the frame's SDK gets over the
  // port; one not kept whole is reported missing rather than shown broken.
  $effect(() => {
    const v = version;
    offlineSrc = "";
    missing = false;
    if (!readOffline || !v) return;
    let url = "";
    let live = true;
    const kept = offline.isBundle(id, v) ? offline.bundle(id, v) : Promise.resolve(null);
    Promise.all([offline.html(id, v), kept]).then(([h, b]) => {
      if (!live) return;
      if (h === null || (offline.isBundle(id, v) && !b)) {
        missing = true;
        return;
      }
      offlineFiles = b?.files;
      if (b) h = offline.offlineBundleHTML(h, b.base);
      offlineSrc = url = URL.createObjectURL(new Blob([h], { type: "text/html" }));
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  });

  // A frame per load, made here: the page's localStorage data must be in the
  // frame's name before the frame is in the document (browsers ignore a later
  // change), and only the page first loaded in it gets to save its writes.
  $effect(() => {
    const h = host;
    const url = src || offlineSrc;
    void reloads;
    if (!h || !url) return;
    const title = untrack(() => meta.name || "page");
    const files = src ? undefined : offlineFiles;
    // Where the page's specola.fetch calls go, if it has a backend.
    const backend: Backend | undefined = untrack(() =>
      hasBackend
        ? {
            status: () => ({ enabled: backends.enabled, available: backends.available && offline.net.online }),
            version,
            offline: !src,
            onSuperseded: () => onsuperseded?.(),
          }
        : undefined,
    );
    let live = true;
    let stop = () => {};
    storageName(id).then((name) => {
      if (!live) return;
      // No allow-same-origin: the page runs on an opaque origin, matching the
      // server's CSP sandbox, so it cannot touch Specola's session or API.
      const f = document.createElement("iframe");
      f.title = title;
      f.referrerPolicy = "no-referrer";
      f.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-modals");
      f.className = "flex-1 w-full bg-white border-0";
      if (name) f.name = name;
      f.src = url;
      h.replaceChildren(f);
      if (name || files || backend) stop = serveStorage(f, id, !!name, files, backend);
    });
    return () => {
      live = false;
      stop();
    };
  });
</script>

{#if missing}
  <p class="flex-1 p-5 text-white/50">
    Version {version} isn't {bundle ? "available offline" : "kept on this device"}. It can be opened when you're back online.
  </p>
{:else if src || offlineSrc}
  <!-- The sandboxed frame showing the page goes here; see above. -->
  <div bind:this={host} class="flex flex-1 min-w-0"></div>
{/if}
