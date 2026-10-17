<script lang="ts">
  import { api, type PublicLink } from "./api";

  let { id, version, onchange }: { id: string; version?: number; onchange: () => void } = $props();

  let links = $state<PublicLink[]>([]);
  let loading = $state(true);
  let label = $state("");
  let days = $state("7");
  let pin = $state(false);
  let busy = $state(false);
  let error = $state("");
  // The URL of the link just made: the server keeps only its hash.
  let fresh = $state<{ id: string; url: string } | null>(null);
  let copied = $state(false);

  async function load() {
    try {
      links = await api.publicLinks(id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
      onchange();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function create(e: Event) {
    e.preventDefault();
    run(async () => {
      const l = await api.createPublicLink(id, {
        label: label.trim(),
        version: pin && version ? version : undefined,
        expiresInDays: Number(days) || undefined,
      });
      fresh = { id: l.id, url: l.url };
      copied = false;
      label = "";
    });
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      copied = true;
    } catch {
      prompt("Copy this link", fresh.url);
    }
  }

  function revoke(l: PublicLink) {
    if (!confirm(`Revoke ${l.label ? `“${l.label}”` : "this link"}? Anyone using it loses access at once.`)) return;
    run(async () => {
      await api.revokePublicLink(id, l.id);
      if (fresh?.id === l.id) fresh = null;
    });
  }

  const date = (s: string) => new Date(s).toLocaleDateString();
  function details(l: PublicLink) {
    const parts = [l.version ? `v${l.version} only` : "current version"];
    if (l.expired) parts.push("expired");
    else parts.push(l.expiresAt ? `until ${date(l.expiresAt)}` : "no expiry");
    parts.push(`${l.views} ${l.views === 1 ? "view" : "views"}`);
    if (l.lastUsedAt) parts.push(`last ${date(l.lastUsedAt)}`);
    return parts.join(" · ");
  }
  const input = "px-3 py-1.5 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none text-sm";
</script>

<section class="mt-5 pt-4 border-t border-white/10" aria-labelledby="public-links-title">
  <h3 id="public-links-title" class="font-semibold text-sm mb-1">Public links</h3>
  <p class="text-xs text-white/40 mb-3">
    Anyone with the link can view the page, without signing in. They can't see anything else in Specola.
  </p>

  <form onsubmit={create} class="flex flex-wrap gap-2 mb-2">
    <input bind:value={label} maxlength="100" placeholder="Label (who it's for)" class="flex-1 min-w-0 {input}" />
    <select bind:value={days} class="px-2 py-1.5 rounded-md bg-white/5 border border-white/15 text-sm" aria-label="Expires">
      <option value="1">1 day</option>
      <option value="7">7 days</option>
      <option value="30">30 days</option>
      <option value="90">90 days</option>
      <option value="0">No expiry</option>
    </select>
    <button
      type="submit"
      disabled={busy}
      class="px-3 py-1.5 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 disabled:opacity-50"
      >Create link</button
    >
    {#if version}
      <label class="w-full flex items-center gap-2 text-xs text-white/60">
        <input type="checkbox" bind:checked={pin} />
        Pin to v{version}, instead of following new versions
      </label>
    {/if}
  </form>

  {#if fresh}
    <div class="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 p-2">
      <div class="flex gap-2">
        <input readonly value={fresh.url} class="flex-1 min-w-0 {input}" onfocus={(e) => e.currentTarget.select()} />
        <button type="button" class="px-3 py-1.5 rounded-md border border-white/20 text-sm hover:bg-white/10" onclick={copy}
          >{copied ? "Copied" : "Copy"}</button
        >
      </div>
      <p class="text-xs text-amber-200/80 mt-1">Copy it now: Specola doesn't keep it and can't show it again.</p>
    </div>
  {/if}

  {#if error}<p class="text-red-400 text-sm mb-2">{error}</p>{/if}

  {#if loading}
    <p class="text-white/40 text-sm">Loading…</p>
  {:else if links.length === 0}
    <p class="text-white/40 text-sm">No public links.</p>
  {:else}
    <ul class="divide-y divide-white/10">
      {#each links as l (l.id)}
        <li class="flex items-center gap-2 py-2 text-sm">
          <div class="flex-1 min-w-0">
            <div class="truncate {l.expired ? 'text-white/40 line-through' : ''}">{l.label || "Untitled link"}</div>
            <div class="text-xs text-white/40 truncate" title={l.createdBy ? `Made by ${l.createdBy}` : undefined}>
              {details(l)}
            </div>
          </div>
          <button disabled={busy} class="text-white/50 hover:text-red-400" onclick={() => revoke(l)}
            >{l.expired ? "Delete" : "Revoke"}</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>
