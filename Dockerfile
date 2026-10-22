FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies with frozen lockfile
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

CMD ["bun", "run", "src/listener/index.ts"]
