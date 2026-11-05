FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm install --global npm@11.19.1 --ignore-scripts
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm install --global npm@11.19.1 --ignore-scripts
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY --from=build /app/contracts/artifacts ./contracts/artifacts
COPY contracts/reference ./contracts/reference
COPY contracts/src ./contracts/src
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build /app/build ./build
USER node
EXPOSE 3080
CMD ["node","--import","tsx","server/index.ts"]
