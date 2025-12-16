# Movie RSS App - AI Agent Instructions

## Project Architecture

**Full-Stack React + Node.js application** for searching The Movie Database (TMDB) API and managing an RSS feed of selected movies.

- **Frontend**: React (Create React App) on `http://localhost:3000`
- **Backend**: Express.js server on `http://localhost:5000`
- **Data Flow**: React searches TMDB API → User adds movies → Backend stores in memory → Generates RSS feed

### Key Components

- [frontend/src/MovieSearch.js](frontend/src/MovieSearch.js) - Main UI component handling auth, search, and RSS interactions
- [frontend/src/allowedUsers.js](frontend/src/allowedUsers.js) - Hardcoded username allowlist (jordan, vanessa, jel, david)
- [backend/server.js](backend/server.js) - Express API with `/add-to-rss`, `/remove-from-rss`, `/rss-movies`, `/rss-feed` endpoints

## Critical Implementation Details

### Authentication (Frontend-Only)
- **No backend auth**: Frontend validates usernames against `allowedUsers` array before UI access
- **No persistence**: Authentication state only in React component
- **Security Note**: This is client-side only - production needs real authentication

### Data Storage (In-Memory)
- **Backend uses global `movies = []` array** - resets on server restart
- **No database**: All movie data lost between sessions
- **Production Issue**: Need persistent storage (MongoDB, PostgreSQL, etc.)

### CORS Configuration
- Backend configured with `cors({ origin: 'http://localhost:3000' })`
- Update origin URL if frontend host changes

### External Dependencies
- **TMDB API**: Movie search uses hardcoded API key in [MovieSearch.js](frontend/src/MovieSearch.js#L38) - expose to `REACT_APP_TMDB_API_KEY` environment variable
- **RSS Generation**: `rss` package v1.2.2 creates RSS XML with title, description, URL

## Development Workflow

### Start Both Servers
```bash
# Terminal 1: Frontend
cd frontend && npm start

# Terminal 2: Backend
cd backend && npm install && node server.js
```

### Frontend Build & Test
```bash
npm run build   # Production bundle
npm test        # Jest test runner in watch mode
```

### Common Ports
- Frontend: 3000 (React dev server)
- Backend: 5000 (Express API)
- TMDB API: https://api.themoviedb.org/3/search/movie

## Code Patterns & Conventions

### React Patterns
- **Hooks-based**: `useState` for UI state, `useEffect` for RSS fetch on mount
- **Axios for HTTP**: Consistent use across add/remove/fetch operations
- **Conditional Rendering**: `isAuthenticated` gate for login vs. search UI
- **Movie State Tracking**: `rssMovies` array used to determine button state (add vs. remove)

### Naming Conventions
- Movie data from TMDB: `movie.id`, `movie.title`, `movie.overview`, `movie.poster_path`, `movie.release_date`
- Component state: `isAuthenticated`, `rssMovies` (plural for arrays)
- Event handlers: `handleLogin`, `handleSearch`, `handleAddToRSS`, `handleRemoveFromRSS`

### Error Handling
- **Frontend**: Try-catch with console.error + user alerts
- **Backend**: Check response.data.success flag; filter operations verify array length change
- **Example**: [MovieSearch.js](frontend/src/MovieSearch.js#L63) checks `response.data.success` before updating UI state

### API Response Format
**Backend responses follow this pattern:**
```json
{ "success": true, "message": "Movie added to RSS" }
```

## Integration Points

### Frontend-to-Backend Communication
- `POST /add-to-rss` - Body: `{ movie: {...} }` where movie is TMDB object
- `DELETE /remove-from-rss/:id` - URL parameter is movie.id (number)
- `GET /rss-movies` - Returns entire movies array (used to refresh state on mount)
- `GET /rss-feed` - Returns XML (content-type: application/rss+xml)

### TMDB API Integration
- **Search endpoint**: `https://api.themoviedb.org/3/search/movie?api_key=KEY&query=QUERY`
- **Image URL format**: `https://image.tmdb.org/t/p/w200{poster_path}`

## Before Making Changes

1. **Clarify scope**: Auth/persistence decisions require architectural changes
2. **Test client-side state**: Verify `rssMovies` sync between UI and backend
3. **CORS implications**: Backend origin whitelist must match deployment URLs
4. **In-memory data**: Remember movies reset on server restart - plan storage before scaling
