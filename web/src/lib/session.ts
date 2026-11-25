import { api, type Me } from "./api";
import { setBackends } from "./backends.svelte";
import * as offline from "./offline.svelte";
import { resumeWrites } from "./pagedata";

/**
 * Starts the signed-in session, in Specola and in a page app alike: who is
 * signed in, whether backends run, and the offline data bound to them, with
 * the page data writes still unsaved folded back in before any page opens.
 */
export async function startSession(): Promise<Me> {
  const m = await api.me();
  // A copy kept for offline says nothing about the runner now.
  setBackends(m.offline ? { enabled: !!m.backends?.enabled, available: false } : m.backends);
  await offline.claim(m.sub);
  resumeWrites();
  return m;
}
