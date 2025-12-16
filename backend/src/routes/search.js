/**
 * Search Routes
 * Unified search for movies and TV series with enriched metadata
 */

const express = require('express');
const axios = require('axios');
const db = require('../database');
const { decrypt } = require('../database');

const router = express.Router();

// Cache for availability data
const availabilityCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get TMDB API key
 */
function getTmdbApiKey() {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('tmdb_api_key');
  if (!setting) return null;
  return decrypt(setting.value);
}

/**
 * GET /api/search/movies
 * Search for movies via TMDB
 */
router.get('/movies', async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const apiKey = getTmdbApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API not configured' });
    }

    // Search TMDB
    const response = await axios.get('https://api.themoviedb.org/3/search/movie', {
      params: {
        api_key: apiKey,
        query,
        page,
        include_adult: false
      }
    });

    // Enrich results with availability data
    const enrichedResults = await enrichMovieResults(response.data.results, req.user);

    res.json({
      page: response.data.page,
      totalPages: response.data.total_pages,
      totalResults: response.data.total_results,
      results: enrichedResults
    });
  } catch (error) {
    console.error('Movie search error:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/search/tv
 * Search for TV series via TMDB
 */
router.get('/tv', async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const apiKey = getTmdbApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API not configured' });
    }

    // Search TMDB
    const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: {
        api_key: apiKey,
        query,
        page,
        include_adult: false
      }
    });

    // Enrich results with availability data
    const enrichedResults = await enrichTvResults(response.data.results, req.user);

    res.json({
      page: response.data.page,
      totalPages: response.data.total_pages,
      totalResults: response.data.total_results,
      results: enrichedResults
    });
  } catch (error) {
    console.error('TV search error:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/search/multi
 * Combined search for movies and TV
 */
router.get('/multi', async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const apiKey = getTmdbApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API not configured' });
    }

    // Search TMDB
    const response = await axios.get('https://api.themoviedb.org/3/search/multi', {
      params: {
        api_key: apiKey,
        query,
        page,
        include_adult: false
      }
    });

    // Filter to only movies and TV shows
    const filtered = response.data.results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');

    // Separate movies and TV for enrichment
    const movies = filtered.filter(r => r.media_type === 'movie');
    const tv = filtered.filter(r => r.media_type === 'tv');

    // Enrich both
    const [enrichedMovies, enrichedTv] = await Promise.all([
      enrichMovieResults(movies, req.user),
      enrichTvResults(tv, req.user)
    ]);

    // Combine and maintain order
    const results = filtered.map(item => {
      if (item.media_type === 'movie') {
        return enrichedMovies.find(m => m.id === item.id);
      } else {
        return enrichedTv.find(t => t.id === item.id);
      }
    });

    res.json({
      page: response.data.page,
      totalPages: response.data.total_pages,
      totalResults: response.data.total_results,
      results
    });
  } catch (error) {
    console.error('Multi search error:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/search/movie/:id
 * Get movie details
 */
router.get('/movie/:id', async (req, res) => {
  try {
    const apiKey = getTmdbApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API not configured' });
    }

    const response = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}`, {
      params: {
        api_key: apiKey,
        append_to_response: 'credits,videos,images'
      }
    });

    // Enrich with availability
    const [enriched] = await enrichMovieResults([response.data], req.user);

    res.json(enriched);
  } catch (error) {
    console.error('Movie details error:', error.message);
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Movie not found' });
    }
    res.status(500).json({ error: 'Failed to get movie details' });
  }
});

/**
 * GET /api/search/tv/:id
 * Get TV series details
 */
router.get('/tv/:id', async (req, res) => {
  try {
    const apiKey = getTmdbApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API not configured' });
    }

    const response = await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}`, {
      params: {
        api_key: apiKey,
        append_to_response: 'credits,videos,images'
      }
    });

    // Enrich with availability and season info
    const [enriched] = await enrichTvResults([response.data], req.user, true);

    res.json(enriched);
  } catch (error) {
    console.error('TV details error:', error.message);
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'TV series not found' });
    }
    res.status(500).json({ error: 'Failed to get TV details' });
  }
});

/**
 * Enrich movie results with availability data
 */
async function enrichMovieResults(movies, user) {
  const results = [];
  
  for (const movie of movies) {
    const availability = await checkMovieAvailability(movie, user);
    
    results.push({
      id: movie.id,
      title: movie.title,
      overview: movie.overview,
      posterPath: movie.poster_path,
      backdropPath: movie.backdrop_path,
      releaseDate: movie.release_date,
      year: movie.release_date ? parseInt(movie.release_date.split('-')[0]) : null,
      voteAverage: movie.vote_average,
      mediaType: 'movie',
      ...availability
    });
  }
  
  return results;
}

/**
 * Enrich TV results with availability data
 */
async function enrichTvResults(shows, user, includeSeasons = false) {
  const results = [];
  
  for (const show of shows) {
    const availability = await checkTvAvailability(show, user);
    
    const result = {
      id: show.id,
      title: show.name,
      overview: show.overview,
      posterPath: show.poster_path,
      backdropPath: show.backdrop_path,
      firstAirDate: show.first_air_date,
      year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : null,
      voteAverage: show.vote_average,
      mediaType: 'tv',
      numberOfSeasons: show.number_of_seasons,
      ...availability
    };

    if (includeSeasons && show.seasons) {
      result.seasons = show.seasons.map(s => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airDate: s.air_date,
        posterPath: s.poster_path
      }));
    }
    
    results.push(result);
  }
  
  return results;
}

/**
 * Check movie availability across user's servers
 */
async function checkMovieAvailability(movie, user) {
  const result = {
    status: 'unknown',
    plexAvailable: false,
    plexServers: [],
    radarrStatus: null,
    inRssFeed: false
  };

  // Get user's servers
  const servers = user?.servers || [];
  
  for (const server of servers) {
    // Check Plex
    const plexResult = await checkPlexMovie(server.id, movie.title, movie.release_date?.split('-')[0]);
    if (plexResult.exists) {
      result.plexAvailable = true;
      result.plexServers.push(server.name);
    }

    // Check Radarr (for primary server)
    if (server.id === user.primaryServerId) {
      const radarrResult = await checkRadarrMovie(server.id, movie.id);
      if (radarrResult) {
        result.radarrStatus = radarrResult;
      }
    }
  }

  // Check RSS feed
  const rssItem = db.prepare(`
    SELECT * FROM rss_items 
    WHERE tmdb_id = ? AND content_type = 'movie'
  `).get(movie.id);
  result.inRssFeed = !!rssItem;

  // Determine overall status
  if (result.plexAvailable) {
    result.status = 'available';
  } else if (result.radarrStatus) {
    result.status = result.radarrStatus;
  } else if (result.inRssFeed) {
    result.status = 'requested';
  } else {
    result.status = 'not_available';
  }

  return result;
}

/**
 * Check TV availability across user's servers
 */
async function checkTvAvailability(show, user) {
  const result = {
    status: 'unknown',
    plexAvailable: false,
    plexServers: [],
    sonarrStatus: null,
    inRssFeed: false
  };

  const servers = user.servers || [];
  
  for (const server of servers) {
    // Check Plex
    const plexResult = await checkPlexTv(server.id, show.name, show.first_air_date?.split('-')[0]);
    if (plexResult.exists) {
      result.plexAvailable = true;
      result.plexServers.push(server.name);
    }

    // Check Sonarr (for primary server)
    if (server.id === user.primaryServerId) {
      const sonarrResult = await checkSonarrSeries(server.id, show.id);
      if (sonarrResult) {
        result.sonarrStatus = sonarrResult;
      }
    }
  }

  // Check RSS feed
  const rssItem = db.prepare(`
    SELECT * FROM rss_items 
    WHERE tmdb_id = ? AND content_type = 'tv'
  `).get(show.id);
  result.inRssFeed = !!rssItem;

  // Determine overall status
  if (result.plexAvailable) {
    result.status = 'available';
  } else if (result.sonarrStatus) {
    result.status = result.sonarrStatus;
  } else if (result.inRssFeed) {
    result.status = 'requested';
  } else {
    result.status = 'not_available';
  }

  return result;
}

/**
 * Check if movie exists in Plex
 */
async function checkPlexMovie(serverId, title, year) {
  try {
    const cacheKey = `plex_movie_${serverId}_${title}_${year}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(serverId);
    if (!server) return { exists: false };

    const token = decrypt(server.token);
    
    // Get all library sections to find movie libraries
    const sectionsResponse = await axios.get(`${server.url}/library/sections`, {
      headers: { 
        'X-Plex-Token': token,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const movieSections = sectionsResponse.data.MediaContainer.Directory
      .filter(d => d.type === 'movie')
      .map(d => d.key);

    // Search each movie library
    for (const sectionId of movieSections) {
      const response = await axios.get(`${server.url}/library/sections/${sectionId}/all`, {
        headers: { 
          'X-Plex-Token': token,
          'Accept': 'application/json'
        },
        params: {
          type: 1, // Movie
          'title': title
        },
        timeout: 10000
      });

      const movies = response.data.MediaContainer.Metadata || [];
      const match = movies.find(m => {
        const titleMatch = m.title.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || m.year === parseInt(year);
        return titleMatch && yearMatch;
      });

      if (match) {
        const result = { exists: true, movie: match };
        availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
      }
    }

    const result = { exists: false };
    availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('Plex movie check error:', error.message);
    return { exists: false };
  }
}

/**
 * Check if TV show exists in Plex
 */
async function checkPlexTv(serverId, title, year) {
  try {
    const cacheKey = `plex_tv_${serverId}_${title}_${year}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(serverId);
    if (!server) return { exists: false };

    const token = decrypt(server.token);
    
    // Get TV library sections
    const sectionsResponse = await axios.get(`${server.url}/library/sections`, {
      headers: { 
        'X-Plex-Token': token,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const tvSections = sectionsResponse.data.MediaContainer.Directory
      .filter(d => d.type === 'show')
      .map(d => d.key);

    for (const sectionId of tvSections) {
      const response = await axios.get(`${server.url}/library/sections/${sectionId}/all`, {
        headers: { 
          'X-Plex-Token': token,
          'Accept': 'application/json'
        },
        params: {
          type: 2, // TV Show
          'title': title
        },
        timeout: 10000
      });

      const shows = response.data.MediaContainer.Metadata || [];
      const match = shows.find(s => {
        const titleMatch = s.title.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || s.year === parseInt(year);
        return titleMatch && yearMatch;
      });

      if (match) {
        const result = { exists: true, show: match };
        availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
      }
    }

    const result = { exists: false };
    availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('Plex TV check error:', error.message);
    return { exists: false };
  }
}

/**
 * Check movie status in Radarr
 */
async function checkRadarrMovie(serverId, tmdbId) {
  try {
    const cacheKey = `radarr_${serverId}_${tmdbId}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(serverId);
    if (!server || !server.radarr_url || !server.radarr_api_key) return null;

    const apiKey = decrypt(server.radarr_api_key);
    
    // Search by TMDB ID
    const response = await axios.get(`${server.radarr_url}/api/v3/movie`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    const movie = response.data.find(m => m.tmdbId === tmdbId);
    
    let status = null;
    if (movie) {
      if (movie.hasFile) {
        status = 'downloaded';
      } else if (movie.monitored) {
        // Check queue
        const queueResponse = await axios.get(`${server.radarr_url}/api/v3/queue`, {
          headers: { 'X-Api-Key': apiKey },
          timeout: 10000
        });
        const inQueue = queueResponse.data.records?.some(q => q.movieId === movie.id);
        status = inQueue ? 'queued' : (movie.status === 'released' ? 'missing' : 'unreleased');
      }
    }

    availabilityCache.set(cacheKey, { data: status, timestamp: Date.now() });
    return status;
  } catch (error) {
    console.error('Radarr check error:', error.message);
    return null;
  }
}

/**
 * Check series status in Sonarr
 */
async function checkSonarrSeries(serverId, tmdbId) {
  try {
    const cacheKey = `sonarr_${serverId}_${tmdbId}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(serverId);
    if (!server || !server.sonarr_url || !server.sonarr_api_key) return null;

    const apiKey = decrypt(server.sonarr_api_key);
    
    // Sonarr uses TVDB, so we need to look up by title
    // First get all series
    const response = await axios.get(`${server.sonarr_url}/api/v3/series`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    // Find series by TVDB ID (Sonarr doesn't use TMDB ID directly)
    // For now, return null if not found - in production you'd convert TMDB to TVDB
    const status = null;

    availabilityCache.set(cacheKey, { data: status, timestamp: Date.now() });
    return status;
  } catch (error) {
    console.error('Sonarr check error:', error.message);
    return null;
  }
}

module.exports = router;
