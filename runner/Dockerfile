# syntax=docker/dockerfile:1
# The page backend runner (see README.md). Build from this directory:
#   docker build -t ghcr.io/danieles/specola-runner:latest runner
# No npm dependencies and no build step: the image is node plus src/.

FROM node:24-slim
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
