FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Zero zależności npm — jawne kopie (bez COPY ., dzięki czemu gitignored
# config.json i data/ nie trafiają do obrazu). package.json jest obowiązkowy:
# "type": "module" steruje parsowaniem ESM w src/.
COPY package.json targets.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Uruchamia się jako "node" (uid 1000) — ./data na hoście musi mieć ten uid.
USER node

# Watchdog jest PID1: trzyma main przy życiu, sprawdza /api/health co 30 s
# i po 3 kolejnych błędach kończy proces (restart: unless-stopped podnosi go).
CMD ["node", "scripts/watchdog.mjs"]
