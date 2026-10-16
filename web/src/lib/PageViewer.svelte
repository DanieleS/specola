<script lang="ts">
  import { api, type PageMeta } from "./api";
  import ShareDialog from "./ShareDialog.svelte";

  let { id }: { id: string } = $props();

  let meta = $state<PageMeta | null>(null);
  let error = $state("");
  let sharing = $state(false);

  function load() {
    api
      .pageMeta(id)
      .then((m) => (meta = m))
      .catch((e) => (error = String(e)));
  }

  $effect(() => {
    meta = null;
    error = "";
    load();
  });
</script>

<div class="flex flex-col h-[calc(100vh-3.5rem)]">
  <div class="flex items-center justify-between px-5 h-12 border-b border-white/10 shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <a href="#/" class="text-white/50 hover:text-white/90">←</a>
      <span class="font-medium truncate">{meta?.name ?? "…"}</span>
      {#if meta}<span class="text-xs text-white/40">v{meta.version}</span>{/if}
      {#if meta && meta.role !== "owner"}
        <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
          >{meta.role}</span
        >
      {/if}
    </div>
    <div class="flex items-center gap-4 shrink-0">
      {#if meta?.role === "owner"}
        <button class="text-sm text-white/50 hover:text-white/90" onclick={() => (sharing = true)}
          >{meta.shared ? "Shared" : "Share"}</button
        >
      {/if}
      <a
        href={`/view/${id}`}
        target="_blank"
        rel="noopener"
        class="text-sm text-white/50 hover:text-white/90">Open raw ↗</a
      >
    </div>
  </div>

  {#if error}
    <p class="p-5 text-red-400">{error}</p>
  {:else}
    <!-- No allow-same-origin: the page runs on an opaque origin, matching the
         server's CSP sandbox, so it cannot touch Specola's session or API. -->
    <iframe
      title={meta?.name ?? "page"}
      src={`/view/${id}`}
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      class="flex-1 w-full bg-white border-0"
    ></iframe>
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
