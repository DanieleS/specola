<script lang="ts">
  import { api, type PageMeta } from "./api";

  let { id }: { id: string } = $props();

  let meta = $state<PageMeta | null>(null);
  let error = $state("");

  $effect(() => {
    meta = null;
    error = "";
    api
      .pageMeta(id)
      .then((m) => (meta = m))
      .catch((e) => (error = String(e)));
  });
</script>

<div class="flex flex-col h-[calc(100vh-3.5rem)]">
  <div class="flex items-center justify-between px-5 h-12 border-b border-white/10 shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <a href="#/" class="text-white/50 hover:text-white/90">←</a>
      <span class="font-medium truncate">{meta?.name ?? "…"}</span>
      {#if meta}<span class="text-xs text-white/40">v{meta.version}</span>{/if}
    </div>
    <a
      href={`/view/${id}`}
      target="_blank"
      rel="noopener"
      class="text-sm text-white/50 hover:text-white/90">Open raw ↗</a
    >
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
