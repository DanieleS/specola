<script lang="ts">
  import { backendErrorMessage, MAX_SECRET_BYTES, SECRET_NAME, secretsApi, type PageMeta, type SecretInfo } from "./api";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  // A page's secrets (docs/page-backends.md, "Secrets"), the Secrets tab of
  // the Backend panel: the names the current version declares, and any set
  // but no longer declared, with whether each has a value. Owners set,
  // replace and remove values; editors see the list only. A value is never
  // shown: the server can't send one back, and what is typed here is cleared
  // as soon as it is saved. onmissing: the declared names without a value,
  // after each load, so the viewer's notice follows what is done here.
  let { page, onmissing }: { page: PageMeta; onmissing?: (names: string[]) => void } = $props();

  let owner = $derived(page.role === "owner");

  let secrets = $state<SecretInfo[] | null>(null);
  let loading = $state(false);
  let error = $state("");
  let done = $state("");

  // The row whose value is being typed (a name in the list), or "+" for a
  // new name; one at a time.
  let editing = $state<string | null>(null);
  let newName = $state("");
  let value = $state("");
  let saving = $state(false);
  let formError = $state("");
  let removing = $state<SecretInfo | null>(null);

  async function load() {
    loading = true;
    try {
      const r = await secretsApi.list(page.id);
      secrets = r.secrets ?? [];
      error = "";
      onmissing?.(secrets.filter((s) => s.declared && !s.set).map((s) => s.name));
    } catch (e) {
      error = backendErrorMessage(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void page.id;
    // A new version may declare other names.
    void page.version;
    secrets = null;
    done = "";
    cancel();
    void load();
  });

  function edit(name: string) {
    editing = name;
    newName = "";
    value = "";
    formError = "";
    done = "";
  }

  function cancel() {
    editing = null;
    newName = "";
    value = "";
    formError = "";
  }

  const bytes = (s: string) => new TextEncoder().encode(s).length;

  // Says what is wrong before the server does: the same rules.
  function invalid(name: string, v: string): string {
    if (!SECRET_NAME.test(name))
      return "A name is an upper-case letter, then up to 63 upper-case letters, digits or underscores (like API_KEY).";
    if (!v) return "Type the value.";
    if (bytes(v) > MAX_SECRET_BYTES) return "A value can be at most 8 KB.";
    return "";
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const name = editing === "+" ? newName.trim() : editing;
    if (!name || saving) return;
    const why = invalid(name, value);
    if (why) {
      formError = why;
      return;
    }
    const replaced = !!secrets?.find((s) => s.name === name)?.set;
    saving = true;
    formError = "";
    try {
      await secretsApi.set(page.id, name, value);
      // The value is the server's alone from here: nothing keeps it.
      cancel();
      done = `${name} ${replaced ? "replaced" : "set"}. The backend gets it from its next call.`;
      await load();
    } catch (err) {
      formError = backendErrorMessage(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const s = removing;
    if (!s) return;
    await secretsApi.remove(page.id, s.name);
    done = `${s.name} removed.`;
  }

  function closeRemove(ok: boolean) {
    removing = null;
    if (ok) {
      error = "";
      void load();
    }
  }

  const fmt = (s: string) => new Date(s).toLocaleString();
  const btn = "text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 disabled:opacity-40";
  const input =
    "min-w-0 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm focus:outline-none focus:border-white/40";
  const badge = "text-[10px] uppercase tracking-wide rounded px-1.5 border";
</script>

{#snippet valueForm(label: string)}
  <form class="mt-2 flex flex-col gap-2" onsubmit={save} data-secret-form>
    {#if editing === "+"}
      <input
        bind:value={newName}
        placeholder="NAME, e.g. API_KEY"
        aria-label="Secret name"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength={64}
        class="{input} font-mono"
        oninput={() => (newName = newName.toUpperCase())}
      />
    {/if}
    <!-- A password field: not shown on screen, and not kept by the form. -->
    <input
      bind:value
      type="password"
      placeholder="Value"
      aria-label="Secret value"
      autocomplete="new-password"
      spellcheck="false"
      class="{input} font-mono"
    />
    {#if formError}<p class="text-sm text-red-400 break-words" role="alert">{formError}</p>{/if}
    <div class="flex items-center gap-3">
      <button type="submit" class="px-3 py-1.5 rounded-md text-sm font-medium bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40" disabled={saving || !value}
        >{saving ? "Saving…" : label}</button
      >
      <button type="button" class="text-sm text-white/60 hover:text-white disabled:opacity-40" disabled={saving} onclick={cancel}
        >Cancel</button
      >
    </div>
  </form>
{/snippet}

<div data-backend-secrets class="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
  <p class="pb-3 text-xs text-white/40">
    Values the backend reads as <code>ctx.secrets</code>, like API keys. Nobody can read one back here: it can only be
    replaced or removed.
    {#if owner}Editors see the names only, but the code they publish can read the values.{:else}Only the page's owners set them.{/if}
  </p>

  {#if error}<p class="pb-3 text-sm text-red-400 break-words" role="alert">{error}</p>{/if}
  {#if done}<p class="pb-3 text-sm text-emerald-300 break-words" role="status">{done}</p>{/if}

  {#if secrets}
    <ul class="divide-y divide-white/5 border-y border-white/5">
      {#each secrets as s (s.name)}
        <li class="py-2 text-sm" data-secret={s.name} data-set={s.set} data-declared={s.declared}>
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-mono break-all">{s.name}</span>
                {#if s.set}
                  <span class="{badge} text-emerald-300/80 border-emerald-300/30">set</span>
                {:else}
                  <span class="{badge} text-amber-400/90 border-amber-400/40">not set</span>
                {/if}
                {#if !s.declared}
                  <span
                    class="{badge} text-white/50 border-white/15"
                    title="The current version doesn't declare it, so its backend doesn't get it">not declared</span
                  >
                {/if}
              </div>
              {#if s.set && (s.updatedAt || s.updatedBy)}
                <div class="text-xs text-white/40 break-words">
                  {s.updatedAt ? `Set ${fmt(s.updatedAt)}` : "Set"}{s.updatedBy ? ` by ${s.updatedBy}` : ""}
                </div>
              {:else if !s.set && s.declared}
                <div class="text-xs text-white/40">
                  The backend declares it: what needs it fails until {owner ? "you set it" : "an owner sets it"}.
                </div>
              {/if}
            </div>
            {#if owner && editing !== s.name}
              <div class="flex shrink-0 gap-3 text-xs">
                <button class="text-amber-400 hover:text-amber-300" aria-label="{s.set ? 'Replace' : 'Set'} {s.name}" onclick={() => edit(s.name)}
                  >{s.set ? "Replace" : "Set"}</button
                >
                {#if s.set}
                  <button class="text-white/50 hover:text-red-300" aria-label="Remove {s.name}" onclick={() => (removing = s)}
                    >Remove</button
                  >
                {/if}
              </div>
            {/if}
          </div>
          {#if editing === s.name}
            {@render valueForm(s.set ? "Replace" : "Set")}
          {/if}
        </li>
      {:else}
        <li class="py-2 text-sm text-white/40">
          The current version declares no secrets. A backend declares the names it needs in its manifest's <code>secrets</code>.
        </li>
      {/each}
    </ul>
  {:else if loading}
    <p class="text-sm text-white/40">Loading…</p>
  {/if}

  {#if owner && secrets}
    <div class="pt-3">
      {#if editing === "+"}
        <p class="text-xs text-white/40">
          A name the current version doesn't declare is kept for a version that does; until then the backend doesn't get it.
        </p>
        {@render valueForm("Set")}
      {:else}
        <button class={btn} onclick={() => edit("+")}>Add a secret…</button>
      {/if}
    </div>
  {/if}
</div>

{#if removing}
  <ConfirmDialog title="Remove {removing.name}?" confirmLabel="Remove" danger run={remove} onclose={closeRemove}>
    <p>Remove the value of <strong class="font-mono break-all">{removing.name}</strong>? It can't be read back, so it can't be undone: to have it again, set it again.</p>
    {#if removing.declared}
      <p class="text-white/50">The backend declares it: what needs it fails until it is set again.</p>
    {/if}
  </ConfirmDialog>
{/if}
