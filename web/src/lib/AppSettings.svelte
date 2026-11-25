<script lang="ts">
  // How a page's app looks once installed (docs/page-apps.md, "Author
  // settings"): name, colors, display and icon, for the page's editors.
  // Every field left empty takes its default, shown as the placeholder.
  import { api, type AppDisplay, type AppOrientation, type AppSettings } from "./api";

  let { id, onclose }: { id: string; onclose: () => void } = $props();

  let app = $state<AppSettings | null>(null);
  let error = $state("");
  let busy = $state(false);
  let saved = $state(false);

  let name = $state("");
  let shortName = $state("");
  let display = $state<AppDisplay | "">("");
  let orientation = $state<AppOrientation | "">("");
  let themeColor = $state("");
  let backgroundColor = $state("");
  let iconMaskable = $state(false);

  function fill(a: AppSettings) {
    app = a;
    name = a.settings.name ?? "";
    shortName = a.settings.shortName ?? "";
    display = a.settings.display ?? "";
    orientation = a.settings.orientation ?? "";
    themeColor = a.settings.themeColor ?? "";
    backgroundColor = a.settings.backgroundColor ?? "";
    iconMaskable = a.settings.iconMaskable;
  }

  $effect(() => {
    api.appSettings(id).then(fill, (e) => (error = e instanceof Error ? e.message : String(e)));
  });

  async function act(f: () => Promise<AppSettings>) {
    busy = true;
    error = "";
    saved = false;
    try {
      fill(await f());
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
  function save(e: SubmitEvent) {
    e.preventDefault();
    void act(() =>
      api.setAppSettings(id, {
        name: orNull(name),
        shortName: orNull(shortName),
        display: (display || null) as AppDisplay | null,
        orientation: (orientation || null) as AppOrientation | null,
        themeColor: orNull(themeColor)?.toLowerCase() ?? null,
        backgroundColor: orNull(backgroundColor)?.toLowerCase() ?? null,
        iconMaskable,
      }),
    );
  }

  function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) void act(() => api.setAppIcon(id, f));
  }

  const close = () => !busy && onclose();
  const field = "mt-1 w-full rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm focus:outline-none focus:border-white/40";
  const hex = /^#[0-9a-fA-F]{6}$/;
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && close()}
>
  <div
    class="w-full max-w-lg max-h-full overflow-y-auto rounded-lg border border-white/10 bg-[#12151c] p-5 shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="app-settings-title"
    data-app-settings
  >
    <div class="flex items-center justify-between gap-3 mb-1">
      <h2 id="app-settings-title" class="font-semibold">App</h2>
      <button type="button" class="text-white/50 hover:text-white/90" aria-label="Close" onclick={close}>✕</button>
    </div>
    <p class="text-xs text-white/50 mb-4">
      How this page looks once installed as an app, by anyone who can see it and through its public links. Leave a field empty for
      its default.
    </p>

    {#if !app}
      <p class="text-sm text-white/50">{error || "Loading…"}</p>
    {:else}
      {@const a = app}
      <div class="flex items-center gap-4 mb-4">
        <img src={a.effective.icon} alt="The app's icon" width="64" height="64" class="w-16 h-16 rounded-xl" />
        {#if a.effective.iconMaskable}
          <img
            src={a.effective.icon}
            alt="The app's icon, masked as Android shows it"
            width="64"
            height="64"
            class="w-16 h-16"
            style="clip-path: circle(40% at 50% 50%);"
          />
        {/if}
        <div class="min-w-0 text-sm">
          <div class="font-medium truncate">{a.effective.name}</div>
          <div class="text-white/50 truncate">{a.effective.shortName} · {a.effective.display}</div>
          {#if a.canEdit}
            <div class="mt-1 flex flex-wrap gap-x-3 text-xs">
              <label class="text-amber-400 hover:text-amber-300 cursor-pointer">
                Upload icon…
                <input type="file" accept="image/png" class="sr-only" disabled={busy} onchange={upload} data-app-icon-input />
              </label>
              {#if a.settings.icon}
                <button type="button" class="text-white/60 hover:text-white" disabled={busy} onclick={() => act(() => api.deleteAppIcon(id))}
                  >Use the generated icon</button
                >
              {/if}
            </div>
            <p class="text-[11px] text-white/40 mt-1">A square PNG, at least 512 × 512, up to 1 MB.</p>
          {/if}
        </div>
      </div>

      <form onsubmit={save} class="space-y-3 text-sm">
        <fieldset disabled={!a.canEdit || busy} class="space-y-3">
          <label class="block">
            <span class="text-white/60">Name</span>
            <input bind:value={name} maxlength="60" placeholder={a.effective.name} class={field} data-app-name />
          </label>
          <label class="block">
            <span class="text-white/60">Short name <span class="text-white/40">(under the icon, up to 12 characters)</span></span>
            <input bind:value={shortName} maxlength="12" placeholder={a.effective.shortName} class={field} />
          </label>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-white/60">Display</span>
              <select bind:value={display} class={field}>
                <option value="">Default (standalone)</option>
                <option value="standalone">Standalone: its own window</option>
                <option value="fullscreen">Full screen</option>
                <option value="minimal-ui">Minimal browser controls</option>
              </select>
            </label>
            <label class="block">
              <span class="text-white/60">Orientation</span>
              <select bind:value={orientation} class={field}>
                <option value="">Any</option>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            {#each [{ label: "Theme color", get: () => themeColor, set: (v: string) => (themeColor = v), ph: a.effective.themeColor }, { label: "Background color", get: () => backgroundColor, set: (v: string) => (backgroundColor = v), ph: a.effective.backgroundColor }] as c (c.label)}
              <label class="block">
                <span class="text-white/60">{c.label}</span>
                <span class="mt-1 flex gap-2">
                  <input
                    type="color"
                    value={hex.test(c.get()) ? c.get() : c.ph}
                    oninput={(e) => c.set(e.currentTarget.value)}
                    class="h-8 w-10 rounded bg-transparent border border-white/15"
                    aria-label="{c.label}: pick"
                  />
                  <input value={c.get()} oninput={(e) => c.set(e.currentTarget.value)} placeholder={c.ph} maxlength="7" class="{field} mt-0" />
                </span>
              </label>
            {/each}
          </div>
          <label class="flex items-start gap-2">
            <input type="checkbox" bind:checked={iconMaskable} class="mt-1 accent-amber-500" />
            <span class="text-white/80"
              >The uploaded icon is maskable <span class="text-white/40">(its content stays in the central 80%, so Android may crop it to a circle)</span></span
            >
          </label>
        </fieldset>

        {#if error}<p class="text-red-400 break-words" role="alert">{error}</p>{/if}
        {#if saved && !error}<p class="text-emerald-300/80" role="status">Saved. Installed apps pick it up when they next update.</p>{/if}

        <div class="flex items-center justify-between gap-3 pt-1">
          {#if a.canEdit}
            <button type="button" class="text-white/60 hover:text-white" disabled={busy} onclick={() => act(() => api.resetApp(id))}
              >Reset everything</button
            >
            <button
              type="submit"
              disabled={busy}
              class="px-3 py-1.5 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-40"
              data-app-save>{busy ? "Saving…" : "Save"}</button
            >
          {:else}
            <span class="text-white/40">Only the page's editors change these.</span>
          {/if}
        </div>
      </form>
    {/if}
  </div>
</div>
