<script lang="ts">
  import { api, type BundleUpload } from "./api";
  import { backends } from "./backends.svelte";

  let { folderId = null }: { folderId?: string | null } = $props();

  let name = $state("");
  let html = $state("");
  let note = $state("");
  let busy = $state(false);
  let error = $state("");

  // An app with a build step is published as a bundle from its project,
  // with the Vite plugin: this gets the commands to run there.
  // The link is made for the title, folder and note given when it was asked
  // for: once they change, its commands are no longer shown.
  let upload = $state<(BundleUpload & { for: string }) | null>(null);
  let uploadFor = $derived(JSON.stringify([name.trim(), folderId, note]));
  let shownUpload = $derived(upload?.for === uploadFor ? upload : null);
  let uploading = $state(false);
  let copied = $state("");

  async function bundleUpload() {
    error = "";
    if (!name.trim()) {
      error = "Give the page a title first.";
      return;
    }
    uploading = true;
    try {
      const what = uploadFor;
      upload = { ...(await api.bundleUpload({ kind: "new", title: name.trim(), folderId, note })), for: what };
    } catch (err) {
      error = String(err);
    } finally {
      uploading = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = text;
      setTimeout(() => (copied = ""), 1500);
    } catch {
      prompt("Copy this command", text);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      const r = await api.createPage(name.trim(), html, folderId, note);
      location.hash = `#/p/${r.id}`;
    } catch (err) {
      error = String(err);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet command(text: string)}
  <div class="flex items-start gap-2 mt-1">
    <code class="flex-1 min-w-0 break-all font-mono text-xs text-white/80 bg-black/30 rounded px-2 py-1.5">{text}</code>
    <button type="button" class="text-xs text-white/50 hover:text-white/90 py-1.5" onclick={() => copy(text)}
      >{copied === text ? "Copied" : "Copy"}</button
    >
  </div>
{/snippet}

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
    <div class="text-sm text-white/50 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <p>
        An app with a build step (React, Svelte, Vue, several files) is published from its project with the
        Specola Vite plugin, as a bundle.
        <button type="button" disabled={uploading} onclick={bundleUpload} class="text-amber-400 hover:text-amber-300 disabled:opacity-50"
          >{uploading ? "Getting a link…" : "Get the commands"}</button
        >
      </p>
      {#if backends.known && !backends.enabled}
        <p class="mt-2" data-backends-off>
          Page backends are not enabled on this instance: bundles are static, and a project with <code class="text-white/70"
            >server/</code
          > code can't be published.
        </p>
      {:else if backends.known && !backends.available}
        <p class="mt-2" data-backends-off>
          The backend runner can't be reached right now: an app with a backend still publishes, but its calls fail until the
          runner is back.
        </p>
      {/if}
      {#if shownUpload}
        <p class="mt-2">In the project, once:</p>
        {@render command(shownUpload.pluginInstall)}
        <p class="mt-2">
          then add <code class="text-white/70">specola()</code> to the plugins in vite.config and publish (the link works for 30 minutes,
          once):
        </p>
        {@render command(shownUpload.command)}
      {/if}
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
    <div>
      <label for="note" class="block text-sm text-white/60 mb-1">Note <span class="text-white/30">(optional)</span></label>
      <input
        id="note"
        bind:value={note}
        maxlength="500"
        placeholder="What this version is"
        class="w-full px-3 py-2 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none"
      />
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
