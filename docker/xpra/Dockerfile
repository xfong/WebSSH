FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Xpra and X11 dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xpra \
    xpra-html5 \
    xvfb \
    x11-utils \
    x11-xserver-utils \
    dbus-x11 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create directory for Xpra socket files
RUN mkdir -p /var/run/xpra && chmod 1777 /var/run/xpra

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000-11000

ENTRYPOINT ["/entrypoint.sh"]
