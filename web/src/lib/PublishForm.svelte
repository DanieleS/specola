<script lang="ts">
  import { api } from "./api";

  let { folderId = null }: { folderId?: string | null } = $props();

  let name = $state("");
  let html = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      const r = await api.createPage(name.trim(), html, folderId);
      location.hash = `#/p/${r.id}`;
    } catch (err) {
      error = String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="max-w-3xl mx-auto px-5 py-6">
  <h1 class="text-xl font-semibold mb-1">New page</h1>
  <p class="text-sm text-white/40 mb-5">
    {folderId ? "Publishing into the folder you were browsing." : "Publishing to your home folder."}
  </p>
  <form onsubmit={submit} class="space-y-4">
    <div>
      <label for="name" class="block text-sm text-white/60 mb-1">Title</label>
      <input
        id="name"
        bind:value={name}
        required
        placeholder="How attention works"
        class="w-full px-3 py-2 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none"
      />
    </div>
    <div>
      <label for="html" class="block text-sm text-white/60 mb-1">HTML</label>
      <textarea
        id="html"
        bind:value={html}
        required
        rows="16"
        placeholder="<!doctype html>…"
        class="w-full px-3 py-2 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none font-mono text-sm"
      ></textarea>
    </div>
    {#if error}<p class="text-red-400 text-sm">{error}</p>{/if}
    <div class="flex gap-3">
      <button
        type="submit"
        disabled={busy}
        class="px-4 py-2 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50"
      >
        {busy ? "Publishing…" : "Publish"}
      </button>
      <button type="button" onclick={() => history.back()} class="px-4 py-2 rounded-md border border-white/15 hover:bg-white/5"
        >Cancel</button
      >
    </div>
  </form>
</div>
