<script lang="ts">
  import Gallery from "./lib/Gallery.svelte";
  import PageViewer from "./lib/PageViewer.svelte";
  import PublishForm from "./lib/PublishForm.svelte";
  import { api } from "./lib/api";

  type Route = { name: "list" } | { name: "new" } | { name: "view"; id: string };

  function parseHash(): Route {
    const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
    if (parts[0] === "p" && parts[1]) return { name: "view", id: parts[1] };
    if (parts[0] === "new") return { name: "new" };
    return { name: "list" };
  }

  let route = $state<Route>(parseHash());
  let email = $state("");

  api.me().then((m) => (email = m.email)).catch(() => {});
  addEventListener("hashchange", () => (route = parseHash()));
</script>

<div class="min-h-screen flex flex-col">
  <header class="flex items-center justify-between px-5 h-14 border-b border-white/10">
    <a href="#/" class="flex items-center gap-2 font-semibold tracking-tight text-lg">
      <span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-400"></span>
      Specola
    </a>
    <div class="flex items-center gap-4 text-sm">
      <a href="#/new" class="px-3 py-1.5 rounded-md bg-amber-500 text-black font-medium hover:bg-amber-400">
        New page
      </a>
      {#if email}<span class="text-white/50 hidden sm:inline">{email}</span>{/if}
      <a href="/auth/logout" class="text-white/50 hover:text-white/80">Logout</a>
    </div>
  </header>

  <main class="flex-1">
    {#if route.name === "view"}
      <PageViewer id={route.id} />
    {:else if route.name === "new"}
      <PublishForm />
    {:else}
      <Gallery />
    {/if}
  </main>
</div>
