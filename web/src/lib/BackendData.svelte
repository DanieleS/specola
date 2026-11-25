<script lang="ts">
  import {
    api,
    backendErrorMessage,
    formatBytes,
    type BackendData,
    type PageMeta,
    type Snapshot,
  } from "./api";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { describeSnapshot, kindLabel, MAX_MANUAL_SNAPSHOTS } from "./snapshots";

  // A page's backend data (docs/page-backends.md, "Data lifecycle"), the Data
  // tab of the Backend panel. Owners and editors see how much room it takes
  // and its snapshots, and export it; owners snapshot, restore, import and
  // reset it. Anyone who can view the page downloads or deletes their own
  // data. ondatachange: the live data changed, so the page shown is stale.
  let { page, ondatachange }: { page: PageMeta; ondatachange: () => void } = $props();

  let owner = $derived(page.role === "owner");
  let canEdit = $derived(page.role === "owner" || page.role === "editor");

  let data = $state<BackendData | null>(null);
  let loading = $state(false);
  let error = $state("");
  // What the last action did, said until the next one.
  let done = $state("");
  let label = $state("");
  let taking = $state(false);
  let downloading = $state(false);
  let progress = $state<number | null>(null);
  let picker = $state<HTMLInputElement>();

  type Ask =
    | { kind: "restore"; snap: Snapshot }
    | { kind: "delete"; snap: Snapshot }
    | { kind: "import"; file: File }
    | { kind: "wipe"; scope: "shared" | "users" }
    | { kind: "my-data" };
  let ask = $state<Ask | null>(null);

  let manual = $derived(data?.snapshots.filter((s) => s.kind === "manual").length ?? 0);

  async function load() {
    if (!canEdit) return;
    loading = true;
    try {
      data = await api.backendData(page.id);
      error = "";
    } catch (e) {
      error = backendErrorMessage(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void page.id;
    data = null;
    done = "";
    void load();
  });

  async function takeSnapshot(e: SubmitEvent) {
    e.preventDefault();
    const l = label.trim();
    if (!l) return;
    taking = true;
    done = "";
    error = "";
    try {
      await api.createSnapshot(page.id, l);
      label = "";
      done = `Snapshot “${l}” taken.`;
      await load();
    } catch (err) {
      error = backendErrorMessage(err);
    } finally {
      taking = false;
    }
  }

  async function downloadMyData() {
    downloading = true;
    done = "";
    error = "";
    try {
      const blob = await api.myData(page.id);
      save(blob, `${fileTitle(page.name)}-my-data.sqlite`);
    } catch (e) {
      error = backendErrorMessage(e);
    } finally {
      downloading = false;
    }
  }

  // A file name from the page's title, as the server makes it for its own
  // downloads (here the blob comes without one).
  const fileTitle = (t: string) => t.trim().replace(/[\u0000-\u001f\u007f/\\"]/g, "_") || "page";

  function save(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function picked() {
    const file = picker?.files?.[0];
    if (picker) picker.value = "";
    if (file) ask = { kind: "import", file };
  }

  // Runs what the dialog asked for; it throws to have the dialog say why.
  async function run() {
    const a = ask;
    if (!a) return;
    switch (a.kind) {
      case "restore": {
        const r = await api.restoreSnapshot(page.id, a.snap.id);
        done = `Data restored from ${describeSnapshot(a.snap)}. What it replaced is kept as snapshot “${kindLabel(r.before.kind)}”, ${fmt(r.before.createdAt)}.`;
        ondatachange();
        break;
      }
      case "delete":
        await api.deleteSnapshot(page.id, a.snap.id);
        done = `Snapshot ${describeSnapshot(a.snap)} deleted.`;
        break;
      case "import": {
        progress = 0;
        try {
          await api.importBackend(page.id, a.file, (f) => (progress = f));
        } finally {
          progress = null;
        }
        done = `Imported ${a.file.name}. The data it replaced is kept as a snapshot (“${kindLabel("before-import")}”).`;
        ondatachange();
        break;
      }
      case "wipe":
        await api.wipeBackend(page.id, a.scope);
        done = `${a.scope === "shared" ? "Shared data and files" : "Every user's data"} reset. What was there is kept as a snapshot (“${kindLabel("before-wipe")}”).`;
        ondatachange();
        break;
      case "my-data":
        await api.deleteMyData(page.id);
        done = "Your data on this page is deleted.";
        ondatachange();
        break;
    }
  }

  function closeAsk(ok: boolean) {
    ask = null;
    if (ok) {
      error = "";
      void load();
    }
  }

  const fmt = (s: string) => new Date(s).toLocaleString();
  const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { dateStyle: "long" });
  const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
  const barColor = (p: number) => (p >= 99 ? "bg-red-500" : p >= 90 ? "bg-amber-500" : "bg-emerald-400/70");
  const btn = "text-sm px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 disabled:opacity-40";
  const danger = "text-sm px-3 py-1.5 rounded-md border border-red-400/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40";
  const section = "px-4 py-3 border-t border-white/10";
  const heading = "text-xs font-semibold uppercase tracking-wide text-white/50 mb-2";
</script>

<div data-backend-data class="flex-1 min-h-0 overflow-y-auto pb-6">
  {#if page.backendPurgeAt}
    <p data-purge-notice class="mx-4 mb-3 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      This page's backend data will be deleted on <strong>{fmtDate(page.backendPurgeAt)}</strong>, with its snapshots: the page
      has had no backend for a long time.
      {#if canEdit}Export it to keep a copy, or publish a version with a backend to keep it here.{/if}
    </p>
  {/if}
  {#if !page.backend}
    <p class="px-4 pb-3 text-xs text-white/50">
      The current version has no backend: this data is kept, unused, for a version that has one.
    </p>
  {/if}

  {#if error}<p class="px-4 pb-3 text-sm text-red-400 break-words" role="alert">{error}</p>{/if}
  {#if done}<p class="px-4 pb-3 text-sm text-emerald-300 break-words" role="status">{done}</p>{/if}

  {#if canEdit}
    <section class={section} aria-label="Usage">
      <h3 class={heading}>Usage</h3>
      {#if data}
        {@const u = data.usage}
        {#each [{ name: "Data", used: u.pageBytes, limit: u.pageLimit }, { name: "Snapshots", used: u.snapshotBytes, limit: u.snapshotLimit }] as m (m.name)}
          {@const p = pct(m.used, m.limit)}
          <div class="mb-2" data-usage={m.name.toLowerCase()}>
            <div class="flex justify-between text-xs text-white/60">
              <span>{m.name}</span><span>{formatBytes(m.used)} of {formatBytes(m.limit)}</span>
            </div>
            <div
              class="mt-1 h-1.5 rounded bg-white/10 overflow-hidden"
              role="meter"
              aria-label="{m.name} used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(p)}
            >
              <div class="h-full {barColor(p)}" style="width: {p}%"></div>
            </div>
          </div>
        {/each}
      {:else if loading}
        <p class="text-sm text-white/40">Loading…</p>
      {/if}
      <div class="mt-3 flex flex-wrap gap-2">
        <a
          class={btn}
          href={api.backendExportUrl(page.id)}
          download
          title="A zip of the shared database and the files; users' own data isn't in it">Export</a
        >
        {#if owner}
          <button class={btn} onclick={() => picker?.click()}>Import…</button>
          <input bind:this={picker} type="file" accept=".zip,application/zip" class="hidden" onchange={picked} />
        {/if}
      </div>
    </section>

    <section class={section} aria-label="Snapshots">
      <h3 class={heading}>Snapshots</h3>
      {#if owner}
        <form class="flex gap-2 mb-1" onsubmit={takeSnapshot}>
          <input
            bind:value={label}
            maxlength={100}
            placeholder="Label, e.g. before the migration"
            aria-label="Snapshot label"
            class="flex-1 min-w-0 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm focus:outline-none focus:border-white/40"
          />
          <button type="submit" class={btn + " shrink-0"} disabled={taking || !label.trim()}
            >{taking ? "Taking…" : "Take snapshot"}</button
          >
        </form>
        <p class="text-xs text-white/40 mb-3">{manual} of {MAX_MANUAL_SNAPSHOTS} manual snapshots. Automatic ones go by themselves.</p>
      {/if}
      {#if data}
        <ul class="divide-y divide-white/5">
          {#each data.snapshots as s (s.id)}
            <li class="py-2 text-sm" data-snapshot={s.id} data-kind={s.kind}>
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2">
                    <span class="text-[10px] uppercase tracking-wide text-white/50 border border-white/15 rounded px-1.5"
                      >{kindLabel(s.kind)}</span
                    >
                    {#if s.kind === "manual" && s.label}<span class="break-words">{s.label}</span>{/if}
                    {#if s.kind === "version" && s.version}<span>as v{s.version} left it</span>{/if}
                  </div>
                  <div class="text-xs text-white/40">{fmt(s.createdAt)} · {formatBytes(s.sizeBytes)}</div>
                </div>
                {#if owner}
                  <div class="flex shrink-0 gap-3 text-xs">
                    <button class="text-amber-400 hover:text-amber-300" onclick={() => (ask = { kind: "restore", snap: s })}
                      >Restore</button
                    >
                    {#if s.kind === "manual"}
                      <button
                        class="text-white/50 hover:text-red-300"
                        aria-label="Delete snapshot {s.label ?? s.id}"
                        onclick={() => (ask = { kind: "delete", snap: s })}>Delete</button
                      >
                    {/if}
                  </div>
                {/if}
              </div>
            </li>
          {:else}
            <li class="py-2 text-sm text-white/40">No snapshots yet.</li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if owner}
      <section class={section} aria-label="Reset">
        <h3 class={heading}>Reset</h3>
        <p class="text-xs text-white/40 mb-2">Each takes a snapshot first, so it can be undone.</p>
        <div class="flex flex-wrap gap-2">
          <button class={danger} onclick={() => (ask = { kind: "wipe", scope: "shared" })}>Reset shared data and files…</button>
          <button class={danger} onclick={() => (ask = { kind: "wipe", scope: "users" })}>Reset every user's data…</button>
        </div>
      </section>
    {/if}
  {/if}

  <section class={section} aria-label="My data">
    <h3 class={heading}>My data</h3>
    <p class="text-xs text-white/40 mb-2">What this page's backend keeps for you alone, as a SQLite database.</p>
    <div class="flex flex-wrap gap-2">
      <button class={btn} disabled={downloading} onclick={downloadMyData}>{downloading ? "Downloading…" : "Download my data"}</button>
      <button class={danger} onclick={() => (ask = { kind: "my-data" })}>Delete my data…</button>
    </div>
  </section>
</div>

{#if ask?.kind === "restore"}
  <ConfirmDialog title="Restore this snapshot?" confirmLabel="Restore data" {run} onclose={closeAsk}>
    <p>Restore the data from <strong>{describeSnapshot(ask.snap)}</strong>, {fmt(ask.snap.createdAt)}.</p>
    <p>
      This replaces <strong>all</strong> of this page's backend data with the snapshot's: the shared data, the files and
      <strong>every user's own data</strong>. What was written since is no longer live.
    </p>
    <p class="text-white/50">
      A snapshot of the data as it is now is taken first (“{kindLabel("before-restore")}”), so you can go back. The page is
      briefly offline while it runs.
    </p>
  </ConfirmDialog>
{:else if ask?.kind === "delete"}
  <ConfirmDialog title="Delete this snapshot?" confirmLabel="Delete" danger {run} onclose={closeAsk}>
    <p>Delete the snapshot <strong>{describeSnapshot(ask.snap)}</strong>, {fmt(ask.snap.createdAt)}? This can't be undone.</p>
    <p class="text-white/50">The page's live data isn't touched.</p>
  </ConfirmDialog>
{:else if ask?.kind === "import"}
  <ConfirmDialog title="Import data?" confirmLabel="Import" {progress} {run} onclose={closeAsk}>
    <p>Import <strong class="break-words">{ask.file.name}</strong> ({formatBytes(ask.file.size)}).</p>
    <p>
      This replaces this page's <strong>shared data and files</strong> with the zip's. Every user's own data is kept. The zip
      must be an export from Specola; if anything in it is wrong, nothing changes.
    </p>
    <p class="text-white/50">
      A snapshot of the data as it is now is taken first (“{kindLabel("before-import")}”), so you can go back.
    </p>
  </ConfirmDialog>
{:else if ask?.kind === "wipe"}
  <ConfirmDialog
    title={ask.scope === "shared" ? "Reset shared data and files?" : "Reset every user's data?"}
    confirmLabel="Reset"
    danger
    typeToConfirm={page.name}
    {run}
    onclose={closeAsk}
  >
    {#if ask.scope === "shared"}
      <p>This deletes the page's <strong>shared database and every file</strong> its backend stored. Users' own data is kept.</p>
    {:else}
      <p>
        This deletes <strong>every user's own data</strong> on this page (what the backend keeps for each of them). The shared
        data and files are kept.
      </p>
    {/if}
    <p class="text-white/50">A snapshot is taken first (“{kindLabel("before-wipe")}”): restoring it undoes this.</p>
  </ConfirmDialog>
{:else if ask?.kind === "my-data"}
  <ConfirmDialog title="Delete your data?" confirmLabel="Delete my data" danger {run} onclose={closeAsk}>
    <p>
      This deletes what this page's backend keeps for <strong>you alone</strong>. The page's shared data, and other people's,
      isn't touched.
    </p>
    <p class="text-white/50">No snapshot is taken: it can't be undone. Download it first to keep a copy.</p>
  </ConfirmDialog>
{/if}
