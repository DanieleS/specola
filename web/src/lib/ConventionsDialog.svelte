<script lang="ts">
  import { api, MAX_PREFERENCE_CHARS, type Conventions, type StyleRef } from "./api";
  import StyleRefPicker from "./StyleRefPicker.svelte";

  let {
    id,
    name,
    onclose,
  }: {
    /** The folder, which the caller owns. */
    id: string;
    name: string;
    onclose: (changed: boolean) => void;
  } = $props();

  let loading = $state(true);
  let own = $state<Conventions | null>(null);
  let inherited = $state<Conventions | null>(null);
  let text = $state("");
  let styleRef = $state<StyleRef | null>(null);
  let storedId = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");

  let count = $derived([...text].length);
  let tooLong = $derived(count > MAX_PREFERENCE_CHARS);

  // The dialog is made for one folder: it loads once.
  function load() {
    return api.folderConventions(id);
  }
  load()
    .then((c) => {
      own = c.own;
      inherited = c.effective && c.effective.folderId !== id ? c.effective : null;
      text = c.own?.text ?? "";
      styleRef = c.own?.styleRef ?? null;
      storedId = c.own?.styleRefId ?? null;
    })
    .catch((e) => (error = e instanceof Error ? e.message : String(e)))
    .finally(() => (loading = false));

  async function run(fn: () => Promise<unknown>) {
    busy = true;
    error = "";
    try {
      await fn();
      onclose(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function save(e: Event) {
    e.preventDefault();
    run(() => api.setFolderConventions(id, text, styleRef?.id ?? storedId));
  }

  const fmt = (s: string) => new Date(s).toLocaleDateString();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose(false)} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onclose(false)}
>
  <div
    class="w-full max-w-xl max-h-full overflow-y-auto rounded-lg border border-white/10 bg-[#12151c] p-5 shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="conventions-title"
  >
    <div class="flex items-center justify-between gap-3 mb-2">
      <h2 id="conventions-title" class="font-semibold truncate">Conventions for “{name}”</h2>
      <button class="text-white/50 hover:text-white/90" aria-label="Close" onclick={() => onclose(false)}>✕</button>
    </div>
    <p class="text-sm text-white/55 mb-4">
      For agents publishing in this folder and its sub-folders, whoever they work for. They come before personal
      preferences, not before what someone explicitly asks.
    </p>

    {#if loading}
      <p class="text-white/40 text-sm">Loading…</p>
    {:else}
      <form onsubmit={save}>
        {#if inherited && !own}
          <div class="mb-4 p-3 rounded-md border border-white/10 bg-white/[0.03] text-sm">
            <p class="text-white/60 mb-1">
              Now inherited from <span class="text-white/85">{inherited.path}</span>, by {inherited.updatedBy}. Conventions
              set here replace them for this folder.
            </p>
            {#if inherited.text}
              <pre class="whitespace-pre-wrap font-mono text-xs text-white/50 max-h-24 overflow-y-auto">{inherited.text}</pre>
            {/if}
          </div>
        {/if}

        <label for="conventions-text" class="block text-sm font-medium mb-1.5">Conventions <span class="font-normal text-white/40">(Markdown)</span></label>
        <textarea
          id="conventions-text"
          bind:value={text}
          rows="8"
          placeholder={"- Open every report with 4 KPIs\n- Values in EUR\n- Charts: ECharts, the palette of the style reference"}
          class="w-full px-3 py-2 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none font-mono text-[13px] leading-relaxed resize-y"
        ></textarea>
        <div class="flex justify-between gap-2 mt-1 mb-4 text-xs text-white/40">
          <span>{own ? `Last changed by ${own.updatedBy}, ${fmt(own.updatedAt)}` : ""}</span>
          <span class="shrink-0 whitespace-nowrap {tooLong ? 'text-red-400' : ''}">{count} / {MAX_PREFERENCE_CHARS}</span>
        </div>

        <p class="text-sm font-medium mb-1.5">Style reference</p>
        <StyleRefPicker
          value={styleRef}
          {storedId}
          disabled={busy}
          onchange={(r) => {
            styleRef = r;
            storedId = r?.id ?? null;
          }}
        />
        <p class="text-xs text-white/40 mt-1.5 mb-4">It only counts for people who can see that page.</p>

        <div class="flex gap-2.5 p-3 mb-4 rounded-md border border-amber-400/30 bg-amber-400/[0.07] text-xs leading-relaxed text-white/75">
          <svg
            class="w-4 h-4 shrink-0 mt-px text-amber-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg
          >
          <span
            >Only the folder's owner writes them. Agents get them, with your name, as preferences to respect, not as
            instructions to run.</span
          >
        </div>

        {#if error}<p class="text-red-400 text-sm mb-3">{error}</p>{/if}

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={busy || tooLong}
            class="px-3 py-1.5 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 disabled:opacity-50"
            >Save</button
          >
          <button
            type="button"
            class="px-3 py-1.5 rounded-md border border-white/15 text-sm hover:bg-white/5"
            onclick={() => onclose(false)}>Cancel</button
          >
          {#if own}
            <button
              type="button"
              disabled={busy}
              class="ml-auto px-3 py-1.5 text-sm text-white/50 hover:text-red-400 disabled:opacity-50"
              onclick={() => run(() => api.deleteFolderConventions(id))}>Remove conventions</button
            >
          {/if}
        </div>
      </form>
    {/if}
  </div>
</div>
