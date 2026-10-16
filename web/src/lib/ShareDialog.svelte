<script lang="ts">
  import { api, type ItemKind, type Share } from "./api";

  let {
    kind,
    id,
    name,
    onclose,
  }: { kind: ItemKind; id: string; name: string; onclose: (changed: boolean) => void } = $props();

  let shares = $state<Share[]>([]);
  let loading = $state(true);
  let email = $state("");
  let role = $state<Share["role"]>("viewer");
  let busy = $state(false);
  let error = $state("");
  let changed = false;

  async function load() {
    try {
      shares = await api.shares(kind, id);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }
  load();

  async function run(fn: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await fn();
      changed = true;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function add(e: Event) {
    e.preventDefault();
    run(async () => {
      await api.share(kind, id, email.trim(), role);
      email = "";
    });
  }

  const label = (s: Share) => s.email || s.name || s.sub;
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose(changed)} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onclose(changed)}
>
  <div
    class="w-full max-w-md rounded-lg border border-white/10 bg-[#12151c] p-5 shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="share-title"
  >
    <div class="flex items-center justify-between mb-4">
      <h2 id="share-title" class="font-semibold truncate">Share “{name}”</h2>
      <button class="text-white/50 hover:text-white/90" aria-label="Close" onclick={() => onclose(changed)}>✕</button>
    </div>

    <form onsubmit={add} class="flex gap-2 mb-1">
      <input
        type="email"
        bind:value={email}
        required
        placeholder="Email"
        class="flex-1 min-w-0 px-3 py-1.5 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none text-sm"
      />
      <select
        bind:value={role}
        class="px-2 py-1.5 rounded-md bg-white/5 border border-white/15 text-sm"
        aria-label="Role"
      >
        <option value="viewer">Viewer</option>
        <option value="editor">Editor</option>
      </select>
      <button
        type="submit"
        disabled={busy}
        class="px-3 py-1.5 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 disabled:opacity-50"
        >Share</button
      >
    </form>
    <p class="text-xs text-white/40 mb-4">
      {kind === "folder" ? "Applies to everything in this folder. " : ""}They need to have signed in to Specola once.
    </p>

    {#if error}<p class="text-red-400 text-sm mb-3">{error}</p>{/if}

    {#if loading}
      <p class="text-white/40 text-sm">Loading…</p>
    {:else if shares.length === 0}
      <p class="text-white/40 text-sm">Only you have access.</p>
    {:else}
      <ul class="divide-y divide-white/10">
        {#each shares as s (s.sub)}
          <li class="flex items-center gap-2 py-2 text-sm">
            <span class="flex-1 min-w-0 truncate" title={s.sub}>{label(s)}</span>
            <select
              value={s.role}
              disabled={busy}
              aria-label={`Role for ${label(s)}`}
              class="px-2 py-1 rounded-md bg-white/5 border border-white/15"
              onchange={(e) =>
                run(() => api.setShareRole(kind, id, s.sub, (e.currentTarget as HTMLSelectElement).value as Share["role"]))}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              disabled={busy}
              class="text-white/50 hover:text-red-400"
              aria-label={`Remove ${label(s)}`}
              onclick={() => run(() => api.unshare(kind, id, s.sub))}>Remove</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
