# ops/DEPLOY.md section 3: the API and the verifier share one image. Node runs the
# TypeScript sources directly, as on the laptop; only packages/shared is built.
FROM node:22-bookworm-slim
RUN npm install -g pnpm@11.22.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@hackathon/api..." \
 && pnpm --filter @hackathon/shared build
ENV NODE_ENV=production
WORKDIR /app/apps/api
