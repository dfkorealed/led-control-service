import type { BrowserContext } from "@playwright/test";

/** Install before domain fixtures: later page routes keep their precedence.
 * A fixture gap must never escape the lab to a backend or another origin.
 */
export async function installMockApiBoundary(context: BrowserContext, baseURL: string | undefined) {
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL) return route.abort();
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404, json: { message: "unconfigured mock route" } });
    return route.continue();
  });
}
