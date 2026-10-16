<script lang="ts">
  import { api, type Role, type SearchResult, type TreeItem } from "./api";
  import ShareDialog from "./ShareDialog.svelte";

  type Crumb = { id: string | null; name: string; role: Role };
  type Tab = "mine" | "shared";

  const homes: Record<Tab, Crumb> = {
    mine: { id: null, name: "Home", role: "owner" },
    shared: { id: null, name: "Shared with me", role: "viewer" },
  };

  let tab = $state<Tab>("mine");
  let stack = $state<Crumb[]>([homes.mine]);
  let items = $state<TreeItem[]>([]);
  let loading = $state(true);
  let error = $state("");
  let sharing = $state<Crumb | null>(null);

  let query = $state("");
  let results = $state<SearchResult[] | null>(null);
  let searchError = $state("");
  let searchSeq = 0;

  // Debounced; a stale response never overwrites a newer one.
  $effect(() => {
    const q = query.trim();
    if (!q) {
      results = null;
      return;
    }
    const seq = ++searchSeq;
    const t = setTimeout(() => {
      api
        .search(q)
        .then((r) => seq === searchSeq && ((results = r), (searchError = "")))
        .catch((e) => seq === searchSeq && (searchError = String(e)));
    }, 250);
    return () => clearTimeout(t);
  });

  let here = $derived(stack[stack.length - 1]);
  // The shared tab's top level is a list, not a folder you can add to.
  let canEdit = $derived(here.id !== null ? here.role !== "viewer" : tab === "mine");

  function reload() {
    stack = [...stack];
  }

  $effect(() => {
    const crumb = stack[stack.length - 1];
    loading = true;
    error = "";
    (crumb.id === null && tab === "shared" ? api.shared() : api.tree(crumb.id))
      .then((d) => (items = d))
      .catch((e) => (error = String(e)))
      .finally(() => (loading = false));
  });

  function switchTab(t: Tab) {
    tab = t;
    stack = [homes[t]];
  }

  function open(it: TreeItem) {
    if (it.kind === "folder") stack = [...stack, { id: it.id, name: it.name, role: it.role }];
    else location.hash = `#/p/${it.id}`;
  }

  function goTo(i: number) {
    stack = stack.slice(0, i + 1);
  }

  async function newFolder() {
    const name = prompt("Folder name");
    if (!name) return;
    try {
      await api.createFolder(name, here.id);
      reload();
    } catch (e) {
      error = String(e);
    }
  }

  const fmt = (s: string) => new Date(s).toLocaleDateString();
  const tabClass = (t: Tab) =>
    "px-3 py-1.5 rounded-md " + (tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80");
</script>

<div class="max-w-5xl mx-auto px-5 py-6">
  <div class="flex flex-wrap items-center justify-between gap-3 text-sm mb-4">
    <div class="flex gap-1">
      <button class={tabClass("mine")} onclick={() => switchTab("mine")}>My pages</button>
      <button class={tabClass("shared")} onclick={() => switchTab("shared")}>Shared with me</button>
    </div>
    <input
      type="search"
      bind:value={query}
      placeholder="Search pages"
      aria-label="Search pages"
      class="w-full sm:w-64 px-3 py-1.5 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none"
    />
  </div>

  {#if query.trim()}
    {#if searchError}
      <p class="text-red-400">{searchError}</p>
    {:else if results === null}
      <p class="text-white/40">Searching…</p>
    {:else if results.length === 0}
      <p class="text-white/40 py-10 text-center">No pages match “{query.trim()}”.</p>
    {:else}
      <ul class="space-y-2">
        {#each results as r (r.id)}
          <li>
            <a
              href={`#/p/${r.id}`}
              class="block p-4 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition"
            >
              <div class="flex items-center gap-2">
                <span class="font-medium truncate">{r.name}</span>
                <span class="text-xs text-white/40">v{r.version}</span>
                {#if r.role !== "owner"}
                  <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
                    >{r.role}</span
                  >
                {/if}
              </div>
              {#if r.snippet}
                <!-- Safe: the server escapes the text and only adds <mark> tags. -->
                <p class="snippet text-sm text-white/60 mt-1">{@html r.snippet}</p>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <div class="flex items-center justify-between gap-3 mb-5">
      <nav class="flex items-center gap-1 text-sm text-white/60 min-w-0">
        {#each stack as c, i}
          {#if i > 0}<span class="text-white/25">/</span>{/if}
          <button class="hover:text-white/90 truncate" onclick={() => goTo(i)}>{c.name}</button>
        {/each}
      </nav>
      <div class="flex gap-2 shrink-0">
        {#if here.id !== null && here.role === "owner"}
          <button
            class="text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5"
            onclick={() => (sharing = here)}>Share</button
          >
        {/if}
        {#if canEdit}
          <button
            class="text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5"
            onclick={newFolder}>+ Folder</button
          >
        {/if}
      </div>
    </div>

    {#if loading}
      <p class="text-white/40">Loading…</p>
    {:else if error}
      <p class="text-red-400">{error}</p>
    {:else if items.length === 0}
      <div class="text-center py-20 text-white/40">
        {#if tab === "shared" && here.id === null}
          <p>Nothing has been shared with you yet.</p>
        {:else}
          <p>Nothing here yet.</p>
          {#if tab === "mine" && here.id === null}
            <a href="#/new" class="text-amber-400 hover:underline">Publish your first page →</a>
          {/if}
        {/if}
      </div>
    {:else}
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {#each items as it (it.id)}
          <button
            class="text-left p-4 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition"
            onclick={() => open(it)}
          >
            <div class="flex items-start justify-between mb-2">
              <span class="text-2xl">{it.kind === "folder" ? "📁" : "📄"}</span>
              {#if it.role !== "owner"}
                <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
                  >{it.role}</span
                >
              {:else if it.shared}
                <span class="text-[10px] uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1.5 py-0.5"
                  >shared</span
                >
              {/if}
            </div>
            <div class="font-medium truncate">{it.name}</div>
            <div class="text-xs text-white/40 mt-1">
              {#if it.kind === "page"}v{it.version} · {/if}{fmt(it.updatedAt)}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if sharing?.id}
  <ShareDialog
    kind="folder"
    id={sharing.id}
    name={sharing.name}
    onclose={(changed) => {
      sharing = null;
      if (changed) reload();
    }}
  />
{/if}

<style>
  .snippet :global(mark) {
    background: rgb(251 191 36 / 0.25);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
</style>
