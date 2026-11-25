<script lang="ts">
  import { untrack } from "svelte";
  import {
    api,
    backendErrorMessage,
    secretsMissing,
    Unauthorized,
    type PageMeta,
    type Snapshot,
    type VersionInfo,
  } from "./api";
  import BackendPanel, { type BackendTab } from "./BackendPanel.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { backends, refreshBackends } from "./backends.svelte";
  import * as offline from "./offline.svelte";
  import AppSettings from "./AppSettings.svelte";
  import PageFrame, { viewSrc } from "./PageFrame.svelte";
  import ShareDialog from "./ShareDialog.svelte";
  import { versionSnapshot } from "./snapshots";

  let { id }: { id: string } = $props();

  let meta = $state<PageMeta | null>(null);
  let error = $state("");
  let sharing = $state(false);
  // The App settings dialog (docs/page-apps.md, "Author settings").
  let appOpen = $state(false);
  // The side panel open, if any.
  let panel = $state<"history" | "backend" | null>(null);
  // The Backend panel's tab, kept while it is closed and set by the
  // missing-secrets notice.
  let backendTab = $state<BackendTab>("log");
  let historyOpen = $derived(panel === "history");
  let versions = $state<VersionInfo[]>([]);
  let viewing = $state<number | null>(null); // an older version, or null for current
  let busy = $state(false);
  let copied = $state(false);
  // A backend call was refused because a newer version is current.
  let superseded = $state(false);
  // Restoring a version whose data was kept: asks whether to restore it too.
  let restoreAsk = $state<{ from: number; snap: Snapshot } | null>(null);
  let withData = $state(false);
  // The version was restored but its data wasn't: said until dismissed.
  let dataFailed = $state("");
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
  // For "Open raw": the frame (PageFrame) loads the same.
  let src = $derived(meta && shown && !readOffline && !closed ? viewSrc(meta.viewUrl, shown) : "");
  let saving = $state(false);
  let canEdit = $derived(meta?.role === "owner" || meta?.role === "editor");
  // The Backend panel (docs/page-backends.md, "Data lifecycle"): for a page
  // with a backend, or with data a backend left, while backends may be on.
  let hasPanel = $derived(
    !!meta && (!!meta.backend || !!meta.backendData) && !readOffline && (backends.enabled || !backends.known),
  );
  // Secrets the backend declares and nobody has set (docs/page-backends.md,
  // "Secrets"): told to owners and editors, who can set them or ask.
  let missingSecrets = $derived(hasBackend && canEdit && !readOffline ? secretsMissing(meta) : []);
  function openSecrets() {
    backendTab = "secrets";
    panel = "backend";
  }
  // The Secrets tab loaded them: the notice follows without asking again.
  function setMissing(names: string[]) {
    if (meta) (meta as PageMeta & { backendSecretsMissing?: string[] }).backendSecretsMissing = names;
  }
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
        if (k && !(e instanceof Unauthorized)) meta = offline.keptMeta(k);
        else error = String(e);
      });
    if (historyOpen) loadVersions();
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

  // Restore makes a new current version from an older one. On a backend
  // page, an owner may also bring back the data that version left, when a
  // snapshot of it was kept (docs/page-backends.md, "Versions").
  async function restore() {
    if (viewing === null || !meta) return;
    const from = viewing;
    let snap: Snapshot | undefined;
    busy = true;
    if (meta.role === "owner" && (meta.backend || meta.backendData) && backends.enabled) {
      try {
        snap = versionSnapshot((await api.backendData(id)).snapshots, from);
      } catch {
        // No snapshots to offer: the code can still be restored.
      }
    }
    if (snap) {
      busy = false;
      withData = false;
      restoreAsk = { from, snap };
      return;
    }
    try {
      await restoreVersion(from);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function restoreVersion(from: number) {
    const r = await api.restoreVersion(id, from);
    viewing = null;
    load();
    return r.version;
  }

  // The dialog's step: the version, then its data if asked. The version stays
  // restored when the data can't be: that is said apart, not as the dialog's
  // error, which would read as if nothing had happened.
  async function restoreWithData() {
    const a = restoreAsk;
    if (!a) return;
    const v = await restoreVersion(a.from);
    if (!withData) return;
    try {
      await api.restoreSnapshot(id, a.snap.id);
      reloads++;
    } catch (e) {
      dataFailed = `Version ${a.from} is restored as v${v}, but its data couldn't be restored: ${backendErrorMessage(e)} The data is as it was; its snapshot can be restored from the Backend panel.`;
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
      {#if missingSecrets.length && hasPanel}
        <button
          data-secrets-missing
          class="shrink-0 text-[10px] uppercase tracking-wide text-amber-400 border border-amber-400/40 rounded px-1.5 py-0.5 hover:bg-amber-500/10"
          title="The backend declares {missingSecrets.join(', ')}, with no value set: what needs {missingSecrets.length === 1
            ? 'it'
            : 'them'} fails. {meta?.role === 'owner' ? 'Set them' : 'An owner sets them'} in the Backend panel's Secrets tab."
          aria-label={missingSecrets.length === 1 ? "1 secret missing" : `${missingSecrets.length} secrets missing`}
          onclick={openSecrets}
          ><!-- Short at phone width, where the row has no room for more. --><span class="sm:hidden">! secrets</span><span
            class="hidden sm:inline">{missingSecrets.length === 1 ? "1 secret missing" : `${missingSecrets.length} secrets missing`}</span
          ></button
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
      {#if hasPanel}
        <button class={action} aria-pressed={panel === "backend"} onclick={() => (panel = panel === "backend" ? null : "backend")}
          >Backend</button
        >
      {/if}
      {#if meta?.role === "owner" && !readOffline}
        <button class={action} onclick={() => (sharing = true)}>{meta.shared || meta.public ? "Shared" : "Share"}</button>
      {/if}
      {#if meta?.appUrl && !readOffline}
        <a
          href={meta.appUrl}
          target="_blank"
          rel="noopener"
          class={action}
          title="Open this page on its own, to install it as an app on this device">Install as app ↗</a
        >
      {/if}
      {#if canEdit && !readOffline}
        <button class={action} onclick={() => (appOpen = true)} title="How this page looks once installed as an app">App…</button>
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

  {#if dataFailed}
    <div
      data-restore-data-failed
      role="alert"
      class="flex items-start justify-between gap-3 px-3 sm:px-5 py-2 text-sm bg-red-500/10 border-b border-red-500/20 text-red-200"
    >
      <span class="break-words">{dataFailed}</span>
      <button class="shrink-0 text-white/60 hover:text-white" aria-label="Dismiss" onclick={() => (dataFailed = "")}>✕</button>
    </div>
  {/if}

  {#if meta?.backendPurgeAt && canEdit && !readOffline}
    <p data-purge-notice class="px-3 sm:px-5 py-1.5 text-xs text-red-300/90 border-b border-white/10">
      This page's backend data will be deleted on {new Date(meta.backendPurgeAt).toLocaleDateString(undefined, {
        dateStyle: "long",
      })}: its current version has no backend. Export it from the Backend panel to keep a copy.
    </p>
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
      {:else if meta && shown}
        <PageFrame
          {id}
          {meta}
          version={shown}
          {readOffline}
          bundle={shownBundle}
          {reloads}
          onsuperseded={() => (superseded = true)}
        />
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
      {#if panel === "backend" && hasPanel && meta}
        <BackendPanel
          page={meta}
          bind:tab={backendTab}
          onclose={() => (panel = null)}
          ondatachange={() => reloads++}
          onsecretsmissing={setMissing}
        />
      {/if}
    </div>
  {/if}
</div>

{#if restoreAsk && meta}
  {@const a = restoreAsk}
  <ConfirmDialog
    title="Restore version {a.from}?"
    confirmLabel="Restore as v{meta.version + 1}"
    run={restoreWithData}
    onclose={() => (restoreAsk = null)}
  >
    <p>This makes a new current version, v{meta.version + 1}, from version {a.from}'s code.</p>
    <label class="flex items-start gap-2 pt-1 text-white/90">
      <input type="checkbox" class="mt-1 accent-amber-500" bind:checked={withData} data-restore-data />
      <span>Also restore the data as version {a.from} left it ({fmt(a.snap.createdAt)})</span>
    </label>
    {#if withData}
      <p class="text-white/50">
        That replaces all of the page's backend data, every user's included, with that snapshot's. A snapshot of the data as it
        is now is taken first, so you can go back.
      </p>
    {:else}
      <p class="text-white/50">The data stays as it is now.</p>
    {/if}
  </ConfirmDialog>
{/if}

{#if appOpen}
  <AppSettings {id} onclose={() => (appOpen = false)} />
{/if}

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
