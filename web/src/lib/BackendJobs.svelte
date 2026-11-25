<script lang="ts" module>
  // A plain-words reading of the common five-field schedules (UTC), shown
  // next to the schedule itself; "" for the others, which are shown as they
  // are. Only what is sure is said: anything unusual gets no hint rather
  // than a wrong one.
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  // A single value of a field: a number, or a name where the field has them.
  function num(v: string, min: number, max: number, names?: string[]): number | null {
    const i = names?.indexOf(v.toLowerCase()) ?? -1;
    if (i >= 0) return min + i;
    if (!/^\d{1,2}$/.test(v)) return null;
    const n = Number(v);
    return n >= min && n <= max ? n : null;
  }

  // A list of single values (no ranges or steps), or null.
  function nums(f: string, min: number, max: number, names?: string[]): number[] | null {
    const out: number[] = [];
    for (const p of f.split(",")) {
      const n = num(p, min, max, names);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  }

  const two = (n: number) => String(n).padStart(2, "0");
  const ordinal = (n: number) => {
    const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
    return `${n}${s}`;
  };
  const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

  // The days of week of a dow field, as words: "Monday", "weekdays",
  // "Monday and Friday", "Monday to Wednesday"; null when it can't say.
  function days(f: string): string | null {
    const range = /^(\w+)-(\w+)$/.exec(f);
    if (range) {
      const a = num(range[1], 0, 7, DAY_NAMES);
      const b = num(range[2], 0, 7, DAY_NAMES);
      if (a === null || b === null || a > b) return null;
      if (a === 1 && b === 5) return "weekdays";
      if (a === 0 && b === 6) return "every day";
      return `${DAYS[a % 7]} to ${DAYS[b % 7]}`;
    }
    const list = nums(f, 0, 7, DAY_NAMES);
    if (!list) return null;
    const set = [...new Set(list.map((d) => d % 7))].sort();
    if (set.join() === "0,6") return "weekends";
    return and(set.map((d) => DAYS[d]));
  }

  export function describeSchedule(schedule: string): string {
    const f = schedule.trim().split(/\s+/);
    if (f.length !== 5) return "";
    const [mi, h, dom, mon, dow] = f;
    const minute = num(mi, 0, 59);

    // Below the hour: every minute, every N minutes.
    if (h === "*" && dom === "*" && mon === "*" && dow === "*") {
      if (mi === "*") return "every minute";
      const step = /^\*\/(\d+)$/.exec(mi);
      // */7 restarts at each hour (…, :49, :56, :00): "every 7 minutes" only for a divisor of 60.
      if (step) {
        const n = Number(step[1]);
        return n === 1 ? "every minute" : 60 % n === 0 ? `every ${n} minutes` : "";
      }
      if (minute !== null) return minute === 0 ? "every hour, on the hour" : `every hour at :${two(minute)}`;
      return "";
    }
    if (minute === null) return "";

    // Every N hours, at a minute.
    const hourStep = /^\*\/(\d+)$/.exec(h);
    if (hourStep && dom === "*" && mon === "*" && dow === "*") {
      const n = Number(hourStep[1]);
      if (24 % n !== 0) return ""; // as for minutes: it restarts at midnight
      return n === 1 ? `every hour at :${two(minute)}` : `every ${n} hours at :${two(minute)} UTC`;
    }

    // At given times of day.
    const hours = nums(h, 0, 23);
    if (!hours) return "";
    const at = `at ${and(hours.map((x) => `${two(x)}:${two(minute)}`))} UTC`;

    if (mon === "*" && dom === "*") {
      if (dow === "*") return `every day ${at}`;
      const d = days(dow);
      if (!d) return "";
      return d === "every day" ? `every day ${at}` : `${d === "weekdays" || d === "weekends" ? "on" : "every"} ${d} ${at}`;
    }
    if (dow !== "*") return ""; // day of month OR day of week: too subtle for a hint
    const doms = nums(dom, 1, 31);
    if (!doms) return "";
    const on = `on the ${and(doms.map(ordinal))}`;
    if (mon === "*") return `every month ${on} ${at}`;
    const months = nums(mon, 1, 12, MONTH_NAMES);
    if (!months) return "";
    return `every year on ${and(months.map((m) => MONTHS[m - 1]))} ${and(doms.map(String))} ${at}`;
  }
</script>

<script lang="ts">
  import { backendErrorMessage, secretsApi, type CronJob } from "./api";

  // A page's scheduled jobs (docs/page-backends.md, "Scheduled jobs"), the
  // Jobs tab of the Backend panel, for its owners and editors: what the
  // current version declares, when each runs next and how it last ended.
  // A failed run names a ref; onref shows its lines in the Log tab.
  let { id, onref }: { id: string; onref?: (ref: string) => void } = $props();

  // Jobs run at most once a minute and the ticker every 30 s: more often
  // would show nothing new.
  const EVERY = 30_000;

  let jobs = $state<CronJob[] | null>(null);
  let error = $state("");
  let loading = $state(false);
  // Re-renders the relative times ("in 3 min") without asking the server.
  let now = $state(Date.now());

  async function load(page: string) {
    loading = true;
    try {
      const r = await secretsApi.cron(page);
      if (page !== id) return;
      jobs = r.jobs ?? [];
      error = "";
    } catch (e) {
      if (page === id) error = backendErrorMessage(e);
    } finally {
      loading = false;
      now = Date.now();
    }
  }

  $effect(() => {
    const page = id;
    jobs = null;
    error = "";
    void load(page);
    const poll = window.setInterval(() => !document.hidden && void load(page), EVERY);
    const clock = window.setInterval(() => (now = Date.now()), 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  });

  // The ref of a failed run, which the log names its lines by
  // ("message (ref r…)", or the ref alone).
  function refOf(err: string | undefined): string {
    if (!err) return "";
    const m = /\(ref ([^\s()]+)\)\s*$/.exec(err) ?? /^ref ([^\s()]+)$/.exec(err.trim());
    return m ? m[1] : "";
  }
  // The message without its ref, which is shown as a link.
  const messageOf = (err: string) => err.replace(/\s*\(ref [^\s()]+\)\s*$/, "").replace(/^ref [^\s()]+$/, "");

  const statusLabel: Record<string, string> = {
    ok: "ok",
    error: "error",
    timeout: "timed out",
    "no-handler": "no handler",
    unavailable: "runner unavailable",
    skipped: "skipped",
  };
  const statusClass = (s: string) =>
    s === "ok"
      ? "text-emerald-300/80 border-emerald-300/30"
      : s === "error" || s === "timeout"
        ? "text-red-300 border-red-400/40"
        : s === "no-handler"
          ? "text-amber-400/90 border-amber-400/40"
          : "text-white/50 border-white/15";
  const statusTitle: Record<string, string> = {
    "no-handler": "The backend's default export has no scheduled(event, ctx) method",
    unavailable: "The backend runner couldn't be reached when it was due",
    skipped: "Not run: the page was archived or the runner unavailable",
    timeout: "Not finished within the 5-minute limit",
  };

  // "in 3 min", "2 h ago": next to the full date, which is in the title.
  function relative(s: string, at: number): string {
    const t = new Date(s).getTime();
    if (isNaN(t)) return s;
    const d = t - at;
    const a = Math.abs(d);
    if (a < 60_000) return d >= 0 ? "within a minute" : "just now";
    const min = Math.round(a / 60_000);
    const h = Math.round(a / 3_600_000);
    const unit = min < 60 ? `${min} min` : h < 24 ? `${h} h` : `${Math.round(a / 86_400_000)} d`;
    return d >= 0 ? `in ${unit}` : `${unit} ago`;
  }
  const fmt = (s: string) => new Date(s).toLocaleString();
  const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
  const badge = "text-[10px] uppercase tracking-wide rounded px-1.5 border";
</script>

<div data-backend-jobs class="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
  <div class="flex items-start justify-between gap-3 pb-3">
    <p class="text-xs text-white/40">
      What the backend's <code>scheduled(event, ctx)</code> runs on the schedules its manifest declares. Times are UTC; a run
      missed while Specola was down isn't caught up.
    </p>
    <button class="shrink-0 text-sm text-white/50 hover:text-white/90 disabled:opacity-40" disabled={loading} onclick={() => load(id)}
      >Refresh</button
    >
  </div>

  {#if error}<p class="pb-3 text-sm text-red-400 break-words" role="alert">{error}</p>{/if}

  {#if jobs}
    <ul class="divide-y divide-white/5 border-y border-white/5">
      {#each jobs as j (j.name)}
        {@const hint = describeSchedule(j.schedule)}
        {@const ref = refOf(j.lastError)}
        <li class="py-2.5 text-sm" data-job={j.name} data-status={j.lastStatus ?? ""}>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="font-medium break-all">{j.name}</span>
            {#if j.lastStatus}
              <span class="{badge} {statusClass(j.lastStatus)}" title={statusTitle[j.lastStatus] ?? ""} data-job-status
                >{statusLabel[j.lastStatus] ?? j.lastStatus}</span
              >
            {:else}
              <span class="{badge} text-white/40 border-white/10" data-job-status>not run yet</span>
            {/if}
          </div>
          <div class="mt-0.5 text-xs text-white/60">
            <code class="text-white/80">{j.schedule}</code>{#if hint}<span class="text-white/50" data-schedule-hint>{` · ${hint}`}</span>{/if}
          </div>
          <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-white/50">
            <dt>Next</dt>
            <dd class="text-white/70">
              {#if j.nextRunAt}
                <span title={fmt(j.nextRunAt)}>{relative(j.nextRunAt, now)}</span>
                <span class="text-white/40">· {fmt(j.nextRunAt)}</span>
              {:else}
                <span>not scheduled</span>
              {/if}
            </dd>
            <dt>Last</dt>
            <dd class="text-white/70">
              {#if j.lastRunAt}
                <span title={fmt(j.lastRunAt)}>{relative(j.lastRunAt, now)}</span>
                {#if j.lastDurationMs != null}<span class="text-white/40">· took {duration(j.lastDurationMs)}</span>{/if}
              {:else}
                <span>never</span>
              {/if}
            </dd>
          </dl>
          {#if j.lastError}
            {@const msg = messageOf(j.lastError)}
            <p class="mt-1 text-xs text-red-300/90 break-words" data-job-error>
              {#if msg}{msg}{/if}
              {#if ref}
                {#if onref}
                  <button
                    class="ml-1 underline decoration-dotted text-amber-400 hover:text-amber-300"
                    title="Show this run's lines in the log"
                    onclick={() => onref?.(ref)}>ref {ref}</button
                  >
                {:else}
                  <span class="text-white/50">ref {ref}</span>
                {/if}
              {/if}
            </p>
          {/if}
        </li>
      {:else}
        <li class="py-2 text-sm text-white/40">
          The current version has no scheduled jobs. A backend declares them in its manifest's <code>cron</code>, with a
          <code>scheduled(event, ctx)</code> handler.
        </li>
      {/each}
    </ul>
  {:else if loading}
    <p class="text-sm text-white/40">Loading…</p>
  {/if}
</div>
