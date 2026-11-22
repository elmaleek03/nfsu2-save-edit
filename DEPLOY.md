# Deploy

Static site in a container: nginx serves four files and the app does everything
else in the visitor's browser. There is no backend, no database, no state on the
server — a restart loses nothing, and a save never leaves the visitor's machine.

## 1. Get the files onto the VPS

```sh
rsync -av --exclude test --exclude _harness.html \
  ./nfsu2-save-editor/ user@your-vps:/opt/nfsu2-save-editor/
```

Or `git` / `scp` — anything that lands the folder whole. The build needs
`index.html styles.css core.js app.js favicon.svg nginx.conf Dockerfile` and,
on the VPS, `docker-compose.yml`.

## 2. Start it

```sh
cd /opt/nfsu2-save-editor
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8007/healthz   # -> ok
```

Open `http://YOUR-VPS-IP:8007/`. The container is `nginx-unprivileged:1.27-alpine`
on internal port `8080`, published as host `8007`, running as uid 101 — no root
inside the container, no ports < 1024.

## 3. Firewall

```sh
ufw allow 8007/tcp      # only if you are NOT putting a proxy in front
```

## 4. TLS in front (recommended)

Keep 8007 bound to loopback and let a proxy own 443. Change the compose port to:

```yaml
    ports:
      - "127.0.0.1:8007:8080"
```

Caddy, three lines:

```
nfsu2.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8007
}
```

With plain nginx, the equivalent is `proxy_pass http://127.0.0.1:8007;` plus the
usual `proxy_set_header Host $host;` and a certbot certificate. Either way the
app needs nothing special from the proxy — no websockets, no streaming, no
uploads. The container already sends CSP and the security headers, so do not
overwrite them at the proxy.

## 5. Update

```sh
rsync -av --exclude test ./nfsu2-save-editor/ user@your-vps:/opt/nfsu2-save-editor/
ssh user@your-vps 'cd /opt/nfsu2-save-editor && docker compose up -d --build'
```

Bake-in beats bind-mounts here: the image contains the files, so there is no
SELinux/`:z` dance and no chance of serving a half-synced directory. Every
response is `Cache-Control: no-cache`, so a normal reload shows the new build.

## 6. When it does not come up

```sh
docker compose logs -f editor        # nginx errors land here
ss -ltnp | grep 8007                 # something else on the port?
docker compose exec editor wget -qO- http://127.0.0.1:8080/healthz
```

- `port is already allocated` — another stack holds 8007; change the left side.
- `exec format error` — you built on a different architecture than the VPS. Build
  on the VPS (as above) or add `platform: linux/amd64`.
- 502 from a proxy — the container is up but the proxy points at the wrong port;
  it must target the *host* port (8007), not 8080.

## 7. Without Docker

```sh
sudo mkdir -p /srv/nfsu2 && sudo cp index.html styles.css core.js app.js favicon.svg /srv/nfsu2/
python3 -m http.server 8007 --bind 127.0.0.1 --directory /srv/nfsu2
```

Good enough behind a proxy for personal use; you lose gzip, the security headers
and the no-cache rule unless you add an nginx `server` block with the contents of
`nginx.conf` (change `listen 8080` to your port and `root` to `/srv/nfsu2`).

## Notes

- No secure-context APIs are used (`DecompressionStream`, `Blob`, `File` all work
  on plain HTTP), so `http://IP:8007` is fine — but TLS is still worth it if you
  ever link the tool publicly.
- The image is ~20 MB. Nothing writes to disk at runtime.
- `test/` is dev-only and excluded from the image by `.dockerignore`.
