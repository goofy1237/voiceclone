FROM node:20-alpine

WORKDIR /app

# Install deps using the lockfile for reproducibility
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
