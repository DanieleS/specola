<script lang="ts">
  import { api, MAX_PREFERENCE_CHARS, type PublishMode, type StyleRef } from "./api";
  import * as offline from "./offline.svelte";
  import StyleRefPicker from "./StyleRefPicker.svelte";

  let loading = $state(true);
  let mode = $state<PublishMode>("auto");
  let text = $state("");
  let styleRef = $state<StyleRef | null>(null);
  // The stored reference, kept while the user doesn't remove it even when the
  // page can't be seen any more (then it doesn't count).
  let storedId = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let saved = $state("");

  // Characters as the server counts them (code points).
  let count = $derived([...text].length);
  let tooLong = $derived(count > MAX_PREFERENCE_CHARS);

  api
    .preferences()
    .then((p) => {
      mode = p.mode;
      text = p.text;
      styleRef = p.styleRef;
      storedId = p.styleRefId;
    })
    .catch((e) => (error = e instanceof Error ? e.message : String(e)))
    .finally(() => (loading = false));

  async function save(e: Event) {
    e.preventDefault();
    busy = true;
    error = "";
    saved = "";
    try {
      const p = await api.setPreferences({ mode, text, styleRefId: styleRef?.id ?? storedId });
      text = p.text;
      styleRef = p.styleRef;
      storedId = p.styleRefId;
      saved = "Saved. Agents get them the next time they connect.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const modes: { value: PublishMode; title: string; desc: string }[] = [
    {
      value: "auto",
      title: "The agent decides",
      desc: "A single HTML file for simple pages, a bundle with the Vite plugin when the page needs a build.",
    },
    { value: "bundle", title: "Always a bundle", desc: "Even small pages start as a Vite project." },
  ];
  const card = "rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5";
</script>

<div class="max-w-3xl mx-auto px-4 sm:px-5 py-6">
  <h1 class="text-xl font-semibold mb-1">Preferences for agents</h1>
  <p class="text-sm text-white/60 mb-6">
    What an agent connected through MCP should use when it makes a page for you. They apply when your request
    doesn't say otherwise; a folder can have conventions of its own, which come first.
  </p>

  {#if loading}
    <p class="text-white/40">Loading…</p>
  {:else}
    <form onsubmit={save} class="space-y-4">
      <section class={card}>
        <h2 id="mode-title" class="font-semibold mb-3">How to publish</h2>
        <div class="grid sm:grid-cols-2 gap-3" role="radiogroup" aria-labelledby="mode-title">
          {#each modes as m (m.value)}
            <label
              class="flex gap-3 p-3 rounded-md border cursor-pointer transition {mode === m.value
                ? 'border-amber-400/70 bg-amber-400/[0.07]'
                : 'border-white/15 hover:border-white/25'}"
            >
              <input type="radio" name="mode" value={m.value} bind:group={mode} class="mt-1 accent-amber-500" />
              <span>
                <span class="block text-sm font-medium">{m.title}</span>
                <span class="block text-xs text-white/55 mt-0.5 leading-relaxed">{m.desc}</span>
              </span>
            </label>
          {/each}
        </div>
      </section>

      <section class={card}>
        <div class="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 class="font-semibold"><label for="prefs-text">Stack and style</label></h2>
          <span class="text-xs text-white/40">Markdown, read as written by the agent</span>
        </div>
        <textarea
          id="prefs-text"
          bind:value={text}
          rows="10"
          placeholder={"- Framework: Svelte 5 + TypeScript\n- Style: Tailwind, dark theme, amber accent\n- Charts: ECharts\n- Avoid heavy UI libraries"}
          class="w-full px-3 py-2 rounded-md bg-white/5 border border-white/15 focus:border-amber-400 outline-none font-mono text-[13px] leading-relaxed resize-y"
        ></textarea>
        <div class="flex flex-wrap justify-between gap-2 mt-2 text-xs text-white/40">
          <span>Ideas: framework, chart library, language, palette, what to avoid.</span>
          <span class="shrink-0 whitespace-nowrap {tooLong ? 'text-red-400' : ''}">{count} / {MAX_PREFERENCE_CHARS}</span>
        </div>
      </section>

      <section class={card}>
        <h2 class="font-semibold mb-1">Style reference</h2>
        <p class="text-sm text-white/55 mb-3">A Specola page agents take colours, typography and components from.</p>
        <StyleRefPicker
          value={styleRef}
          {storedId}
          onchange={(r) => {
            styleRef = r;
            storedId = r?.id ?? null;
          }}
        />
      </section>

      {#if error}<p class="text-red-400 text-sm">{error}</p>{/if}
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || tooLong || !offline.net.online}
          class="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 disabled:opacity-50"
          >Save</button
        >
        {#if saved}<span class="text-sm text-white/50">{saved}</span>{/if}
        {#if !offline.net.online}<span class="text-sm text-white/50">Offline: saving needs a connection.</span>{/if}
      </div>
    </form>
  {/if}
</div>
