<script lang="ts">
  import { tick } from "svelte";
  import { api, backendErrorMessage, type BackendLogLine } from "./api";

  // The backend log of a page (docs/page-backends.md, "Observability"), for
  // its owners and editors: what the runner keeps of its console output,
  // uncaught errors and crashes, polled while it is shown (the Log tab of
  // the Backend panel). focus asks to show the lines of an error's ref
  // (from the Jobs tab); n changes on every ask, so asking again for the
  // same ref scrolls to it again.
  let { id, focus = null }: { id: string; focus?: { ref: string; n: number } | null } = $props();

  const EVERY = 3000;
  const MAX = 1000; // as many as the runner keeps

  let lines = $state<BackendLogLine[]>([]);
  let error = $state("");
  let list = $state<HTMLElement>();
  // The ref asked for wasn't among the lines the runner still keeps.
  let notFound = $state("");
  // The first poll has answered: until then, no line is not "not found".
  let polled = $state(false);

  $effect(() => {
    const page = id;
    let since = 0;
    let live = true;
    let timer = 0;
    lines = [];
    error = "";
    polled = false;
    async function poll() {
      // A hidden tab doesn't need the lines; they are kept until it's back.
      if (!document.hidden) {
        try {
          const r = await api.backendLogs(page, since);
          if (!live) return;
          error = "";
          polled = true;
          const fresh = (r.lines ?? []).filter((l) => l.seq > since);
          if (fresh.length) {
            // Follow the end only for a reader who is there already.
            const atEnd = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 24;
            lines = [...lines, ...fresh].slice(-MAX);
            since = fresh[fresh.length - 1].seq;
            if (atEnd) {
              await tick();
              list?.scrollTo({ top: list.scrollHeight });
            }
          }
        } catch (e) {
          if (!live) return;
          error = backendErrorMessage(e);
        }
      }
      if (live) timer = window.setTimeout(poll, EVERY);
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  // Scrolls to the first line of the ref asked for once lines are there
  // (the first poll may still be on its way when the tab opens).
  // Once per ask: later polls must not pull the reader back there.
  let shownFocus = -1;
  $effect(() => {
    const f = focus;
    if (!f || f.n === shownFocus) return;
    const has = lines.some((l) => l.ref === f.ref);
    if (!has) {
      notFound = polled ? f.ref : "";
      return;
    }
    notFound = "";
    shownFocus = f.n;
    void tick().then(() => {
      const el = list?.querySelector(`[data-ref="${CSS.escape(f.ref)}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  });

  const time = (s: string) => {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleTimeString([], { hour12: false });
  };
  const levelClass: Record<string, string> = {
    error: "text-red-400",
    warn: "text-amber-400",
    info: "text-sky-300/80",
    log: "text-white/40",
  };
</script>

<div data-backend-log class="flex flex-col flex-1 min-h-0">
  <div class="flex items-center justify-between gap-3 px-4 pb-2 text-sm">
    <p class="text-xs text-white/40">Console output and errors of the backend, newest at the bottom.</p>
    <button class="shrink-0 text-white/50 hover:text-white/90 disabled:opacity-40" disabled={!lines.length} onclick={() => (lines = [])}
      >Clear</button
    >
  </div>
  {#if error}
    <p class="px-4 pb-2 text-sm text-red-400 break-words">{error}</p>
  {/if}
  {#if notFound}
    <p class="px-4 pb-2 text-xs text-white/50 break-words" role="status">
      Nothing about ref {notFound} is in the log any more: the runner keeps only its last 1000 lines, and none across its
      restarts.
    </p>
  {/if}
  <ol bind:this={list} class="flex-1 min-h-0 overflow-y-auto px-4 pb-4 font-mono text-xs leading-relaxed">
    {#each lines as l (l.seq)}
      <li
        class="py-0.5 border-b border-white/5 {focus && l.ref === focus.ref ? 'bg-amber-500/10' : ''}"
        data-level={l.level}
        data-ref={l.ref}
      >
        <span class="text-white/40">{time(l.time)}</span>
        <span class="uppercase {levelClass[l.level] ?? 'text-white/40'}">{l.level}</span>
        {#if l.ref}<span class="text-white/40" title="Named in the error the page got">ref {l.ref}</span>{/if}
        <div class="whitespace-pre-wrap break-words text-white/85">{l.text}</div>
      </li>
    {:else}
      {#if !error}
        <li class="py-2 font-sans text-sm text-white/40">
          Nothing yet. What the backend writes with <code>console</code>, and its errors, show here.
        </li>
      {/if}
    {/each}
  </ol>
</div>
