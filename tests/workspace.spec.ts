import { test, expect } from "@playwright/test";

test("workspace session, thread, search, steering, export, and persistence", async ({ page, request }) => {
  const name = `Browser test ${Date.now()}`;
  let sessionId = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Session name").fill(name);
    await page.getByLabel("What are you working toward?").fill("Verify the actual browser-to-database session workflow.");
    await page.getByRole("dialog").getByRole("button", { name: "Create session", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const state = await (await request.get("/api/workspace")).json();
    sessionId = state.sessions.find((item: { name: string }) => item.name === name).id;
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByLabel("Thread name", { exact: true }).fill("Browser verification");
    await page.getByLabel("Thread charter").fill("Verify user-facing workflows against the persistent session state.");
    await page.getByRole("button", { name: "Create thread", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.locator(".main-nav").getByRole("button", { name: "Threads" }).click();
    await page.getByRole("textbox", { name: "Search threads" }).fill("Browser verification");
    await expect(page.locator(".thread-table tbody tr")).toHaveCount(1);
    await page.locator(".thread-table tbody tr").click();
    await page.getByRole("button", { name: "Steer next dispatch" }).click();
    await page.getByLabel("Steering instruction").fill("Verify filesystem state before making any changes.");
    await page.getByRole("button", { name: "Queue instruction" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Search anything" }).click();
    await page.getByRole("textbox", { name: "Search workspace" }).fill("Browser verification");
    await page.locator(".search-results").getByRole("button", { name: "Browser verification" }).click();
    await expect(page.getByRole("heading", { name: "Browser verification" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    const persisted = await (await request.get("/api/workspace")).json();
    const session = persisted.sessions.find((item: { id: string }) => item.id === sessionId);
    expect(session.data.threads).toHaveLength(4);
    expect(session.data.steering[0].thread_name).toBe("Browser verification");
    expect(session.data.steering[0].consumed_at).toBeUndefined();
    const exported = await request.get(`/api/workspace?export=${sessionId}`);
    expect(exported.ok()).toBeTruthy();
    expect((await exported.json()).format).toBe("nested-session");
    expect(errors).toEqual([]);
  } finally { if (sessionId) await request.post("/api/workspace", { data: { action: "delete_session", session_id: sessionId } }); }
});

test("mobile navigation is accessible without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(".main-nav").getByRole("button", { name: "Episodes" }).click();
  await expect(page.getByRole("heading", { name: "Episode library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Good work leaves a useful handoff" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
