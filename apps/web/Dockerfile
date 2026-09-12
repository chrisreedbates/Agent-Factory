# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:24.20.0-alpine AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @agent-factory/web build

FROM nginx:1.27-alpine
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
