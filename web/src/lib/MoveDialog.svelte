<script lang="ts">
  import { untrack } from "svelte";
  import { api, type Role, type TreeItem } from "./api";

  export type Crumb = { id: string | null; name: string; role: Role };

  let {
    item,
    start,
    onclose,
  }: {
    item: TreeItem;
    /** Where browsing starts: the gallery's current breadcrumbs. */
    start: Crumb[];
    onclose: (moved: boolean) => void;
  } = $props();

  // Browsing starts where the gallery is; later changes to it don't matter.
  let stack = $state<Crumb[]>(untrack(() => [...start]));
  let folders = $state<TreeItem[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");

  let here = $derived(stack[stack.length - 1]);
  // The top of a "Shared with me" trail isn't a folder either.
  let isSharedTop = $derived(here.id === null && here.role !== "owner");
  // Moving to your Home puts the item in its creator's home, so owners only.
  let canDrop = $derived(
    !isSharedTop &&
      (here.id === null ? item.role === "owner" : here.role !== "viewer") &&
      here.id !== item.id,
  );

  $effect(() => {
    const crumb = stack[stack.length - 1];
    loading = true;
    const load = crumb.id === null && crumb.role !== "owner" ? api.shared() : api.tree(crumb.id);
    load
      .then((d) => (folders = d.filter((f) => f.kind === "folder" && f.id !== item.id)))
      .catch((e) => (error = String(e)))
      .finally(() => (loading = false));
  });

  async function moveHere() {
    busy = true;
    error = "";
    try {
      await api.move(item.kind, item.id, here.id);
      onclose(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose(false)} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onclose(false)}
>
  <div
    class="w-full max-w-md rounded-lg border border-white/10 bg-[#12151c] p-5 shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="move-title"
  >
    <div class="flex items-center justify-between mb-4">
      <h2 id="move-title" class="font-semibold truncate">Move “{item.name}”</h2>
      <button class="text-white/50 hover:text-white/90" aria-label="Close" onclick={() => onclose(false)}>✕</button>
    </div>

    <nav class="flex flex-wrap items-center gap-1 text-sm text-white/60 mb-3">
      {#each stack as c, i}
        {#if i > 0}<span class="text-white/25">/</span>{/if}
        <button class="hover:text-white/90" onclick={() => (stack = stack.slice(0, i + 1))}>{c.name}</button>
      {/each}
    </nav>

    <div class="h-56 overflow-y-auto rounded-md border border-white/10 mb-4">
      {#if loading}
        <p class="p-3 text-white/40 text-sm">Loading…</p>
      {:else if folders.length === 0}
        <p class="p-3 text-white/40 text-sm">No sub-folders.</p>
      {:else}
        {#each folders as f (f.id)}
          <button
            class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
            onclick={() => (stack = [...stack, { id: f.id, name: f.name, role: f.role }])}
          >
            <span>📁</span><span class="flex-1 truncate">{f.name}</span>
            {#if f.role === "viewer"}<span class="text-[10px] uppercase text-white/40">view only</span>{/if}
          </button>
        {/each}
      {/if}
    </div>

    {#if error}<p class="text-red-400 text-sm mb-3">{error}</p>{/if}

    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-white/40">
        {#if isSharedTop}Open a folder to move into it.
        {:else if here.id === null && item.role !== "owner"}Only the owner can move this to Home.
        {:else if here.id !== null && here.role === "viewer"}You can only view this folder.
        {/if}
      </p>
      <button
        disabled={!canDrop || busy}
        onclick={moveHere}
        class="px-3 py-1.5 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 disabled:opacity-40"
        >Move here</button
      >
    </div>
  </div>
</div>
