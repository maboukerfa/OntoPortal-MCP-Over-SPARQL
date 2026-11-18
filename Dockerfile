ARG NODE_IMAGE=node:22.23.0-alpine

# Build: compile TypeScript, then drop dev dependencies so the runtime stage
# can take node_modules as is.
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: package.json declares ESM; schema/ holds the snapshot card, found by
# walking up from dist/src/mcp when the endpoint does not answer; ui/ holds the
# class graph view, found the same way.
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY schema ./schema
COPY ui ./ui

USER node
EXPOSE 8080

# HTTP by default. `--transport stdio` lets a host launch it with `docker run -i`.
ENTRYPOINT ["node", "dist/src/mcp/server.js"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "8080"]
