<script lang="ts">
  import { untrack } from "svelte";
  import { api, Unauthorized, type PageMeta, type VersionInfo } from "./api";
  import BackendLog from "./BackendLog.svelte";
  import { backends, refreshBackends } from "./backends.svelte";
  import * as offline from "./offline.svelte";
  import { serveStorage, storageName, type Backend } from "./pagedata";
  import ShareDialog from "./ShareDialog.svelte";

  let { id }: { id: string } = $props();

  let meta = $state<PageMeta | null>(null);
  let error = $state("");
  let sharing = $state(false);
  // The side panel open, if any.
  let panel = $state<"history" | "log" | null>(null);
  let historyOpen = $derived(panel === "history");
  let versions = $state<VersionInfo[]>([]);
  let viewing = $state<number | null>(null); // an older version, or null for current
  let busy = $state(false);
  let copied = $state(false);
  // A backend call was refused because a newer version is current.
  let superseded = $state(false);
  // Bumped to load the frame again when the version shown stays the same.
  let reloads = $state(0);

  let kept = $derived(offline.index.pages[id]);
  // Without the server, show the copy this device keeps: the version asked
  // for, else the current one if kept, else the latest kept.
  let readOffline = $derived(!!meta && (meta.offline || !offline.net.online));
  let shown = $derived(
    viewing ??
      (readOffline && kept && meta && !kept.versions.includes(meta.version) ? kept.versions.at(-1) : meta?.version),
  );
  // A page with a backend (docs/page-backends.md, "Versions") can only be
  // opened at its current version: an older one is history, shown as a
  // notice rather than loaded (the server would answer 410).
  let closed = $derived(!!shown && isClosed(shown));
  // Only the current version can have a backend that runs.
  let hasBackend = $derived(!!meta?.backend && shown === meta.version);
  let src = $derived(meta && shown && !readOffline && !closed ? withVersion(meta.viewUrl, shown) : "");
  let offlineSrc = $state("");
  // The kept bundle's files for the page in offlineSrc, if it is one.
  let offlineFiles: offline.BundleFile[] | undefined;
  let missing = $state(false);
  let saving = $state(false);
  let host = $state<HTMLDivElement>();

  // viewUrl may already carry a query (a view token), so add v properly.
  function withVersion(viewUrl: string, v: number) {
    const u = new URL(viewUrl, location.href);
    u.searchParams.set("v", String(v));
    return u.toString();
  }
  let canEdit = $derived(meta?.role === "owner" || meta?.role === "editor");
  function isClosed(n: number) {
    if (!meta || n === meta.version) return false;
    const v = versions.find((x) => x.version === n);
    if (v?.viewable !== undefined) return !v.viewable;
    return !!meta.backend || !!v?.backend;
  }
  let shownBundle = $derived(
    versions.find((x) => x.version === shown)?.bundle ??
      (shown === meta?.version ? !!meta?.bundle : !!shown && offline.isBundle(id, shown)),
  );

  function load() {
    api
      .pageMeta(id)
      .then((m) => (meta = m))
      .catch((e) => {
        // Never read online, but kept: enough to show it.
        const k = offline.index.pages[id];
        if (k && !(e instanceof Unauthorized)) meta = keptMeta(k);
        else error = String(e);
      });
    if (historyOpen) loadVersions();
  }

  function keptMeta(k: offline.OfflinePage): PageMeta {
    return {
      id: k.id,
      name: k.name,
      slug: "",
      folderId: null,
      version: k.versions.at(-1)!,
      updatedAt: k.updatedAt,
      role: k.role,
      bundle: offline.isBundle(k.id, k.versions.at(-1)!),
      backend: !!k.backend,
      shared: false,
      favorite: false,
      public: false,
      viewUrl: "",
      offline: true,
    };
  }

  function loadVersions() {
    api
      .versions(id)
      .then((v) => (versions = v))
      .catch((e) => {
        if (!readOffline) error = String(e);
        // Offline with no copy of the history: list what is kept.
        else versions = (kept?.versions ?? []).slice().reverse().map((v) => ({ version: v, sizeBytes: 0, createdAt: "" }));
      });
  }

  $effect(() => {
    meta = null;
    error = "";
    viewing = null;
    superseded = false;
    load();
  });

  // Whether the runner is up changes: ask again when a page needs it.
  $effect(() => {
    if (meta?.backend && !readOffline) untrack(() => void refreshBackends());
  });

  // Online, keep what is shown for offline. Untracked: keeping updates the
  // index, which must not start this again.
  $effect(() => {
    const m = meta;
    const v = shown;
    if (!m || !v || readOffline || isClosed(v)) return;
    untrack(() => offline.keep(m, v)).catch((e) => console.warn("keep offline:", e));
  });

  // Offline, show the kept copy from a blob URL in the same sandbox. A
  // bundle runs from its kept files, which the frame's SDK gets over the
  // port; one not kept whole is reported missing rather than shown broken.
  $effect(() => {
    const v = shown;
    offlineSrc = "";
    missing = false;
    if (!readOffline || !v || closed) return;
    let url = "";
    let live = true;
    const bundle = offline.isBundle(id, v) ? offline.bundle(id, v) : Promise.resolve(null);
    Promise.all([offline.html(id, v), bundle]).then(([h, b]) => {
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
    const title = untrack(() => meta?.name ?? "page");
    const files = src ? undefined : offlineFiles;
    // Where the page's specola.fetch calls go, if it has a backend.
    const backend: Backend | undefined = untrack(() =>
      hasBackend && shown
        ? {
            status: () => ({ enabled: backends.enabled, available: backends.available && offline.net.online }),
            version: shown,
            offline: !src,
            onSuperseded: () => (superseded = true),
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

  async function togglePinned() {
    if (!meta) return;
    saving = true;
    try {
      await offline.setPinned(meta, !kept?.pinned);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function toggleHistory() {
    panel = panel === "history" ? null : "history";
    if (panel === "history") loadVersions();
  }

  // After a call was refused as superseded: the current version again, in a
  // new frame (as on any change of version), never by navigating the old one.
  async function reload() {
    superseded = false;
    const before = shown;
    try {
      meta = await api.pageMeta(id);
      viewing = null;
      if (meta.version === before) reloads++;
      if (panel === "history") loadVersions();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function restore() {
    if (viewing === null) return;
    busy = true;
    try {
      await api.restoreVersion(id, viewing);
      viewing = null;
      load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggleFavorite() {
    if (!meta) return;
    const on = !meta.favorite;
    meta.favorite = on;
    try {
      await api.setFavorite("page", id, on);
    } catch (e) {
      if (meta) meta.favorite = !on;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function copyLink() {
    const url = `${location.origin}/#/p/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      prompt("Copy this link", url);
    }
  }

  const fmt = (s: string) => new Date(s).toLocaleString();
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
  const action = "text-sm text-white/50 hover:text-white/90";
</script>

<div class="flex flex-col h-[calc(100vh-3.5rem)]">
  <!-- One row from sm up; below it, the title row and the actions wrap, so
       nothing sticks out or overlaps at phone width. -->
  <div
    data-viewer-header
    class="flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-3 gap-y-1 px-3 sm:px-5 py-2 sm:py-0 sm:h-12 border-b border-white/10 shrink-0"
  >
    <div class="flex items-center gap-2 sm:gap-3 min-w-0 w-full sm:w-auto">
      <a href="#/" class="shrink-0 text-white/50 hover:text-white/90" aria-label="Back to gallery">←</a>
      <span class="font-medium truncate min-w-0">{meta?.name ?? "…"}</span>
      {#if meta && !readOffline}
        <button
          class="shrink-0 {meta.favorite ? 'text-amber-400' : 'text-white/30 hover:text-amber-300'}"
          aria-label={meta.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={meta.favorite}
          onclick={toggleFavorite}>{meta.favorite ? "★" : "☆"}</button
        >
      {/if}
      {#if meta}<span class="shrink-0 text-xs text-white/40">v{shown}</span>{/if}
      {#if shownBundle}
        <span
          class="shrink-0 text-[10px] uppercase tracking-wide text-sky-300/80 border border-sky-300/30 rounded px-1.5 py-0.5"
          title="An app published with the Specola Vite plugin, made of several files">bundle</span
        >
      {/if}
      {#if hasBackend}
        <span
          class="shrink-0 text-[10px] uppercase tracking-wide text-emerald-300/80 border border-emerald-300/30 rounded px-1.5 py-0.5"
          title="Has a backend: server code that runs on Specola">backend</span
        >
      {/if}
      {#if readOffline}
        <span
          class="shrink-0 text-[10px] uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1.5 py-0.5"
          title="The copy kept on this device">offline copy</span
        >
      {/if}
      {#if meta && meta.role !== "owner"}
        <span class="shrink-0 text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
          >{meta.role}</span
        >
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1 sm:shrink-0">
      {#if offline.supported && meta && (!readOffline || kept?.pinned)}
        <button
          class={action}
          disabled={saving || readOffline}
          aria-pressed={!!kept?.pinned}
          title={kept?.pinned
            ? "Kept on this device and updated when Specola opens online"
            : "Keep the current version on this device"}
          onclick={togglePinned}>{saving ? "Saving…" : kept?.pinned ? "Saved offline ✓" : "Save offline"}</button
        >
      {/if}
      <button class={action} onclick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
      <button class={action} aria-pressed={historyOpen} onclick={toggleHistory}>History</button>
      {#if meta?.backend && canEdit && !readOffline && (backends.enabled || !backends.known)}
        <button class={action} aria-pressed={panel === "log"} onclick={() => (panel = panel === "log" ? null : "log")}
          >Backend log</button
        >
      {/if}
      {#if meta?.role === "owner" && !readOffline}
        <button class={action} onclick={() => (sharing = true)}>{meta.shared || meta.public ? "Shared" : "Share"}</button>
      {/if}
      {#if src}
        <a href={src} target="_blank" rel="noopener noreferrer" class={action}>Open raw ↗</a>
      {/if}
    </div>
  </div>

  {#if viewing !== null && meta}
    <div class="flex items-center justify-between gap-3 px-5 py-2 text-sm bg-amber-500/10 border-b border-amber-500/20">
      <span>Viewing version {viewing}. The current version is {meta.version}.</span>
      <div class="flex gap-3">
        {#if canEdit && !readOffline}
          <button
            disabled={busy}
            onclick={restore}
            class="px-3 py-1 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50"
            >Restore as v{meta.version + 1}</button
          >
        {/if}
        <button class="text-white/60 hover:text-white" onclick={() => (viewing = null)}>Back to current</button>
      </div>
    </div>
  {/if}

  {#if superseded}
    <div
      data-superseded
      class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 sm:px-5 py-2 text-sm bg-sky-500/10 border-b border-sky-500/20"
    >
      <span>A new version is available.</span>
      <button class="px-3 py-1 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400" onclick={reload}>Reload</button>
    </div>
  {/if}

  {#if hasBackend && !closed}
    {#if readOffline}
      <p data-backend-notice class="px-3 sm:px-5 py-1.5 text-xs text-white/50 border-b border-white/10">
        Offline: this page's backend can't be reached, so what needs it won't work until you're back online.
      </p>
    {:else if backends.known && !backends.enabled}
      <p data-backend-notice class="px-3 sm:px-5 py-1.5 text-xs text-white/50 border-b border-white/10">
        This page has a backend, but page backends are not enabled on this instance: what needs it won't work.
      </p>
    {:else if backends.known && !backends.available}
      <p data-backend-notice class="px-3 sm:px-5 py-1.5 text-xs text-white/50 border-b border-white/10">
        This page's backend is unavailable right now: what needs it may not work.
      </p>
    {/if}
  {/if}

  {#if error}
    <p class="p-5 text-red-400">{error}</p>
  {:else}
    <div class="relative flex flex-1 min-h-0">
      {#if closed && meta}
        <div data-closed-version class="flex-1 p-5 text-white/60">
          <p>This page has a backend: only its current version can be opened.</p>
          <button class="mt-2 text-amber-400 hover:text-amber-300" onclick={() => (viewing = null)}
            >Open the current version (v{meta.version})</button
          >
        </div>
      {:else if missing}
        <p class="flex-1 p-5 text-white/50">
          Version {shown} isn't {shownBundle ? "available offline" : "kept on this device"}. It can be opened when you're back
          online.
        </p>
      {:else if src || offlineSrc}
        <!-- The sandboxed frame showing the page goes here; see above. -->
        <div bind:this={host} class="flex flex-1 min-w-0"></div>
      {/if}

      {#if historyOpen}
        <!-- Beside the page from sm up; over it, at the right, below. -->
        <aside
          class="absolute inset-y-0 right-0 z-10 w-72 max-w-full bg-[#0b0d12] shadow-xl sm:static sm:shadow-none shrink-0 border-l border-white/10 overflow-y-auto"
          aria-label="Version history"
        >
          <h2 class="px-4 pt-4 pb-2 text-sm font-semibold">History</h2>
          <ul>
            {#each versions as v (v.version)}
              {@const current = v.version === meta?.version}
              <li>
                <button
                  class="w-full text-left px-4 py-2 text-sm hover:bg-white/5 {v.version === shown
                    ? 'bg-white/[0.07]'
                    : ''}"
                  onclick={() => (viewing = current ? null : v.version)}
                >
                  <div class="flex items-center gap-2">
                    <span class="font-medium">v{v.version}</span>
                    {#if current}<span class="text-[10px] uppercase text-amber-400/80">current</span>{/if}
                    {#if v.bundle}<span class="text-[10px] uppercase text-sky-300/70">bundle</span>{/if}
                    {#if v.backend}<span class="text-[10px] uppercase text-emerald-300/70">backend</span>{/if}
                    {#if isClosed(v.version)}
                      <span
                        class="text-[10px] uppercase text-white/40"
                        title="This page has a backend: only its current version can be opened. It can still be restored."
                        >not viewable</span
                      >
                    {/if}
                    {#if readOffline && kept?.versions.includes(v.version)}
                      <span class="text-[10px] uppercase text-white/40" title="Kept on this device">offline</span>
                    {/if}
                    {#if v.sizeBytes}<span class="ml-auto text-xs text-white/40">{kb(v.sizeBytes)}</span>{/if}
                  </div>
                  {#if v.note}<div class="text-white/80 mt-0.5 break-words">{v.note}</div>{/if}
                  {#if v.createdAt}<div class="text-xs text-white/40">{fmt(v.createdAt)}</div>{/if}
                  <div class="text-xs text-white/40 truncate">
                    {v.editedBy ?? ""}{#if v.restoredFrom} · restored v{v.restoredFrom}{/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        </aside>
      {/if}
      {#if panel === "log" && meta?.backend && canEdit && !readOffline}
        <BackendLog {id} onclose={() => (panel = null)} />
      {/if}
    </div>
  {/if}
</div>

{#if sharing && meta}
  <ShareDialog
    kind="page"
    {id}
    name={meta.name}
    version={meta.version}
    onclose={(changed) => {
      sharing = false;
      if (changed) load();
    }}
  />
{/if}
