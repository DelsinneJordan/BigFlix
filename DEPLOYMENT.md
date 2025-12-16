# BigFlix - Production Deployment Guide

## Quick Start (Docker)

### Prerequisites
- Docker and Docker Compose installed
- Access to your Plex, Radarr, and Sonarr servers
- TMDB API key (get one free at https://www.themoviedb.org/settings/api)

### Step 1: Build and Run

```bash
# Clone or copy the project to your server
cd bigflix

# Build and start the container
docker-compose up -d --build

# Check logs
docker-compose logs -f
```

### Step 2: Access the App

Open `http://your-server-ip:3000` in your browser.

### Step 3: Initial Setup

1. Create your admin account (first screen)
2. Enter your TMDB API key
3. Configure your Plex server:
   - **URL**: `http://plex-ip:32400` (use internal Docker network IP if on same host)
   - **Token**: Get from Plex (see below)
4. Configure Radarr:
   - **URL**: `http://radarr-ip:7878`
   - **API Key**: Found in Radarr → Settings → General
5. Configure Sonarr:
   - **URL**: `http://sonarr-ip:8989`
   - **API Key**: Found in Sonarr → Settings → General

---

## Getting Your Plex Token

1. Sign in to Plex Web App
2. Browse to a library item
3. Click "Get Info" → "View XML"
4. Look at the URL for `X-Plex-Token=YOUR_TOKEN`

Or use this URL (after signing in):
```
https://plex.tv/devices.xml
```

---

## Production Configuration Options

### Environment Variables

Create a `.env` file (optional):

```env
NODE_ENV=production
PORT=3000
TZ=America/New_York
```

### Custom Port

Edit `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"  # Access on port 8080
```

### Custom Data Location

```yaml
volumes:
  - /path/to/your/data:/app/data
```

---

## Reverse Proxy Setup (Recommended)

### Nginx

```nginx
server {
    listen 80;
    server_name media.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Traefik (docker-compose)

```yaml
services:
  bigflix:
    build: .
    container_name: bigflix
    restart: unless-stopped
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.bigflix.rule=Host(`media.yourdomain.com`)"
      - "traefik.http.routers.bigflix.entrypoints=websecure"
      - "traefik.http.routers.bigflix.tls.certresolver=letsencrypt"
      - "traefik.http.services.bigflix.loadbalancer.server.port=3000"
    volumes:
      - bigflix_data:/app/data
    networks:
      - traefik

networks:
  traefik:
    external: true

volumes:
  bigflix_data:
```

### Caddy

```caddyfile
media.yourdomain.com {
    reverse_proxy localhost:3000
}
```

---

## SSL/HTTPS

### Option 1: Let's Encrypt with Nginx

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d media.yourdomain.com
```

### Option 2: Cloudflare Tunnel (Recommended for Home Servers)

1. Install cloudflared
2. Create tunnel: `cloudflared tunnel create bigflix`
3. Configure tunnel to point to `http://localhost:3000`
4. Run: `cloudflared tunnel run bigflix`

---

## Docker Network (Same Host as Plex/Radarr/Sonarr)

If running on the same Docker host, use Docker networks:

```yaml
version: '3.8'

services:
  bigflix:
    build: .
    container_name: bigflix
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - bigflix_data:/app/data
    networks:
      - media_network

networks:
  media_network:
    external: true  # Connect to existing network

volumes:
  bigflix_data:
```

Then reference services by container name:
- Plex URL: `http://plex:32400`
- Radarr URL: `http://radarr:7878`
- Sonarr URL: `http://sonarr:8989`

---

## Backup & Restore

### Backup Database

```bash
# Copy SQLite database
docker cp bigflix:/app/data/bigflix.db ./backup/

# Or if using volume
docker run --rm -v bigflix_data:/data -v $(pwd):/backup alpine \
  cp /data/bigflix.db /backup/
```

### Restore Database

```bash
docker cp ./backup/bigflix.db bigflix:/app/data/
docker restart bigflix
```

---

## Updating

```bash
# Pull latest changes (if using git)
git pull

# Rebuild and restart
docker-compose down
docker-compose up -d --build

# Or one command
docker-compose up -d --build --force-recreate
```

---

## Troubleshooting

### Check Logs
```bash
docker-compose logs -f
docker logs bigflix
```

### Database Issues
```bash
# Reset database (WARNING: deletes all data)
docker-compose down
docker volume rm bigflix_bigflix_data
docker-compose up -d
```

### Connection Issues to Plex/Radarr/Sonarr

1. Ensure URLs are accessible from the container
2. For same-host Docker: use container names or host.docker.internal
3. Check firewall rules
4. Test with curl:
   ```bash
   docker exec bigflix wget -qO- http://radarr:7878/api/v3/health
   ```

### Permission Issues
```bash
# Fix volume permissions
docker exec media-manager chown -R node:node /app/data
```

---

## Security Recommendations

1. **Always use HTTPS** in production (reverse proxy + SSL)
2. **Change default ports** if exposed to internet
3. **Use strong admin password**
4. **Keep Docker and dependencies updated**
5. **Consider using Cloudflare Tunnel** for home servers (no port forwarding needed)
6. **Backup regularly**

---

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Web Browser   │────▶│     BigFlix     │
└─────────────────┘     │   (Port 3000)   │
                        └────────┬────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│      Plex       │     │     Radarr      │     │     Sonarr      │
│  (Port 32400)   │     │   (Port 7878)   │     │   (Port 8989)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Support

If you encounter issues:
1. Check the logs first
2. Verify network connectivity to Plex/Radarr/Sonarr
3. Ensure API keys are correct
4. Test the "Test Connection" button in Admin → Servers
