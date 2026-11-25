import { api, type BackendsState } from "./api";

// Whether page backends are on (docs/page-backends.md, "Enabled or not"), as
// GET /api/me last said: "enabled" is the instance's configuration,
// "available" its latest health check of the runner.
export const backends = $state<BackendsState & { known: boolean }>({ enabled: false, available: false, known: false });

export function setBackends(b: BackendsState | undefined) {
  backends.enabled = !!b?.enabled;
  backends.available = !!b?.enabled && !!b?.available;
  backends.known = !!b;
}

/** Asks again; availability follows the runner's health. */
export async function refreshBackends() {
  try {
    const m = await api.me();
    if (!m.offline) setBackends(m.backends);
  } catch {
    // Keep what was known.
  }
}
