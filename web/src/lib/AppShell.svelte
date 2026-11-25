<script lang="ts">
  // A page installed as an app (docs/page-apps.md): the page alone, full
  // screen, at /app/{id}/. The server gave this document the app's head
  // (manifest, name, colors, icon); here the page is shown as in the viewer,
  // kept for offline, and pinned once the app is installed.
  import { untrack } from "svelte";
  import { api, HttpError, Unauthorized, UNAUTHORIZED_EVENT, type PageMeta } from "./api";
  import { refreshBackends } from "./backends.svelte";
  import InstallBanner from "./InstallBanner.svelte";
  import { install, standalone } from "./install.svelte";
  import * as offline from "./offline.svelte";
  import PageFrame from "./PageFrame.svelte";
  import { startSession } from "./session";

  let { id }: { id: string } = $props();

  let ready = $state(false);
  let meta = $state<PageMeta | null>(null);
  let error = $state("");
  let gone = $state(false);
  let superseded = $state(false);
  let reloads = $state(0);

  let kept = $derived(offline.index.pages[id]);
  let readOffline = $derived(!!meta && (meta.offline || !offline.net.online));
  // Offline, the current version if kept, else the latest kept.
  let shown = $derived(
    readOffline && kept && meta && !kept.versions.includes(meta.version) ? kept.versions.at(-1) : meta?.version,
  );
  // Installed: the page is saved for offline, never evicted.
  let pinned = $derived(standalone() || install.installed);

  // Signed out: sign in and come back here.
  function signIn() {
    location.href = "/auth/login?next=" + encodeURIComponent(location.pathname);
  }
  addEventListener(UNAUTHORIZED_EVENT, signIn);

  startSession()
    .then(() => {
      ready = true;
      load();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) return signIn();
      error = String(e);
    });

  async function load() {
    try {
      meta = await api.pageMeta(id);
    } catch (e) {
      if (e instanceof Unauthorized) return;
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {
        // Gone, or no longer shared: what this device keeps goes too.
        gone = true;
        await offline.remove(id).catch(() => {});
        return;
      }
      const k = offline.index.pages[id];
      if (k) meta = offline.keptMeta(k);
      else error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    if (meta?.backend && !readOffline) untrack(() => void refreshBackends());
  });

  // Online, keep what is shown for offline; pinned once installed.
  $effect(() => {
    const m = meta;
    const v = shown;
    const pin = pinned;
    if (!m || !v || readOffline) return;
    untrack(() => offline.keep(m, v, pin)).catch((e) => console.warn("keep offline:", e));
  });

  // The current version again, in a new frame.
  async function reload() {
    superseded = false;
    const before = shown;
    try {
      meta = await api.pageMeta(id);
      if (meta.version === before) reloads++;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="fixed inset-0 flex flex-col bg-[#0b0d12]">
  {#if gone}
    <div data-app-gone class="m-auto max-w-sm p-6 text-center">
      <p class="text-white/80">This page doesn't exist, or you no longer have access to it.</p>
      <a href="/" class="inline-block mt-4 text-amber-400 hover:text-amber-300">Open Specola</a>
    </div>
  {:else if error}
    <div class="m-auto max-w-sm p-6 text-center">
      <p class="text-red-400 break-words">{error}</p>
      <button class="mt-4 text-amber-400 hover:text-amber-300" onclick={() => location.reload()}>Try again</button>
    </div>
  {:else if ready && meta && shown}
    <div class="flex flex-1 min-h-0">
      <PageFrame
        {id}
        {meta}
        version={shown}
        {readOffline}
        bundle={offline.isBundle(id, shown) || (shown === meta.version && !!meta.bundle)}
        {reloads}
        onsuperseded={() => (superseded = true)}
      />
    </div>
    <InstallBanner name={meta.name} key={id} />
  {/if}

  {#if superseded}
    <div
      data-superseded
      role="status"
      class="fixed left-1/2 -translate-x-1/2 top-3 z-20 flex items-center gap-3 px-3 py-2 rounded-lg bg-[#0b0d12]/95 text-white text-sm shadow-lg ring-1 ring-white/10"
    >
      <span>A new version is available.</span>
      <button class="px-3 py-1 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400" onclick={reload}>Reload</button>
    </div>
  {/if}
</div>
