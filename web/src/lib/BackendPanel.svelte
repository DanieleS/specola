<script lang="ts" module>
  export type BackendTab = "log" | "data" | "secrets" | "jobs";
</script>

<script lang="ts">
  import type { PageMeta } from "./api";
  import BackendData from "./BackendData.svelte";
  import BackendJobs from "./BackendJobs.svelte";
  import BackendLog from "./BackendLog.svelte";
  import BackendSecrets from "./BackendSecrets.svelte";

  // The viewer's "Backend" panel (docs/page-backends.md): the log, the
  // secrets and the scheduled jobs, for owners and editors of a page whose
  // current version has a backend, and its data, for anyone (what each can
  // do there depends on their role). A page that went static keeps its data,
  // so it has the Data tab alone. tab: the one shown, which the viewer sets
  // to open the panel on Secrets from its "missing secrets" notice.
  let {
    page,
    tab: chosen = $bindable("log"),
    onclose,
    ondatachange,
    onsecretsmissing,
  }: {
    page: PageMeta;
    tab?: BackendTab;
    onclose: () => void;
    ondatachange: () => void;
    /** The declared secrets without a value, each time the Secrets tab loads them. */
    onsecretsmissing?: (names: string[]) => void;
  } = $props();

  let full = $derived(!!page.backend && (page.role === "owner" || page.role === "editor"));
  let tab = $derived(full ? chosen : "data");
  // A ref the Jobs tab asked the log to show; n tells asks apart.
  let focus = $state<{ ref: string; n: number } | null>(null);

  function showRef(ref: string) {
    focus = { ref, n: (focus?.n ?? 0) + 1 };
    chosen = "log";
  }

  // Chosen by hand: the log opens where its reader left it, not at a ref.
  function pick(t: BackendTab) {
    focus = null;
    chosen = t;
  }

  const tabs: { id: BackendTab; label: string }[] = [
    { id: "log", label: "Log" },
    { id: "data", label: "Data" },
    { id: "secrets", label: "Secrets" },
    { id: "jobs", label: "Jobs" },
  ];
  const tabClass = (t: BackendTab) =>
    "shrink-0 px-2.5 sm:px-3 py-1 rounded-md " + (tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80");
</script>

<!-- Beside the page from sm up; over it, full width, below. -->
<aside
  data-backend-panel
  class="absolute inset-y-0 right-0 z-10 w-full sm:w-[28rem] max-w-full flex flex-col bg-[#0b0d12] shadow-xl sm:static sm:shadow-none shrink-0 border-l border-white/10"
  aria-label="Backend"
>
  <div class="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
    <h2 class="text-sm font-semibold shrink-0">Backend</h2>
    <div class="flex items-center gap-1 text-sm min-w-0">
      {#if full}
        <!-- Four tabs fit a phone; if a narrow one can't, they scroll rather than push the close button out. -->
        <div class="flex gap-0.5 sm:gap-1 min-w-0 overflow-x-auto" role="tablist" aria-label="Backend">
          {#each tabs as t (t.id)}
            <button role="tab" aria-selected={tab === t.id} class={tabClass(t.id)} onclick={() => pick(t.id)}>{t.label}</button>
          {/each}
        </div>
      {/if}
      <button class="ml-1 sm:ml-2 shrink-0 text-white/50 hover:text-white/90" aria-label="Close the backend panel" onclick={onclose}
        >✕</button
      >
    </div>
  </div>
  {#if tab === "log"}
    <BackendLog id={page.id} {focus} />
  {:else if tab === "secrets"}
    <BackendSecrets {page} onmissing={onsecretsmissing} />
  {:else if tab === "jobs"}
    <BackendJobs id={page.id} onref={showRef} />
  {:else}
    <BackendData {page} {ondatachange} />
  {/if}
</aside>
