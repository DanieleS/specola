<script lang="ts">
  import type { Snippet } from "svelte";
  import { backendErrorMessage } from "./api";

  // Asks before doing something that can't be taken back lightly, then does
  // it, saying what went wrong in place so the reader can retry or cancel.
  // For the worst of them, the reader types a word (the page's title) first:
  // a click alone is too easy to make by mistake.
  let {
    title,
    confirmLabel,
    danger = false,
    typeToConfirm = "",
    progress = null,
    run,
    onclose,
    children,
  }: {
    title: string;
    confirmLabel: string;
    /** Red rather than amber: it destroys something. */
    danger?: boolean;
    /** Text the reader must type before confirming. */
    typeToConfirm?: string;
    /** 0–1 while run reports how far it got (an upload); null otherwise. */
    progress?: number | null;
    run: () => Promise<void>;
    /** done: run finished without an error. */
    onclose: (done: boolean) => void;
    children: Snippet;
  } = $props();

  let typed = $state("");
  let busy = $state(false);
  let error = $state("");
  let ready = $derived(!typeToConfirm || typed.trim() === typeToConfirm.trim());

  async function confirm(e: SubmitEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    busy = true;
    error = "";
    try {
      await run();
      onclose(true);
    } catch (err) {
      error = backendErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  // Not while it runs: closing would hide how it ended.
  const close = () => !busy && onclose(false);
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && close()}
>
  <div
    class="w-full max-w-md max-h-full overflow-y-auto rounded-lg border border-white/10 bg-[#12151c] p-5 shadow-xl"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    data-confirm-dialog
  >
    <form onsubmit={confirm}>
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 id="confirm-title" class="font-semibold">{title}</h2>
        <button type="button" class="text-white/50 hover:text-white/90 disabled:opacity-40" aria-label="Close" disabled={busy} onclick={close}
          >✕</button
        >
      </div>

      <div class="space-y-2 text-sm text-white/75">{@render children()}</div>

      {#if typeToConfirm}
        <label class="block mt-4 text-sm">
          <span class="text-white/60">Type <strong class="text-white/90 break-words">{typeToConfirm}</strong> to confirm</span>
          <input
            bind:value={typed}
            autocomplete="off"
            spellcheck="false"
            disabled={busy}
            class="mt-1 w-full rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm focus:outline-none focus:border-white/40"
          />
        </label>
      {/if}

      {#if busy && progress !== null}
        <div class="mt-4" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div class="h-1.5 rounded bg-white/10 overflow-hidden">
            <div class="h-full bg-amber-500 transition-[width]" style="width: {Math.round(progress * 100)}%"></div>
          </div>
          <p class="mt-1 text-xs text-white/50">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Uploaded; checking and importing…"}
          </p>
        </div>
      {/if}

      {#if error}<p class="mt-3 text-sm text-red-400 break-words" role="alert">{error}</p>{/if}

      <div class="mt-5 flex items-center justify-end gap-3">
        <button type="button" class="text-sm text-white/60 hover:text-white disabled:opacity-40" disabled={busy} onclick={close}
          >Cancel</button
        >
        <button
          type="submit"
          disabled={!ready || busy}
          class="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-40 {danger
            ? 'bg-red-500 text-white hover:bg-red-400'
            : 'bg-amber-500 text-black hover:bg-amber-400'}">{busy ? "Working…" : confirmLabel}</button
        >
      </div>
    </form>
  </div>
</div>
