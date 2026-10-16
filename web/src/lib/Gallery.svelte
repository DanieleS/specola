<script lang="ts">
  import { api, type TreeItem } from "./api";

  type Crumb = { id: string | null; name: string };

  let stack = $state<Crumb[]>([{ id: null, name: "Home" }]);
  let items = $state<TreeItem[]>([]);
  let loading = $state(true);
  let error = $state("");

  $effect(() => {
    const parent = stack[stack.length - 1].id;
    loading = true;
    error = "";
    api
      .tree(parent)
      .then((d) => (items = d))
      .catch((e) => (error = String(e)))
      .finally(() => (loading = false));
  });

  function open(it: TreeItem) {
    if (it.kind === "folder") stack = [...stack, { id: it.id, name: it.name }];
    else location.hash = `#/p/${it.id}`;
  }

  function goTo(i: number) {
    stack = stack.slice(0, i + 1);
  }

  async function newFolder() {
    const name = prompt("Folder name");
    if (!name) return;
    await api.createFolder(name, stack[stack.length - 1].id);
    stack = [...stack];
  }

  const fmt = (s: string) => new Date(s).toLocaleDateString();
</script>

<div class="max-w-5xl mx-auto px-5 py-6">
  <div class="flex items-center justify-between mb-5">
    <nav class="flex items-center gap-1 text-sm text-white/60">
      {#each stack as c, i}
        {#if i > 0}<span class="text-white/25">/</span>{/if}
        <button class="hover:text-white/90" onclick={() => goTo(i)}>{c.name}</button>
      {/each}
    </nav>
    <button
      class="text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5"
      onclick={newFolder}>+ Folder</button
    >
  </div>

  {#if loading}
    <p class="text-white/40">Loading…</p>
  {:else if error}
    <p class="text-red-400">{error}</p>
  {:else if items.length === 0}
    <div class="text-center py-20 text-white/40">
      <p>Nothing here yet.</p>
      <a href="#/new" class="text-amber-400 hover:underline">Publish your first page →</a>
    </div>
  {:else}
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {#each items as it (it.id)}
        <button
          class="text-left p-4 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition"
          onclick={() => open(it)}
        >
          <div class="text-2xl mb-2">{it.kind === "folder" ? "📁" : "📄"}</div>
          <div class="font-medium truncate">{it.name}</div>
          <div class="text-xs text-white/40 mt-1">
            {#if it.kind === "page"}v{it.version} · {/if}{fmt(it.updatedAt)}
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
