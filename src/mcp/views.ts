/**
 * MCP Apps views as the host receives them: one self-contained document.
 *
 * A view names its shared files the way a browser loads them from disk, so it
 * still opens on its own while you work on it. Serving inlines them, because
 * the host's CSP blocks every other request:
 *
 *   <link rel="stylesheet" href="mcp-app.css">  →  <style>…</style>
 *   <script src="mcp-app.js"></script>          →  <script>…</script>
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { findView } from "./paths.js";

/** Only bare file names beside the view: nothing outside ui/ gets inlined. */
const SHARED_STYLE = /<link rel="stylesheet" href="([\w-]+\.css)">/g;
const SHARED_SCRIPT = /<script src="([\w-]+\.js)"><\/script>/g;

export async function loadView(name: string): Promise<string> {
  const path = findView(name);
  const directory = dirname(path);

  const html = await readFile(path, "utf8");
  const styled = await inline(html, SHARED_STYLE, directory, (body) => `<style>\n${body}</style>`);
  return inline(styled, SHARED_SCRIPT, directory, (body) => `<script>\n${body}</script>`);
}

async function inline(
  html: string,
  pattern: RegExp,
  directory: string,
  wrap: (body: string) => string,
): Promise<string> {
  const names = [...new Set([...html.matchAll(pattern)].map((match) => match[1] ?? ""))];
  const bodies = new Map(
    await Promise.all(names.map(async (name) => [name, await readFile(join(directory, name), "utf8")] as const)),
  );

  // A function replacement: a "$" in the inlined code stays literal.
  return html.replace(pattern, (_, name: string) => wrap(bodies.get(name) ?? ""));
}
