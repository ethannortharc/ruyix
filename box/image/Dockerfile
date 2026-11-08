# syntax=docker/dockerfile:1
# Ruyix as an OCI image, built from a checkout (box/image/build.sh stages it as src/): the dsh it is tested with, the
# @ruyix plugins built here, and the tools they call — CJK fonts and Chromium's libraries for cards and browser
# sign-ins, plus FFmpeg for the bundled Video Studio. Your data never goes in here: it stays in
# $HOME (a nookbox box's home volume). `ruyix start`
# points ~/.dsh/profiles/ruyix at the plugins in /opt/ruyix and runs their setup once per home; a newer image is the
# upgrade (`nookbox update <box> --image ruyix:<version>`).
FROM debian:trixie-slim
ARG NODE_MAJOR=22
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 RUYIX_IMAGE=/opt/ruyix

# Debian's CDN refuses some plain-http downloads now and then: certificates first, then everything over https, retried
RUN set -eux; echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80retries; \
    for i in 1 2 3; do apt-get update && apt-get install -y --no-install-recommends ca-certificates && break; sleep 10; done; \
    sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources; \
    for i in 1 2 3; do apt-get update && apt-get install -y --no-install-recommends \
      curl git openssh-client python3 procps less jq xz-utils unzip sudo nftables iproute2 xdg-user-dirs \
      fonts-noto-cjk ffmpeg && break; sleep 10; done; \
    command -v git && command -v nft && command -v ffmpeg && command -v ffprobe; rm -rf /var/lib/apt/lists/*
RUN set -eux; case "$(uname -m)" in aarch64) a=arm64;; x86_64) a=x64;; *) exit 1;; esac; \
    base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"; \
    file="$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-$a.tar.xz" | head -1)"; \
    curl -fsSL -o "/tmp/$file" "$base/$file"; \
    curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | (cd /tmp && sha256sum -c -); \
    tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*/include' --exclude='*/share/doc'; \
    rm "/tmp/$file"; node --version
# The agent CLIs (Codex, Claude Code, pi) are not in the image: Agents → Runtimes installs, updates and pins them in the
# home (the pool's first start installs those its agents use). nookbox.agents below binds their login captures.
# npm 11 like the machine that wrote package-lock.json (npm 10 reads its lock as out of date); pnpm like dsh, at an exact
# version: a new one may change how installs and upgrades go (11.28 began to refuse lockfiles written by another build)
RUN npm install -g --no-audit --no-fund npm@11 pnpm@11.28.6 && npm cache clean --force
# Chromium's system libraries (the browser itself goes to each home at setup)
RUN for i in 1 2 3; do npx -y playwright@1 install-deps chromium && break; sleep 10; done && rm -rf /var/lib/apt/lists/* /root/.npm

# Linux apps with a window (the App Center, @ruyix/apps): each runs on its own virtual display (TigerVNC's Xvnc) under a
# window manager that keeps one window full size (matchbox); the page draws the display. Their look too, as a desktop
# would give it (the apps plugin tells each app at its start, lib/display.js): Adwaita and Papirus icons (SVG: librsvg's
# loader), Inter and JetBrains Mono. The apps themselves are installed later, by the person, into the running box
# (nookbox's self-install).
RUN set -eux; for i in 1 2 3; do apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server matchbox-window-manager dbus-x11 xauth xfonts-base x11-utils fonts-dejavu-core \
      adwaita-icon-theme papirus-icon-theme librsvg2-common fonts-inter fonts-jetbrains-mono && break; sleep 10; done; \
    command -v Xvnc && command -v matchbox-window-manager; rm -rf /var/lib/apt/lists/*

# The terminal (the App Center's, drawn in the page) and the two multiplexers it runs: tmux from Debian; zellij is
# not in Debian's archive (deb.griffo.io packages it, but its downloads want a subscription since 2026-10), so its
# own release — zellij-org's static build on GitHub — checked against the sum written here for each architecture
# (the release's .sha256sum files). A newer zellij: change the version and both sums.
ARG ZELLIJ_VERSION=0.45.1
ARG ZELLIJ_SHA256_ARM64=2a2c0621e6f3b11ecbb05d66939a48000a2508604620aa20727a5fd61c49f451
ARG ZELLIJ_SHA256_AMD64=d006c521dcb475a6005d741e9dd7c5758e5a23b28dd60a5c10cebfa4876319dd
RUN set -eux; for i in 1 2 3; do apt-get update && apt-get install -y --no-install-recommends tmux && break; sleep 10; done; \
    rm -rf /var/lib/apt/lists/*; \
    case "$(uname -m)" in aarch64) a=aarch64; sum=$ZELLIJ_SHA256_ARM64;; x86_64) a=x86_64; sum=$ZELLIJ_SHA256_AMD64;; *) exit 1;; esac; \
    curl -fsSL -o /tmp/zellij.tgz "https://github.com/zellij-org/zellij/releases/download/v$ZELLIJ_VERSION/zellij-$a-unknown-linux-musl.tar.gz"; \
    tar -xzf /tmp/zellij.tgz -C /tmp zellij; echo "$sum  /tmp/zellij" | sha256sum -c -; \
    install -m 755 /tmp/zellij /usr/local/bin/zellij; rm /tmp/zellij /tmp/zellij.tgz; tmux -V; zellij --version

# dsh first, on a layer of its own: a rebuild on the same dsh pulls only the plugins' layer
ARG RUYIX_DSH
RUN set -eux; test -n "$RUYIX_DSH"; npm install --prefix /opt/ruyix/dsh --no-audit --no-fund "@deepseek-ai/dsh@$RUYIX_DSH"; rm -rf /root/.npm

# The plugins, from the checkout: built here, then linked into the image's dsh profile (as tools/dev-install.sh does)
COPY src /opt/ruyix/src
RUN set -eux; cd /opt/ruyix/src; \
    test "$(node -p "require('./core/shell/package.json').ruyix.dsh")" = "$RUYIX_DSH"; \
    npm ci --no-audit --no-fund --loglevel=error; \
    for p in core/connectors core/plugins/agent-hub core/workbench core/plugins/studio core/plugins/web packs/plume packs/video packs/newsletter core/plugins/box core/plugins/apps core/plugins/world core/shell; do (cd "$p" && node build.mjs); done; \
    export HOME=/tmp/ruyix-build DSH_HOME=/opt/ruyix/dsh-home; mkdir -p "$HOME"; dsh=/opt/ruyix/dsh/node_modules/.bin/dsh; \
    (cd "$HOME" && "$dsh" --profile ruyix --from-default-profile web --dump-config >/dev/null); \
    args=; for p in core/connectors core/plugins/agent-hub core/workbench core/plugins/studio core/plugins/web packs/plume packs/video packs/newsletter core/plugins/box core/plugins/apps core/plugins/world core/shell; do args="$args link:/opt/ruyix/src/$p"; done; \
    (cd "$HOME" && "$dsh" plugin --profile ruyix add $args >/dev/null); \
    test -f /opt/ruyix/dsh-home/profiles/ruyix/node_modules/@ruyix/shell/package.json; \
    ln -s /opt/ruyix/dsh-home/profiles/ruyix/node_modules/@ruyix/shell/bin/ruyix /usr/local/bin/ruyix; \
    rm -rf /opt/ruyix/dsh-home/.anonymous-user-id /opt/ruyix/dsh-home/.credentials.yaml /opt/ruyix/dsh-home/storages \
      /opt/ruyix/dsh-home/skills /opt/ruyix/dsh-home/sessions /opt/ruyix/dsh-home/profiles/.ruyix-rollback.* "$HOME" /root/.npm /root/.cache; \
    # dsh writes its profile files private to their owner (root here); the box user only reads them
    chmod -R a+rX /opt/ruyix

# What nookbox needs to know to make a box of it (`nookbox create NAME --image <this>`); flags override each one.
ARG RUYIX_VERSION
LABEL org.opencontainers.image.title="Ruyix" \
      org.opencontainers.image.description="Ruyix ${RUYIX_VERSION} (dsh + the @ruyix plugins, built from source)" \
      org.opencontainers.image.version="${RUYIX_VERSION}" \
      org.opencontainers.image.source="https://github.com/ethannortharc/ruyix" \
      nookbox.name="ruyix" \
      nookbox.link="ruyix link" \
      nookbox.config="~/.ruyix/import.json" \
      nookbox.runtime="microvm" \
      nookbox.agents="claude,codex" \
      nookbox.ports="3280" \
      nookbox.memory="8192" \
      nookbox.allow-private="true" \
      nookbox.start="ruyix start" \
      nookbox.secrets="sign the agents in: nookbox login codex <box>; an API key for a connection: add it in Ruyix's Settings → Connections (it goes to the host's vault)"
