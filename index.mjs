#!/usr/bin/env node
/**
 * opencode-browser-control — MCP server for OpenCode
 * Playwright-powered Chrome/Edge automation with ARIA ref snapshots.
 *
 * Usage: npx opencode-browser-control
 *   or:  node index.mjs
 */

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";

// ═══════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════
const PROFILE_DIR = join(homedir(), ".opencode", "browser-profile");
const TOOL_NAME = "browser";

let browser = null;
let context = null;
/** @type {Map<string, {page: import('playwright-core').Page, refs: Map<string, import('playwright-core').Locator>}>} */
let pages = new Map();
let activePageId = null;
let headed = true;

let browserPromise = null;
let pageCounter = 0;

// ═══════════════════════════════════════════════════════
//  Browser detection & launch
// ═══════════════════════════════════════════════════════
const BROWSER_CANDIDATES = [
  { name: "edge", paths: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
  ]},
  { name: "chrome", paths: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ]},
];

function findSystemBrowser() {
  for (const cand of BROWSER_CANDIDATES) {
    for (const p of cand.paths) {
      try { if (existsSync(p)) return { name: cand.name, path: p }; } catch {}
    }
  }
  return null;
}

function getPageId(page) {
  for (const [id, entry] of pages) {
    if (entry.page === page) return id;
  }
  return null;
}

function makePageId() {
  return "p" + (++pageCounter);
}

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const sysBrowser = findSystemBrowser();
    let launchOpts = {
      headless: !headed,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
      ],
    };

    // Prefer Playwright channel over executablePath (more reliable)
    if (sysBrowser) {
      const channelMap = { edge: "msedge", chrome: "chrome" };
      launchOpts.channel = channelMap[sysBrowser.name];
      // Fallback: if channel doesn't work, use executablePath
      if (!launchOpts.channel) {
        launchOpts.executablePath = sysBrowser.path;
      }
    }

    const userDataDir = join(PROFILE_DIR, sysBrowser?.name || "chromium");

    try {
      context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    } catch (e) {
      // If channel fails, try with just executablePath
      if (launchOpts.channel && sysBrowser?.path) {
        delete launchOpts.channel;
        launchOpts.executablePath = sysBrowser.path;
        context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      } else {
        throw e;
      }
    }
    browser = context.browser();

    // Listen for new pages from popups / window.open
    context.on("page", (page) => {
      const id = makePageId();
      pages.set(id, { page, refs: new Map() });
      process.stderr.write(`[browser] page created: ${id}\n`);
    });

    const existingPages = context.pages();
    if (existingPages.length > 0) {
      for (const p of existingPages) {
        const id = makePageId();
        pages.set(id, { page: p, refs: new Map() });
        activePageId = id;
      }
    } else {
      const page = await context.newPage();
      const id = makePageId();
      pages.set(id, { page, refs: new Map() });
      activePageId = id;
    }

    process.stderr.write(`[browser] launched (${pages.size} pages)\n`);
  })();
  try { await browserPromise; } finally { browserPromise = null; }
}

async function ensurePage(pageId) {
  await ensureBrowser();
  const targetId = pageId || activePageId;
  if (!targetId || !pages.has(targetId)) {
    throw new Error(`页面 ${targetId} 不存在 / page ${targetId} does not exist。可用页面 / available pages: ${[...pages.keys()].join(", ")}`);
  }
  const entry = pages.get(targetId);
  if (entry.page.isClosed()) {
    pages.delete(targetId);
    if (targetId === activePageId) activePageId = [...pages.keys()][0] || null;
    throw new Error(`页面 ${targetId} 已关闭 / page ${targetId} is closed`);
  }
  activePageId = targetId;
  return entry;
}

// ═══════════════════════════════════════════════════════
//  ARIA Snapshot + Ref System

async function buildSnapshot(page) {
  // Use Playwright's ARIA locator engine to find interactive elements
  // Inject ref markers into the DOM, then build text snapshot
  const refMap = [];

  // Find all interactive elements via Playwright locators
  const interactiveSelectors = [
    'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="combobox"]', '[role="listbox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[role="slider"]', '[role="spinbutton"]', '[role="heading"]',
    '[contenteditable="true"]', 'summary', 'details',
  ];

  try {
    // Inject ref markers into DOM
    await page.evaluate((selectors) => {
      // Remove old markers
      document.querySelectorAll("[data-br-ref]").forEach(el => {
        el.removeAttribute("data-br-ref");
      });

      let counter = 0;
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // Skip hidden / tiny elements
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 && rect.height < 2) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none") continue;

            counter++;
            el.setAttribute("data-br-ref", `e${counter}`);
          }
        } catch {}
      }
      return counter;
    }, interactiveSelectors);

    // Now collect all marked elements
    const elements = await page.evaluate(() => {
      const results = [];
      const marked = document.querySelectorAll("[data-br-ref]");
      for (const el of marked) {
        const ref = el.getAttribute("data-br-ref");
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        const type = el.getAttribute("type") || "";
        const name = el.getAttribute("aria-label") || el.getAttribute("title") ||
                     el.getAttribute("placeholder") || el.getAttribute("alt") ||
                     el.textContent?.trim().slice(0, 80) || "";
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : "";

        results.push({ ref, tag, role, type, name, id, cls });
      }
      return results;
    });

    // Build locator map
    const refs = new Map();
    const lines = [];

    for (const el of elements) {
      const roleText = el.role || el.type || el.tag;
      const nameText = el.name ? ` "${el.name}"` : "";
      lines.push(`${el.ref}: ${roleText}${nameText}`);

      // Build Playwright locator via data-br-ref
      const loc = page.locator(`[data-br-ref="${el.ref}"]`);
      refs.set(el.ref, loc);
    }

    // Update page's refs
    const pageId = getPageId(page);
    if (pageId && pages.has(pageId)) {
      pages.get(pageId).refs = refs;
    }

    const url = page.url();
    const title = await page.title();
    const header = [
      `URL: ${url}`,
      `Title: ${title}`,
      `Interactive: ${elements.length} elements`,
      "---",
    ];

    let text;
    if (elements.length === 0) {
      text = header.concat(["(页面无交互元素或仍在加载中)"]).join("\n");
    } else {
      text = header.concat(lines).join("\n");
    }

    return { snapshot: text, elements };
  } catch (e) {
    // Fallback: simple text content
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const fallback = `URL: ${page.url()}\n---\n${text.slice(0, 10000)}`;
    return { snapshot: fallback, elements: [] };
  }
}

async function getLocatorByRef(entry, ref) {
  if (!entry.refs.has(ref)) {
    throw new Error(`引用 ${ref} 不存在 / reference ${ref} not found。请先运行 snapshot 获取最新引用 / run snapshot first to get fresh refs。可用引用 / available refs: ${[...entry.refs.keys()].join(", ")}`);
  }
  return entry.refs.get(ref);
}

// ═══════════════════════════════════════════════════════
//  MCP Protocol (JSON-RPC 2.0 over stdio)
// ═══════════════════════════════════════════════════════
const TOOLS = [
  {
    name: TOOL_NAME,
    description: "浏览器控制主工具。通过 action 参数选择操作。首次使用自动启动浏览器。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "navigate", "snapshot", "click", "type", "evaluate", "screenshot", "tabs", "close_tab", "back", "forward"],
          description: "要执行的操作",
        },
        url: { type: "string", description: "[navigate] 目标 URL" },
        ref: { type: "string", description: "[click/type] ARIA 快照中的元素引用，如 e42" },
        text: { type: "string", description: "[type] 要输入的文本" },
        code: { type: "string", description: "[evaluate] 要执行的 JS 代码" },
        page_id: { type: "string", description: "目标页面 ID，不指定则用当前活跃页面" },
        headed: { type: "boolean", description: "[start] 是否显示浏览器窗口，默认 true" },
        submit: { type: "boolean", description: "[type] 输入后是否按回车提交" },
        wait: { type: "number", description: "操作后等待毫秒数" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_snapshot",
    description: "获取页面 ARIA 可访问性快照，返回带编号引用（e1, e2...）的交互元素列表。使用 browser_click(ref) 点击这些元素。",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "目标页面 ID，不指定则用当前页面" },
      },
    },
  },
  {
    name: "browser_click",
    description: "通过 ARIA 快照引用（如 e42）点击页面元素。需先调用 browser_snapshot 获取引用。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ARIA 快照中的元素引用，如 e42" },
        page_id: { type: "string", description: "目标页面 ID" },
      },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description: "通过 ARIA 快照引用在输入框中输入文本。需先调用 browser_snapshot 获取引用。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ARIA 快照中的输入框引用，如 e42" },
        text: { type: "string", description: "要输入的文本" },
        submit: { type: "boolean", description: "输入后是否按回车提交" },
        page_id: { type: "string", description: "目标页面 ID" },
      },
      required: ["ref", "text"],
    },
  },
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleToolCall(name, args) {
  // ── Multiplexed browser tool ──
  if (name === TOOL_NAME) {
    return handleBrowserAction(args);
  }
  // ── Shortcuts ──
  switch (name) {
    case "browser_snapshot":
      return handleBrowserAction({ action: "snapshot", page_id: args.page_id });
    case "browser_click":
      return handleBrowserAction({ action: "click", ref: args.ref, page_id: args.page_id });
    case "browser_type":
      return handleBrowserAction({ action: "type", ref: args.ref, text: args.text, submit: args.submit, page_id: args.page_id });
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

async function handleBrowserAction(args) {
  const { action, url, ref, text, code, page_id, submit, wait } = args;

  switch (action) {
    // ── start ──
    case "start": {
      if (args.headed !== undefined) headed = args.headed;
      await ensureBrowser();
      return { result: "浏览器已启动", active_page: activePageId, pages: pages.size };
    }

    // ── stop ──
    case "stop": {
      if (context) {
        await context.close();
        browser = null;
        context = null;
        pages.clear();
        activePageId = null;
      }
      return { result: "浏览器已关闭" };
    }

    // ── navigate ──
    case "navigate": {
      if (!url) throw new Error("缺少 url 参数");
      const entry = await ensurePage(page_id);
      await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      entry.refs = new Map(); // Clear stale refs after SPA navigation
      if (wait) await entry.page.waitForTimeout(wait);
      return {
        result: "导航成功",
        url: entry.page.url(),
        title: await entry.page.title(),
        page_id: activePageId,
      };
    }

    // ── snapshot ──
    case "snapshot": {
      const entry = await ensurePage(page_id);
      const snapshot = await buildSnapshot(entry.page);
      return { ...snapshot, page_id: activePageId };
    }

    // ── click ──
    case "click": {
      if (!ref) throw new Error("缺少 ref 参数");
      const entry = await ensurePage(page_id);
      const locator = await getLocatorByRef(entry, ref);
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 10000 });
      entry.refs = new Map(); // Clear stale refs after SPA navigation
      if (wait) await entry.page.waitForTimeout(wait);
      return { result: `已点击 ${ref}`, page_id: activePageId };
    }

    // ── type ──
    case "type": {
      if (!ref || text === undefined) throw new Error("缺少 ref 或 text 参数");
      const entry = await ensurePage(page_id);
      const locator = await getLocatorByRef(entry, ref);
      await locator.scrollIntoViewIfNeeded();
      await locator.fill(String(text));
      if (submit) await entry.page.keyboard.press("Enter");
      if (wait) await entry.page.waitForTimeout(wait);
      return { result: `已在 ${ref} 输入: ${text}`, page_id: activePageId };
    }

    // ── evaluate ──
    case "evaluate": {
      if (!code) throw new Error("缺少 code 参数");
      const entry = await ensurePage(page_id);
      const result = await entry.page.evaluate(code);
      return { result: JSON.stringify(result), page_id: activePageId };
    }

    // ── screenshot ──
    case "screenshot": {
      const entry = await ensurePage(page_id);
      const ts = Date.now();
      const filePath = join(homedir(), ".opencode", "screenshots", `screenshot-${ts}.png`);
      mkdirSync(join(homedir(), ".opencode", "screenshots"), { recursive: true });
      const buf = await entry.page.screenshot({ fullPage: true });
      writeFileSync(filePath, buf);
      const base64 = buf.toString("base64");
      return {
        result: "截图已保存",
        path: filePath,
        base64: `data:image/png;base64,${base64}`,
        page_id: activePageId,
      };
    }

    // ── tabs ──
    case "tabs": {
      await ensureBrowser();
      const tabs = [];
      for (const [id, entry] of pages) {
        if (!entry.page.isClosed()) {
          tabs.push({
            page_id: id,
            url: entry.page.url(),
            title: await entry.page.title().catch(() => ""),
            active: id === activePageId,
          });
        }
      }
      return { tabs, active: activePageId };
    }

    // ── close_tab ──
    case "close_tab": {
      const savedActive = activePageId;
      const entry = await ensurePage(page_id);
      const closedUrl = entry.page.url();
      const closeId = page_id || savedActive;
      await entry.page.close();
      pages.delete(closeId);
      process.stderr.write(`[browser] page closed: ${closeId}\n`);
      if (savedActive === closeId) {
        const remaining = [...pages.keys()];
        activePageId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      } else {
        activePageId = savedActive;
      }
      const remaining = [...pages.keys()];
      return { result: `已关闭标签: ${closedUrl}`, remaining: remaining.length, active_page: activePageId };
    }

    // ── back / forward ──
    case "back": {
      const entry = await ensurePage(page_id);
      await entry.page.goBack({ timeout: 10000 });
      if (wait) await entry.page.waitForTimeout(wait);
      return { result: "已后退", url: entry.page.url(), page_id: activePageId };
    }
    case "forward": {
      const entry = await ensurePage(page_id);
      await entry.page.goForward({ timeout: 10000 });
      if (wait) await entry.page.waitForTimeout(wait);
      return { result: "已前进", url: entry.page.url(), page_id: activePageId };
    }

    default:
      throw new Error(`未知操作: ${action}。可用: start, stop, navigate, snapshot, click, type, evaluate, screenshot, tabs, close_tab, back, forward`);
  }
}

// ═══════════════════════════════════════════════════════
//  Main — JSON-RPC loop
// ═══════════════════════════════════════════════════════
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-browser-control", version: "0.1.0" },
        });
        break;

      case "notifications/initialized":
        // no response needed
        break;

      case "tools/list":
        respond(id, { tools: TOOLS });
        break;

      case "tools/call": {
        try {
          const result = await handleToolCall(params.name, params.arguments || {});
          respond(id, {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          });
        } catch (e) {
          respond(id, {
            content: [{ type: "text", text: e.message }],
            isError: true,
          });
        }
        break;
      }

      default:
        respondError(id, -32601, `未知方法: ${method}`);
    }
  } catch (e) {
    respondError(id, -32000, e.message);
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  if (context) {
    const closePromise = context.close().catch(() => {});
    await closePromise;
  }
  process.exit(0);
});
process.on("SIGTERM", async () => {
  if (context) {
    const closePromise = context.close().catch(() => {});
    await closePromise;
  }
  process.exit(0);
});
