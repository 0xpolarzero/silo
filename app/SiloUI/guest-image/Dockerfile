# syntax=docker/dockerfile:1
FROM ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254
LABEL org.opencontainers.image.title="Silo Ubuntu guest" \
      org.opencontainers.image.description="Ubuntu 24.04 with Silo's Git integration and offline working-account tools. No credentials." \
      org.opencontainers.image.source="https://github.com/0xpolarzero/silo" \
      org.opencontainers.image.version="ubuntu-24.04-v3"
COPY src-tauri/guest/setup-github.sh /tmp/silo-setup-github.sh
RUN sh /tmp/silo-setup-github.sh \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo python3 openssh-sftp-server \
    && dpkg-query -W > /usr/local/share/silo-packages.txt \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /tmp/silo-setup-github.sh
CMD ["/bin/bash"]
