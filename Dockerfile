FROM node:22-alpine

# Links the GHCR package to the repo so it shows up there and inherits its visibility
LABEL org.opencontainers.image.source=https://github.com/PratikPatil-Dev/nudge-bot

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# goals.json and data/ (SQLite db + profile.md) are personal: mounted from the VM, never baked into the image
CMD ["npm", "start"]
