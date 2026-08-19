FROM node:22-bookworm-slim AS dependencies

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/opt/corepack

RUN mkdir -p "$COREPACK_HOME" /build \
  && corepack enable \
  && corepack prepare pnpm@10.17.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME" \
  && chown -R node:node /build

WORKDIR /build
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node patches ./patches
COPY --chown=node:node apps/feed-supplier/package.json ./apps/feed-supplier/package.json
COPY --chown=node:node packages/feed-source-contracts/package.json ./packages/feed-source-contracts/package.json
USER node
RUN --mount=type=cache,id=folo-feed-supplier-pnpm,target=/pnpm/store,uid=1000,gid=1000 \
  pnpm --filter-prod @follow/feed-supplier... install --frozen-lockfile --prod --ignore-scripts \
  --package-import-method=copy --store-dir=/pnpm/store

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN mkdir -p /app && chown -R node:node /app

WORKDIR /app
COPY --from=dependencies --chown=node:node /build /app
COPY --chown=node:node apps/feed-supplier/src ./apps/feed-supplier/src
COPY --chown=node:node packages/feed-source-contracts/src ./packages/feed-source-contracts/src

WORKDIR /app/apps/feed-supplier
USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "--env-file-if-exists=.env", "src/index.ts"]
