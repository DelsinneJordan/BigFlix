# BigFlix

A personal media request platform designed to control which movies and TV series should be downloaded by Radarr and Sonarr, while providing full awareness of content availability across one or multiple Plex servers.

## Features

- **TMDB-Powered Search**: Search movies and TV shows using The Movie Database as the authoritative source for metadata
- **Plex Awareness**: See what content is already available on your Plex servers
- **Radarr/Sonarr Integration**: Check download status and push content directly to your *arr apps
- **Multi-Server Support**: Manage multiple Plex servers, each with its own Radarr/Sonarr instance
- **Request System**: Users can request content, with optional admin approval workflow
- **TV Season Selection**: Request specific seasons for TV shows
- **Role-Based Access**: Admin and user roles with configurable permissions
- **Self-Hosted**: Run everything in a single Docker container
- **Zero Environment Variables**: All configuration done through the web UI

## Quick Start

### Using Docker Compose (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/yourusername/bigflix.git
cd bigflix
```

2. Start the container:
```bash
docker-compose up -d
```

3. Open your browser to `http://localhost:3000`

4. Complete the setup wizard:
   - Create your admin account
   - Configure your TMDB API key
   - Add your first Plex server
   - (Optional) Configure Radarr/Sonarr

### Using Docker

```bash
docker build -t bigflix .
docker run -d \
  -p 3000:3000 \
  -v bigflix_data:/app/data \
  --name bigflix \
  bigflix
```

### Development Setup

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Start backend (terminal 1)
cd backend
npm run dev

# Start frontend (terminal 2)
cd frontend
npm start
```

## Configuration

All configuration is done through the web interface. On first run, you'll be guided through:

1. **Admin Account**: Create your administrator username and password
2. **TMDB API Key**: Get a free API key from [themoviedb.org](https://www.themoviedb.org/settings/api)
3. **Plex Server**: Add your Plex server URL and authentication token
4. **Radarr/Sonarr** (Optional): Connect your download managers for RSS feed generation

### Getting Your Plex Token

1. Sign in to Plex Web App
2. Open any media item
3. Click the "..." menu → Get Info
4. View the XML and find `X-Plex-Token` in the URL

### RSS Feed URLs

After setup, you can configure Radarr and Sonarr to import from these RSS feeds:

- **Radarr**: `http://your-server:3000/api/rss/radarr/{server-id}`
- **Sonarr**: `http://your-server:3000/api/rss/sonarr/{server-id}`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       BigFlix                           │
├─────────────────────────────────────────────────────────┤
│  Frontend (React)              Backend (Express.js)     │
│  ├── Search UI          ◄───► ├── REST API              │
│  ├── Request System           ├── SQLite Database       │
│  ├── Admin Dashboard          ├── JWT Authentication    │
│  └── Setup Wizard             └── RSS Feed Generation   │
├─────────────────────────────────────────────────────────┤
│                    External Services                    │
│  ├── TMDB API (Movie/TV metadata)                       │
│  ├── Plex (Availability checking)                       │
│  ├── Radarr (Movie download status)                     │
│  └── Sonarr (TV download status)                        │
└─────────────────────────────────────────────────────────┘
```

## User Permissions

| Feature | Admin | User (Direct Add) | User (Request Only) |
|---------|-------|-------------------|---------------------|
| Search content | ✓ | ✓ | ✓ |
| Add to RSS directly | ✓ | ✓ | ✗ |
| Submit requests | ✓ | ✓ | ✓ |
| Approve/reject requests | ✓ | ✗ | ✗ |
| Manage users | ✓ | ✗ | ✗ |
| Manage servers | ✓ | ✗ | ✗ |
| View audit log | ✓ | ✗ | ✗ |
| Backup/restore | ✓ | ✗ | ✗ |

## API Endpoints

### Public
- `GET /api/health` - Health check
- `GET /api/setup/status` - Check if setup is complete
- `POST /api/auth/login` - User login
- `POST /api/setup/*` - Setup wizard endpoints

### Protected (Requires Authentication)
- `GET /api/search/movie?query=...` - Search movies
- `GET /api/search/tv?query=...` - Search TV shows
- `POST /api/requests` - Create content request
- `GET /api/requests` - List requests
- `GET /api/rss/items` - List RSS items

### Admin Only
- `GET /api/users` - List users
- `POST /api/users` - Create user
- `GET /api/servers` - List servers
- `POST /api/servers` - Add server
- `GET /api/admin/stats` - System statistics
- `GET /api/admin/audit-log` - Audit log
- `POST /api/backup/export` - Export backup
- `POST /api/backup/import` - Import backup

## Backup & Restore

The backup system exports all data including:
- User accounts (passwords are hashed)
- Server configurations (credentials encrypted)
- Content requests
- RSS items
- Settings

Backups are encrypted with a password you provide during export.

## Security

- Passwords are hashed with bcrypt (cost factor 12)
- Sensitive data (API keys, tokens) encrypted with AES-256-CBC
- JWT tokens for session management
- Rate limiting on all endpoints
- CORS protection

## Troubleshooting

### Container won't start
Check logs: `docker-compose logs -f`

### Can't connect to Plex
- Verify the Plex URL is accessible from the container
- Ensure your Plex token is correct
- Check firewall rules

### TMDB search not working
- Verify your API key at themoviedb.org
- Check for rate limiting (TMDB allows 40 requests/10 seconds)

### RSS feed empty
- Ensure you've added content to the download queue
- Verify the server ID in the RSS URL

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.
