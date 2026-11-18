/**
 * Locating the schema card.
 *
 * An MCP server is launched by the host (Claude Desktop, Claude Code, an IDE),
 * and the host decides the working directory — usually not this project. So a
 * cwd-relative path to the card silently resolves to nothing in production
 * while working perfectly in development. Walk up from this module instead,
 * which is correct both under tsx (src/mcp/) and after tsc (dist/src/mcp/).
 */

import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const CARD_RELATIVE_PATH = join("schema", "schema-card.md");
const VIEWS_DIRECTORY = "ui";

export function findSchemaCard(): string {
  return findUp(CARD_RELATIVE_PATH, "Run `npm run schema:gen`.");
}

/** A file of the MCP Apps views, e.g. "class-graph.html". */
export function findView(name: string): string {
  return findUp(join(VIEWS_DIRECTORY, name), "Ship the ui/ directory with dist/.");
}

function findUp(relativePath: string, hint: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(directory);

  while (true) {
    const candidate = join(directory, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (directory === root) {
      throw new Error(`could not find ${relativePath} above ${fileURLToPath(import.meta.url)}. ${hint}`);
    }

    directory = dirname(directory);
  }
}
