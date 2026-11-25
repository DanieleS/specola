<script lang="ts">
  import { tick } from "svelte";
  import { api, backendErrorMessage, type BackendLogLine } from "./api";

  // The backend log of a page (docs/page-backends.md, "Observability"), for
  // its owners and editors: what the runner keeps of its console output,
  // uncaught errors and crashes, polled while it is shown (the Log tab of
  // the Backend panel).
  let { id }: { id: string } = $props();

  const EVERY = 3000;
  const MAX = 1000; // as many as the runner keeps

  let lines = $state<BackendLogLine[]>([]);
  let error = $state("");
  let list = $state<HTMLElement>();

  $effect(() => {
    const page = id;
    let since = 0;
    let live = true;
    let timer = 0;
    lines = [];
    error = "";
    async function poll() {
      // A hidden tab doesn't need the lines; they are kept until it's back.
      if (!document.hidden) {
        try {
          const r = await api.backendLogs(page, since);
          if (!live) return;
          error = "";
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
  <ol bind:this={list} class="flex-1 min-h-0 overflow-y-auto px-4 pb-4 font-mono text-xs leading-relaxed">
    {#each lines as l (l.seq)}
      <li class="py-0.5 border-b border-white/5" data-level={l.level}>
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
