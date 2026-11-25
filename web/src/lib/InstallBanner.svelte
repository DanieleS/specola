<script lang="ts">
  // Offers to install the page app this tab shows (docs/page-apps.md,
  // "SPA"): the browser's own prompt where it has one, the Share menu's "Add
  // to Home Screen" on iOS. Never shown in the installed app, nor once
  // dismissed.
  import { install, ios, standalone } from "./install.svelte";

  let { name, key }: { name: string; key: string } = $props();

  const storageKey = $derived(`specola:install-dismissed:${key}`);
  let dismissed = $state(false);
  $effect(() => {
    try {
      dismissed = localStorage.getItem(storageKey) === "1";
    } catch {
      dismissed = false;
    }
  });
  const onIOS = ios();
  let show = $derived(!standalone() && !dismissed && !install.installed && (!!install.prompt || onIOS));

  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Not remembered: shown again next time.
    }
  }

  async function prompt() {
    const p = install.prompt;
    if (!p) return;
    install.prompt = null;
    await p.prompt();
  }
</script>

{#if show}
  <div
    data-install-banner
    role="region"
    aria-label="Install"
    class="fixed left-1/2 -translate-x-1/2 bottom-3 z-20 w-[calc(100%-2rem)] max-w-md flex items-center gap-3 px-3 py-2 rounded-lg bg-[#0b0d12]/95 text-white text-sm shadow-lg ring-1 ring-white/10"
  >
    <span class="flex-1 min-w-0">
      {#if install.prompt}
        Install <strong class="font-medium">{name}</strong> as an app on this device.
      {:else}
        To install <strong class="font-medium">{name}</strong>, tap Share, then “Add to Home Screen”.
      {/if}
    </span>
    {#if install.prompt}
      <button class="shrink-0 px-3 py-1 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400" onclick={prompt}
        >Install</button
      >
    {/if}
    <button class="shrink-0 text-white/60 hover:text-white" aria-label="Dismiss" onclick={dismiss}>✕</button>
  </div>
{/if}
