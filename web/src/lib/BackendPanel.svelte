<script lang="ts">
  import type { PageMeta } from "./api";
  import BackendData from "./BackendData.svelte";
  import BackendLog from "./BackendLog.svelte";

  // The viewer's "Backend" panel (docs/page-backends.md): the log, for owners
  // and editors of a page whose current version has a backend, and its data,
  // for anyone (what each can do there depends on their role). A page that
  // went static keeps its data, so it has the Data tab alone.
  let {
    page,
    onclose,
    ondatachange,
  }: { page: PageMeta; onclose: () => void; ondatachange: () => void } = $props();

  let hasLog = $derived(!!page.backend && (page.role === "owner" || page.role === "editor"));
  let chosen = $state<"log" | "data">("log");
  let tab = $derived(hasLog ? chosen : "data");

  const tabClass = (t: "log" | "data") =>
    "px-3 py-1 rounded-md " + (tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80");
</script>

<!-- Beside the page from sm up; over it, full width, below. -->
<aside
  data-backend-panel
  class="absolute inset-y-0 right-0 z-10 w-full sm:w-[28rem] max-w-full flex flex-col bg-[#0b0d12] shadow-xl sm:static sm:shadow-none shrink-0 border-l border-white/10"
  aria-label="Backend"
>
  <div class="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
    <h2 class="text-sm font-semibold">Backend</h2>
    <div class="flex items-center gap-1 text-sm">
      {#if hasLog}
        <div class="flex gap-1" role="tablist" aria-label="Backend">
          <button role="tab" aria-selected={tab === "log"} class={tabClass("log")} onclick={() => (chosen = "log")}>Log</button>
          <button role="tab" aria-selected={tab === "data"} class={tabClass("data")} onclick={() => (chosen = "data")}>Data</button>
        </div>
      {/if}
      <button class="ml-2 text-white/50 hover:text-white/90" aria-label="Close the backend panel" onclick={onclose}>✕</button>
    </div>
  </div>
  {#if tab === "log"}
    <BackendLog id={page.id} />
  {:else}
    <BackendData {page} {ondatachange} />
  {/if}
</aside>
