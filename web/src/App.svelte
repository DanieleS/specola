<script lang="ts">
  import Gallery from "./lib/Gallery.svelte";
  import Login from "./lib/Login.svelte";
  import Logo from "./lib/Logo.svelte";
  import PageViewer from "./lib/PageViewer.svelte";
  import PublishForm from "./lib/PublishForm.svelte";
  import { api, Unauthorized, UNAUTHORIZED_EVENT } from "./lib/api";

  type Route = { name: "list" } | { name: "new"; folderId: string | null } | { name: "view"; id: string };

  function parseHash(): Route {
    const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
    if (parts[0] === "p" && parts[1]) return { name: "view", id: parts[1] };
    if (parts[0] === "new") return { name: "new", folderId: parts[1] ?? null };
    return { name: "list" };
  }

  let route = $state<Route>(parseHash());
  let auth = $state<"loading" | "in" | "out">("loading");
  let authError = $state("");
  let email = $state("");

  api
    .me()
    .then((m) => {
      email = m.email || m.sub;
      auth = "in";
    })
    .catch((e) => {
      auth = "out";
      if (!(e instanceof Unauthorized)) authError = String(e);
    });

  addEventListener("hashchange", () => (route = parseHash()));
  addEventListener(UNAUTHORIZED_EVENT, () => (auth = "out"));
</script>

{#if auth === "out"}
  <Login error={authError} />
{:else if auth === "in"}
  <div class="min-h-screen flex flex-col">
    <header class="flex items-center justify-between px-5 h-14 border-b border-white/10">
      <a href="#/" class="flex items-center gap-2 font-semibold tracking-tight text-lg">
        <Logo class="w-5 h-5 text-amber-400" />
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
        <PublishForm folderId={route.folderId} />
      {:else}
        <Gallery />
      {/if}
    </main>
  </div>
{/if}
