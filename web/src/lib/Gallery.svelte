<script lang="ts" module>
  import type { Role } from "./api";

  type Tab = "mine" | "shared" | "archived";
  type Crumb = { id: string | null; name: string; role: Role };

  const homes: Record<Tab, Crumb> = {
    mine: { id: null, name: "Home", role: "owner" },
    shared: { id: null, name: "Shared with me", role: "viewer" },
    archived: { id: null, name: "Archived", role: "owner" },
  };

  // Where the gallery was, kept per browser tab so that going back from a page,
  // or reloading, returns to the same folder.
  const SAVED_KEY = "specola:gallery";
  type Saved = { tab: Tab; stack: Crumb[] };

  function loadSaved(): Saved {
    try {
      const v = JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? "null");
      if (v && v.tab in homes && Array.isArray(v.stack) && v.stack.length > 0) return v;
    } catch {
      // Storage unavailable or corrupt: start at Home.
    }
    return { tab: "mine", stack: [homes.mine] };
  }

  function save(v: Saved) {
    try {
      sessionStorage.setItem(SAVED_KEY, JSON.stringify(v));
    } catch {
      // Not essential.
    }
  }
</script>

<script lang="ts">
  import { api, type SearchResult, type TreeItem } from "./api";
  import MoveDialog from "./MoveDialog.svelte";
  import ShareDialog from "./ShareDialog.svelte";

  const initial = loadSaved();
  let tab = $state<Tab>(initial.tab);
  let stack = $state<Crumb[]>(initial.stack);
  let items = $state<TreeItem[]>([]);
  let loading = $state(true);
  let error = $state("");
  let sharing = $state<{ kind: "folder" | "page"; id: string; name: string } | null>(null);
  let moving = $state<TreeItem | null>(null);
  let menuFor = $state<string | null>(null);

  let here = $derived(stack[stack.length - 1]);
  // Top-level lists (shared, archived) aren't folders you can add to.
  let canEdit = $derived(here.id !== null ? here.role !== "viewer" : tab === "mine");

  $effect(() => save({ tab, stack }));

  function reload() {
    stack = [...stack];
  }

  $effect(() => {
    const crumb = stack[stack.length - 1];
    loading = true;
    error = "";
    const load =
      crumb.id !== null
        ? api.tree(crumb.id)
        : tab === "shared"
          ? api.shared()
          : tab === "archived"
            ? api.archived()
            : api.tree(null);
    load
      .then((d) => (items = d))
      .catch((e) => (error = String(e)))
      .finally(() => (loading = false));
  });

  function switchTab(t: Tab) {
    tab = t;
    stack = [homes[t]];
  }

  function open(it: TreeItem) {
    if (tab === "archived") return;
    if (it.kind === "folder") stack = [...stack, { id: it.id, name: it.name, role: it.role }];
    else location.hash = `#/p/${it.id}`;
  }

  function goTo(i: number) {
    stack = stack.slice(0, i + 1);
  }

  async function act(fn: () => Promise<unknown>) {
    menuFor = null;
    try {
      await fn();
      reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function newFolder() {
    const name = prompt("Folder name");
    if (name) act(() => api.createFolder(name, here.id));
  }

  function rename(it: TreeItem) {
    const name = prompt(`Rename “${it.name}”`, it.name);
    if (name && name.trim() !== it.name) act(() => api.rename(it.kind, it.id, name.trim()));
  }

  function archive(it: TreeItem) {
    const what = it.kind === "folder" ? "This folder and everything in it" : "This page";
    if (confirm(`Archive “${it.name}”? ${what} will be hidden, also from people it's shared with. You can restore it from Archived.`))
      act(() => api.archive(it.kind, it.id));
  }

  // Search
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

  const fmt = (s: string) => new Date(s).toLocaleDateString();
  const subtitle = (it: TreeItem) =>
    [tab === "archived" && "archived", it.kind === "page" && `v${it.version}`, fmt(it.updatedAt)]
      .filter(Boolean)
      .join(" · ");
  const tabClass = (t: Tab) =>
    "px-3 py-1.5 rounded-md " + (tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80");
  const btn = "text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5";
  const menuItem = "block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10";
</script>

<svelte:window onclick={() => (menuFor = null)} />

<div class="max-w-5xl mx-auto px-5 py-6">
  <div class="flex flex-wrap items-center justify-between gap-3 text-sm mb-4">
    <div class="flex gap-1">
      <button class={tabClass("mine")} onclick={() => switchTab("mine")}>My pages</button>
      <button class={tabClass("shared")} onclick={() => switchTab("shared")}>Shared with me</button>
      <button class={tabClass("archived")} onclick={() => switchTab("archived")}>Archived</button>
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
          <button class={btn} onclick={() => here.id && (sharing = { kind: "folder", id: here.id, name: here.name })}
            >Share</button
          >
        {/if}
        {#if canEdit}
          <button class={btn} onclick={newFolder}>+ Folder</button>
          <a class={btn} href={here.id ? `#/new/${here.id}` : "#/new"}>+ Page</a>
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
        {:else if tab === "archived"}
          <p>Nothing archived.</p>
        {:else}
          <p>Nothing here yet.</p>
          {#if canEdit}
            <a href={here.id ? `#/new/${here.id}` : "#/new"} class="text-amber-400 hover:underline">Publish a page →</a>
          {/if}
        {/if}
      </div>
    {:else}
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {#each items as it (it.id)}
          <div class="relative">
            <button
              class="w-full h-full text-left p-4 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition"
              onclick={() => open(it)}
            >
              <div class="flex items-start justify-between mb-2">
                <span class="text-2xl">{it.kind === "folder" ? "📁" : "📄"}</span>
                {#if it.role !== "owner"}
                  <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5 py-0.5"
                    >{it.role}</span
                  >
                {:else if it.shared}
                  <span
                    class="text-[10px] uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1.5 py-0.5"
                    >shared</span
                  >
                {/if}
              </div>
              <div class="font-medium truncate pr-6">{it.name}</div>
              <div class="text-xs text-white/40 mt-1">{subtitle(it)}</div>
            </button>

            {#if tab === "archived"}
              <button
                class="absolute bottom-3 right-3 text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10"
                onclick={() => act(() => api.unarchive(it.kind, it.id))}>Restore</button
              >
            {:else if it.role !== "viewer"}
              <button
                class="absolute bottom-3 right-3 w-7 h-7 rounded text-white/50 hover:text-white hover:bg-white/10"
                aria-label={`Actions for ${it.name}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === it.id}
                onclick={(e) => {
                  e.stopPropagation();
                  menuFor = menuFor === it.id ? null : it.id;
                }}>⋯</button
              >
              {#if menuFor === it.id}
                <div
                  role="menu"
                  tabindex="-1"
                  class="absolute right-3 top-full -mt-2 z-10 w-36 py-1 rounded-md border border-white/10 bg-[#1a1e27] shadow-lg"
                  onclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => e.key === "Escape" && (menuFor = null)}
                >
                  <button role="menuitem" class={menuItem} onclick={() => rename(it)}>Rename</button>
                  <button
                    role="menuitem"
                    class={menuItem}
                    onclick={() => {
                      menuFor = null;
                      moving = it;
                    }}>Move…</button
                  >
                  {#if it.role === "owner"}
                    <button
                      role="menuitem"
                      class={menuItem}
                      onclick={() => {
                        menuFor = null;
                        sharing = { kind: it.kind, id: it.id, name: it.name };
                      }}>Share…</button
                    >
                    <button role="menuitem" class={menuItem + " text-red-300"} onclick={() => archive(it)}>Archive</button>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if sharing}
  <ShareDialog
    kind={sharing.kind}
    id={sharing.id}
    name={sharing.name}
    onclose={(changed) => {
      sharing = null;
      if (changed) reload();
    }}
  />
{/if}

{#if moving}
  <MoveDialog
    item={moving}
    start={stack}
    onclose={(moved) => {
      moving = null;
      if (moved) reload();
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
