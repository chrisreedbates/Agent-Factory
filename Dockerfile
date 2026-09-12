FROM node:24.20.0-bookworm-slim
RUN npm install --global pnpm@11.19.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 3000
CMD ["pnpm", "dev:api"]
