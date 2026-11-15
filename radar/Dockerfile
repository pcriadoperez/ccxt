# Host in the EU or Asia: Binance and Bybit geo-block US IP addresses.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY ts ./ts
ENV RADAR_DB=/data/radar.sqlite
VOLUME /data
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "ts/main.ts"]
