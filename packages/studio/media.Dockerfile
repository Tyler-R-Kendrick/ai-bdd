# syntax=docker/dockerfile:1.7
# Context MUST come from verification/prepare-media-image.mjs (<=32MiB whitelist).
# Actual pulled Node24 Bookworm digest; pin the separately published private VCR image by its registry digest.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
COPY . /opt/studio-media/
# This explicitly Debian build installs verified distro packages once. No install runs in a Sandbox session.
# Two filesystem layers keep VFS CI builders bounded; no pnpm store or full Studio deployment is copied.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /vercel/sandbox \
 && chown node:node /vercel/sandbox \
 && chmod -R a+rX /opt/studio-media \
 && node /opt/studio-media/build-manifest.mjs
ENV NODE_ENV=production STUDIO_FFMPEG_PATH=/usr/bin/ffmpeg STUDIO_FFPROBE_PATH=/usr/bin/ffprobe \
    STUDIO_CHROMIUM_PATH=/usr/bin/chromium \
    XDG_CONFIG_HOME=/tmp/studio-media-config XDG_CACHE_HOME=/tmp/studio-media-cache
USER node
WORKDIR /vercel/sandbox
# Sandbox ignores ENTRYPOINT/CMD. The adapter invokes this absolute command explicitly.
CMD ["/usr/local/bin/node", "/opt/studio-media/worker.mjs"]
