# syntax=docker/dockerfile:1
# The page backend runner (see README.md). Build from this directory:
#   docker build -t ghcr.io/danieles/specola-runner:latest runner
# No npm dependencies and no build step: the image is node plus src/, and
# pnpm, which installs the backends' own dependencies (src/deps.js).
# --build-arg TOOLCHAIN=1 adds python3, make and g++, for native packages
# that have no prebuilt binary for this platform and compile with node-gyp.

FROM node:24-slim
ARG PNPM_VERSION=10.28.0
ARG TOOLCHAIN=0
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force \
 && if [ "$TOOLCHAIN" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV NODE_ENV=production \
    RUNNER_LISTEN=:8081 \
    RUNNER_DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY src ./src
# The data volume belongs to the unprivileged user the runner runs as.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
