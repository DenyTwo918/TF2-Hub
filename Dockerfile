ARG BUILD_ARCH=aarch64
FROM ghcr.io/home-assistant/${BUILD_ARCH}-base:latest

ARG BUILD_VERSION=1.8.1

LABEL io.hass.name="TF2 Trading Hub" \
      io.hass.description="Autonomous TF2 trading bot for Home Assistant." \
      io.hass.type="addon" \
      io.hass.version="${BUILD_VERSION}" \
      maintainer="DenyTwo918"

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
