<script lang="ts">
  import { api, type PageMeta, type VersionInfo } from "./api";
  import ShareDialog from "./ShareDialog.svelte";

  let { id }: { id: string } = $props();

  let meta = $state<PageMeta | null>(null);
  let error = $state("");
  let sharing = $state(false);
  let historyOpen = $state(false);
  let versions = $state<VersionInfo[]>([]);
  let viewing = $state<number | null>(null); // an older version, or null for current
  let busy = $state(false);
  let copied = $state(false);

  let shown = $derived(viewing ?? meta?.version);
  let src = $derived(meta && shown ? withVersion(meta.viewUrl, shown) : "");

  // viewUrl may already carry a query (a view token), so add v properly.
  function withVersion(viewUrl: string, v: number) {
    const u = new URL(viewUrl, location.href);
    u.searchParams.set("v", String(v));
    return u.toString();
  }
  let canEdit = $derived(meta?.role === "owner" || meta?.role === "editor");

  function load() {
    api
      .pageMeta(id)
      .then((m) => (meta = m))
      .catch((e) => (error = String(e)));
    if (historyOpen) loadVersions();
  }

  function loadVersions() {
    api
      .versions(id)
      .then((v) => (versions = v))
      .catch((e) => (error = String(e)));
  }

  $effect(() => {
    meta = null;
    error = "";
    viewing = null;
    load();
  });

  function toggleHistory() {
    historyOpen = !historyOpen;
    if (historyOpen) loadVersions();
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
  <div class="flex items-center justify-between gap-3 px-5 h-12 border-b border-white/10 shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <a href="#/" class="text-white/50 hover:text-white/90" aria-label="Back to gallery">←</a>
      <span class="font-medium truncate">{meta?.name ?? "…"}</span>
      {#if meta}<span class="text-xs text-white/40">v{shown}</span>{/if}
      {#if meta && meta.role !== "owner"}
        <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
          >{meta.role}</span
        >
      {/if}
    </div>
    <div class="flex items-center gap-4 shrink-0">
      <button class={action} onclick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
      <button class={action} aria-pressed={historyOpen} onclick={toggleHistory}>History</button>
      {#if meta?.role === "owner"}
        <button class={action} onclick={() => (sharing = true)}>{meta.shared ? "Shared" : "Share"}</button>
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
        {#if canEdit}
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

  {#if error}
    <p class="p-5 text-red-400">{error}</p>
  {:else}
    <div class="flex flex-1 min-h-0">
      {#if src}
        <!-- No allow-same-origin: the page runs on an opaque origin, matching the
             server's CSP sandbox, so it cannot touch Specola's session or API. -->
        <iframe
          title={meta?.name ?? "page"}
          {src}
          referrerpolicy="no-referrer"
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          class="flex-1 w-full bg-white border-0"
        ></iframe>
      {/if}

      {#if historyOpen}
        <aside class="w-72 shrink-0 border-l border-white/10 overflow-y-auto" aria-label="Version history">
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
                    <span class="ml-auto text-xs text-white/40">{kb(v.sizeBytes)}</span>
                  </div>
                  <div class="text-xs text-white/40">{fmt(v.createdAt)}</div>
                  <div class="text-xs text-white/40 truncate">
                    {v.editedBy ?? ""}{#if v.restoredFrom} · restored v{v.restoredFrom}{/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        </aside>
      {/if}
    </div>
  {/if}
</div>

{#if sharing && meta}
  <ShareDialog
    kind="page"
    {id}
    name={meta.name}
    onclose={(changed) => {
      sharing = false;
      if (changed) load();
    }}
  />
{/if}
