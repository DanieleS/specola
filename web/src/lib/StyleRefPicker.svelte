<script lang="ts">
  import { api, type SearchResult, type StyleRef } from "./api";

  let {
    value,
    storedId = null,
    disabled = false,
    onchange,
  }: {
    /** The chosen page, or null. */
    value: StyleRef | null;
    /** The stored reference, when value is null because the page can't be seen any more. */
    storedId?: string | null;
    disabled?: boolean;
    onchange: (ref: StyleRef | null) => void;
  } = $props();

  let picking = $state(false);
  let query = $state("");
  let results = $state<SearchResult[] | null>(null);
  let error = $state("");
  let seq = 0;

  // Debounced; a stale response never overwrites a newer one.
  $effect(() => {
    const q = query.trim();
    if (!picking || !q) {
      results = null;
      return;
    }
    const n = ++seq;
    const t = setTimeout(() => {
      api
        .search(q)
        .then((r) => n === seq && ((results = r), (error = "")))
        .catch((e) => n === seq && (error = e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => clearTimeout(t);
  });

  function choose(r: SearchResult) {
    onchange({ id: r.id, name: r.name, version: r.version ?? 1, folderId: null });
    picking = false;
    query = "";
  }

  const btn = "px-3 py-1.5 rounded-md border border-white/15 text-sm hover:bg-white/5 disabled:opacity-50";
</script>

{#if picking}
  <div class="rounded-md border border-white/15">
    <div class="flex gap-2 p-2 border-b border-white/10">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="search"
        bind:value={query}
        autofocus
        placeholder="Search your pages"
        aria-label="Search pages for a style reference"
        class="flex-1 min-w-0 px-3 py-1.5 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none text-sm"
      />
      <button type="button" class={btn} onclick={() => ((picking = false), (query = ""))}>Cancel</button>
    </div>
    <div class="max-h-56 overflow-y-auto">
      {#if error}
        <p class="p-3 text-red-400 text-sm">{error}</p>
      {:else if !query.trim()}
        <p class="p-3 text-white/40 text-sm">Type to find a page you can see.</p>
      {:else if results === null}
        <p class="p-3 text-white/40 text-sm">Searching…</p>
      {:else if results.length === 0}
        <p class="p-3 text-white/40 text-sm">No pages match.</p>
      {:else}
        {#each results as r (r.id)}
          <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
            onclick={() => choose(r)}
          >
            <span>📄</span><span class="flex-1 truncate">{r.name}</span>
            <span class="text-xs text-white/40">v{r.version}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{:else if value}
  <div class="flex flex-wrap items-center gap-3 p-3 rounded-md border border-white/15">
    <a href={`#/p/${value.id}`} class="grow basis-48 min-w-0 flex items-center gap-3 hover:text-white">
      <span class="w-9 h-9 shrink-0 rounded-md bg-white/5 flex items-center justify-center">📄</span>
      <span class="min-w-0">
        <span class="block font-medium truncate">{value.name}</span>
        <span class="block text-xs text-white/40 truncate">v{value.version} · agents read its current version</span>
      </span>
    </a>
    <div class="flex gap-2">
      <button type="button" class={btn} {disabled} onclick={() => (picking = true)}>Change</button>
      <button type="button" class={btn} {disabled} onclick={() => onchange(null)}>Remove</button>
    </div>
  </div>
{:else}
  <div class="flex flex-wrap items-center gap-3">
    {#if storedId}
      <span class="text-sm text-white/50">The page chosen before can't be seen any more, so it doesn't count.</span>
      <button type="button" class={btn} {disabled} onclick={() => onchange(null)}>Remove</button>
    {/if}
    <button type="button" class={btn} {disabled} onclick={() => (picking = true)}>Choose a page…</button>
  </div>
{/if}
