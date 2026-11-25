// Installing a page app (docs/page-apps.md, "SPA"). The browser offers it
// once, early, with beforeinstallprompt: listened for before anything mounts,
// and kept for the install banner.

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export const install = $state<{ prompt: InstallPrompt | null; installed: boolean }>({ prompt: null, installed: false });

const modes = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];

/** Running as an installed app, not in a browser tab. */
export function standalone(): boolean {
  if (typeof window === "undefined") return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone) return true;
  return modes.some((m) => matchMedia(`(display-mode: ${m})`).matches);
}

/** iOS and iPadOS, where an app is added from the Share menu instead. */
export function ios(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function listenForInstall() {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    install.prompt = e as InstallPrompt;
  });
  addEventListener("appinstalled", () => {
    install.prompt = null;
    install.installed = true;
  });
}
