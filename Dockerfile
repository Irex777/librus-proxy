FROM node:20-bookworm

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --production

# Install Playwright Chromium + system deps
RUN npx playwright install chromium --with-deps

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
