import { test, expect, type Frame, type Page } from "@playwright/test";

const destination = "https://external.specola.test/document";
const html = `<!doctype html><html><head><title>Link fixture</title></head><body>
<h1>Published document</h1>
<a id="external" href="${destination}"><span>External</span></a>
<a id="local" href="#section">Local section</a>
<a id="mail" href="mailto:reader@example.test">Mail</a>
<a id="download" href="${destination}" download>Download</a>
<a id="cancelled" href="${destination}" onclick="event.preventDefault()">Cancelled</a>
<div style="height:1000px"></div><h2 id="section">Section</h2>
<script>
const dynamic = document.createElement('a');
dynamic.id = 'dynamic'; dynamic.href = '${destination}'; dynamic.textContent = 'Dynamic';
document.body.prepend(dynamic);
</script></body></html>`;

// The destination refuses framing and uses real origin storage. A sandboxed
// popup would fail this check even if it displayed the destination's HTML.
async function mockDestination(page: Page) {
  await page.context().route("https://external.specola.test/**", async (route) => {
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" },
      body: `<h1>Outside preview</h1><script>
        try { localStorage.setItem('popup-check', 'ok'); document.body.dataset.storage = localStorage.getItem('popup-check'); }
        catch { document.body.dataset.storage = 'blocked'; }
        document.body.dataset.opener = window.opener === null ? 'none' : 'present';
      </script>`,
    });
  });
}

async function outside(page: Page, frame: Frame, activate: () => Promise<unknown>) {
  const outerURL = page.url();
  const frameURL = frame.url();
  const popupPromise = page.context().waitForEvent("page");
  await activate();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(destination);
  await expect(popup.locator("body")).toHaveAttribute("data-storage", "ok");
  await expect(popup.locator("body")).toHaveAttribute("data-opener", "none");
  expect(page.url()).toBe(outerURL);
  expect(frame.url()).toBe(frameURL);
  await expect(frame.locator("h1")).toHaveText("Published document");
  await popup.close();
}

for (const mode of ["private", "raw", "public"] as const) {
  test.describe(mode, () => {
    let id: string;
    let doc: Frame;
    test.beforeEach(async ({ page, request, baseURL }) => {
      const response = await request.post("/api/pages", { data: { name: "Links e2e", html } });
      expect(response.status()).toBe(201);
      id = (await response.json()).id;
      await mockDestination(page);
      if (mode === "private") {
        await page.goto(`/#/p/${id}`);
        await expect(page.locator("iframe")).toBeVisible();
        const iframe = await page.locator("iframe").elementHandle();
        doc = (await iframe!.contentFrame())!;
      } else if (mode === "raw") {
        const meta = await (await request.get(`/api/pages/${id}`)).json();
        await page.goto(new URL(meta.viewUrl, baseURL).href);
        doc = page.mainFrame();
      } else {
        const link = await request.post(`/api/pages/${id}/links`, { data: { label: "e2e", version: 0, expiresInDays: 1 } });
        expect(link.status()).toBe(201);
        await page.goto((await link.json()).url);
        doc = page.mainFrame();
      }
      await expect(doc.locator("h1")).toHaveText("Published document");
    });
    test.afterEach(async ({ request }) => {
      if (id) expect((await request.post(`/api/pages/${id}/archive`)).ok()).toBeTruthy();
    });

    test("regular links and explicit targets leave the document intact", async ({ page }) => {
      for (const target of [null, "_blank", "_self", "_parent", "_top", "named-window"]) {
        await doc.locator("#external").evaluate((a, target) => {
          if (target === null) a.removeAttribute("target"); else a.setAttribute("target", target);
          a.setAttribute("rel", "author");
        }, target);
        await outside(page, doc, () => doc.locator("#external span").click());
        await expect(doc.locator("#external")).toHaveAttribute("rel", "author noopener noreferrer");
      }
    });

    test("explicit _blank popups do not inherit the page sandbox", async ({ page }) => {
      await doc.locator("#external").evaluate((a) => a.setAttribute("target", "_blank"));
      await outside(page, doc, () => doc.locator("#external").click());
    });

    test("dynamic links, keyboard activation and middle-click", async ({ page }) => {
      await outside(page, doc, () => doc.locator("#dynamic").click());
      await doc.evaluate((href) => {
        const a = document.createElement("a");
        a.id = "late-link";
        a.href = href;
        a.textContent = "Added after load";
        document.body.prepend(a);
      }, destination);
      await outside(page, doc, () => doc.locator("#late-link").click());
      await doc.locator("#external").focus();
      await outside(page, doc, () => page.keyboard.press("Enter"));
      await outside(page, doc, () => doc.locator("#external").click({ button: "middle" }));
    });

    test("local fragments and absolute same-document fragments stay local", async ({ page }) => {
      const outerURL = page.url();
      await doc.locator("#local").click();
      expect(new URL(doc.url()).hash).toBe("#section");
      await expect(doc.locator("#local")).not.toHaveAttribute("target");
      if (mode === "private") expect(page.url()).toBe(outerURL);
      await doc.locator("#local").evaluate((a, href) => a.setAttribute("href", href), doc.url().replace(/#.*$/, "") + "#section");
      await doc.locator("#local").click();
      await expect(doc.locator("#local")).not.toHaveAttribute("target");
      expect(page.context().pages()).toHaveLength(1);
    });

    test("non-http links, downloads and cancelled clicks retain native behavior", async ({ page }) => {
      for (const id of ["mail", "download"]) {
        // Inspect policy without invoking a mail client or a cross-origin download.
        await doc.locator(`#${id}`).evaluate((a) => {
          a.addEventListener("click", (e) => e.preventDefault(), { once: true });
          a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
        });
        await expect(doc.locator(`#${id}`)).not.toHaveAttribute("target");
        await expect(doc.locator(`#${id}`)).not.toHaveAttribute("rel");
      }
      await doc.locator("#cancelled").click();
      await expect(doc.locator("h1")).toHaveText("Published document");
      expect(page.context().pages()).toHaveLength(1);
    });

    if (mode === "private") {
      test("offline blob previews keep links outside and fragments inside", async ({ page }) => {
        await page.getByRole("button", { name: "Save offline", exact: true }).click();
        await expect(page.getByRole("button", { name: "Saved offline ✓", exact: true })).toBeVisible();
        await page.context().setOffline(true);
        await expect(page.locator("iframe")).toHaveAttribute("src", /^blob:/);
        const iframe = await page.locator("iframe").elementHandle();
        const offlineDoc = (await iframe!.contentFrame())!;
        await expect(offlineDoc.locator("h1")).toHaveText("Published document");
        await outside(page, offlineDoc, () => offlineDoc.locator("#external").click());
        await offlineDoc.locator("#local").click();
        expect(new URL(offlineDoc.url()).hash).toBe("#section");
        expect(page.url()).toContain(`/#/p/${id}`);
      });
    }

    test("preview stays opaque and cannot read parent storage or navigate top", async ({ page }) => {
      const result = await doc.evaluate(() => {
        let originAccess = false;
        try { void document.domain; originAccess = self.origin !== "null"; } catch {}
        let parentAccess = false;
        if (parent !== window) {
          try { void parent.document.body; parentAccess = true; } catch {}
          try { top!.location.href = "https://external.specola.test/escape"; } catch {}
        }
        return { originAccess, parentAccess };
      });
      expect(result).toEqual({ originAccess: false, parentAccess: false });
      if (mode === "private") {
        const sandbox = (await page.locator("iframe").getAttribute("sandbox"))!.split(/\s+/);
        expect(sandbox).toContain("allow-popups-to-escape-sandbox");
        expect(sandbox).not.toContain("allow-same-origin");
        expect(sandbox).not.toContain("allow-top-navigation");
        expect(sandbox).not.toContain("allow-top-navigation-by-user-activation");
        expect(page.url()).toContain(`/#/p/${id}`);
      }
    });
  });
}
