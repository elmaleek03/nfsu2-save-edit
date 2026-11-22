# nfsu2save — static site, no backend.
# nginx-unprivileged runs as uid 101 and listens on 8080 (no root needed).
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf

# The app is four files. If you add an asset, add it to this line too.
COPY --chown=101:101 index.html styles.css core.js app.js favicon.svg /usr/share/nginx/html/

EXPOSE 8080
