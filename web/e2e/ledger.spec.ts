import { test, expect } from "@playwright/test"

test("personal ledger, assets, categories, MCP and device sessions", async ({
  page,
  browser,
}) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "登录 Ledger" })).toBeVisible()
  await page.getByLabel("账号", { exact: true }).fill("test-owner")
  await page
    .getByLabel("密码", { exact: true })
    .fill("browser-test-password-1234")
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "今天记点什么？" })
  ).toBeVisible()
  await page.getByLabel("金额", { exact: true }).fill("35.50")
  await page
    .getByRole("combobox", { name: "类别", exact: true })
    .selectOption({ label: "餐饮 / 正餐" })
  await page.getByRole("button", { name: "记一笔", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await expect(page.locator(".stat-main h2")).toContainText("35.50")
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("")
  await page.getByRole("button", { name: "编辑记账", exact: true }).click()
  const edit = page.getByRole("dialog")
  await edit.getByLabel("金额", { exact: true }).fill("30.50")
  await edit.getByLabel("调整原因（选填）").fill("优惠券抵扣")
  await edit.getByRole("button", { name: "保存修改" }).click()
  await expect(page.locator(".stat-main h2")).toContainText("30.50")
  await page.getByRole("button", { name: "废止记账", exact: true }).click()
  await page.getByRole("dialog").getByLabel("废止原因").fill("重复记账")
  await page.getByRole("button", { name: "确认废止" }).click()
  await expect(page.locator("tbody tr")).toHaveCount(0)
  await page.getByRole("combobox", { name: "记录状态" }).selectOption("void")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await page.getByRole("button", { name: "恢复记账", exact: true }).click()
  await page.getByRole("button", { name: "确认恢复" }).click()
  await page.getByRole("combobox", { name: "记录状态" }).selectOption("active")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await page.getByRole("button", { name: "查看历史" }).click()
  await expect(page.getByRole("dialog")).toContainText("优惠券抵扣")
  await expect(page.getByRole("dialog")).toContainText("重复记账")
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "资产概况", exact: true }).click()
  await page.getByRole("button", { name: "添加资产 / 负债" }).click()
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill("储蓄卡")
  await page
    .getByRole("dialog")
    .getByLabel("余额", { exact: true })
    .fill("5000")
  await page.getByRole("button", { name: "保存快照" }).click()
  await expect(page.locator(".stat-main h2")).toContainText("5,000.00")
  await page.getByRole("button", { name: "更新余额" }).click()
  await page
    .getByRole("dialog")
    .getByLabel("余额", { exact: true })
    .fill("5100")
  await page.getByRole("button", { name: "保存快照" }).click()
  await page.getByRole("button", { name: "余额历史" }).click()
  await expect(page.getByRole("dialog").locator("article")).toHaveCount(2)
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("button", { name: "分类管理", exact: true }).click()
  await page.getByRole("button", { name: "新增分类", exact: true }).click()
  await page.getByLabel("分类名称").fill("学习")
  await page.getByRole("button", { name: "保存分类" }).click()
  await expect(
    page.getByRole("heading", { name: "学习", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "连接与安全", exact: true }).click()
  await page.getByRole("textbox", { name: "令牌名称" }).fill("测试 AI")
  await page.getByRole("button", { name: "创建 Token" }).click()
  const token = await page.locator(".secret").innerText()
  expect(token.length).toBeGreaterThan(40)
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  const mcpHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
  }
  const mcp = await page.request.post("/mcp", {
    headers: mcpHeaders,
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  expect(mcp.ok()).toBeTruthy()
  expect((await mcp.json()).result.tools.length).toBe(13)
  await page
    .locator(".settings-panel")
    .first()
    .getByRole("button", { name: "撤销", exact: true })
    .click()
  await expect(page.locator(".settings-panel").first()).not.toContainText(
    "测试 AI"
  )
  expect(
    (
      await page.request.post("/mcp", {
        headers: mcpHeaders,
        data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      })
    ).status()
  ).toBe(401)
  const other = await browser.newContext()
  const second = await other.newPage()
  await second.goto("http://127.0.0.1:18089/")
  await second.getByLabel("账号", { exact: true }).fill("test-owner")
  await second
    .getByLabel("密码", { exact: true })
    .fill("browser-test-password-1234")
  await second.getByRole("button", { name: "登录", exact: true }).click()
  await expect(
    second.getByRole("heading", { name: "今天记点什么？" })
  ).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "连接与安全", exact: true }).click()
  await page
    .locator(".credential-list>div")
    .filter({ hasText: "其他设备" })
    .getByRole("button", { name: "撤销", exact: true })
    .click()
  await second.reload()
  await expect(
    second.getByRole("heading", { name: "登录 Ledger" })
  ).toBeVisible()
  await other.close()
  await page.getByRole("button", { name: "日常账本", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole("button", { name: "记一笔", exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBeTruthy()
  await expect(page.locator(".stat-main h2")).toContainText("30.50")
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  })
  expect(pageErrors).toEqual([])
})
