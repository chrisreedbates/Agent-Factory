FROM node:24.20.0-bookworm-slim
RUN npm install --global pnpm@11.19.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV ARTIFACT_ROOT=/workspaces
ENV SOURCE_ROOT=/sources
EXPOSE 3000
CMD ["pnpm", "--filter", "@agent-factory/worker", "dev"]
