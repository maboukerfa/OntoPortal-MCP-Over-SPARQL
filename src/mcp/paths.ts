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

export function findSchemaCard(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(directory);

  while (true) {
    const candidate = join(directory, CARD_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (directory === root) {
      throw new Error(
        `could not find ${CARD_RELATIVE_PATH} above ${fileURLToPath(import.meta.url)}. ` +
          "Run `npm run schema:gen`.",
      );
    }

    directory = dirname(directory);
  }
}
