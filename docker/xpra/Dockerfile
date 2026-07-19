FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install prerequisites needed to add the Xpra repository
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Add the official Xpra.org repository for Ubuntu 24.04 (Noble)
# xpra and xpra-html5 are not in Ubuntu's default repos; they must come
# from xpra.org's own apt repository.
RUN curl -fsSL https://xpra.org/xpra.asc -o /usr/share/keyrings/xpra.asc \
    && curl -fsSL \
       https://raw.githubusercontent.com/Xpra-org/xpra/master/packaging/repos/noble/xpra.sources \
       -o /etc/apt/sources.list.d/xpra.sources

# Install Xpra and X11 dependencies from the official repository
RUN apt-get update && apt-get install -y --no-install-recommends \
    xpra \
    xpra-html5 \
    xvfb \
    x11-utils \
    x11-xserver-utils \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# Create directory for Xpra socket files
RUN mkdir -p /var/run/xpra && chmod 1777 /var/run/xpra

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000-11000

ENTRYPOINT ["/entrypoint.sh"]
