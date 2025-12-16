/**
 * Request Routes
 * Content request and approval workflow
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');
const { decrypt } = require('../database');

const router = express.Router();

/**
 * Add movie to Radarr
 */
async function addToRadarr(server, tmdbId, title) {
  if (!server.radarr_url || !server.radarr_api_key) {
    return { success: false, error: 'Radarr not configured' };
  }

  const apiKey = decrypt(server.radarr_api_key);
  
  try {
    // First, lookup the movie in Radarr
    const lookupResponse = await axios.get(`${server.radarr_url}/api/v3/movie/lookup/tmdb`, {
      headers: { 'X-Api-Key': apiKey },
      params: { tmdbId },
      timeout: 10000
    });

    if (!lookupResponse.data) {
      return { success: false, error: 'Movie not found in TMDB' };
    }

    const movieData = lookupResponse.data;

    // Get root folder
    const rootFolderResponse = await axios.get(`${server.radarr_url}/api/v3/rootfolder`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });
    
    if (!rootFolderResponse.data || rootFolderResponse.data.length === 0) {
      return { success: false, error: 'No root folder configured in Radarr' };
    }

    const rootFolderPath = rootFolderResponse.data[0].path;

    // Get quality profile
    const profileResponse = await axios.get(`${server.radarr_url}/api/v3/qualityprofile`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });
    
    if (!profileResponse.data || profileResponse.data.length === 0) {
      return { success: false, error: 'No quality profile configured in Radarr' };
    }

    const qualityProfileId = profileResponse.data[0].id;

    // Add the movie to Radarr
    const addResponse = await axios.post(`${server.radarr_url}/api/v3/movie`, {
      title: movieData.title,
      tmdbId: movieData.tmdbId,
      year: movieData.year,
      qualityProfileId: qualityProfileId,
      rootFolderPath: rootFolderPath,
      monitored: true,
      addOptions: {
        searchForMovie: true // Trigger search immediately
      }
    }, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    console.log(`[Radarr] Added movie: ${title} (TMDB: ${tmdbId})`);
    return { success: true, radarrId: addResponse.data.id };
  } catch (error) {
    if (error.response?.status === 400 && error.response?.data?.some?.(e => e.errorCode === 'MovieExistsValidator')) {
      return { success: true, alreadyExists: true };
    }
    console.error(`[Radarr] Error adding movie "${title}":`, error.response?.data || error.message);
    return { success: false, error: error.response?.data?.[0]?.errorMessage || error.message };
  }
}

/**
 * Add series to Sonarr
 */
async function addToSonarr(server, tmdbId, title, seasons) {
  if (!server.sonarr_url || !server.sonarr_api_key) {
    return { success: false, error: 'Sonarr not configured' };
  }

  const apiKey = decrypt(server.sonarr_api_key);
  
  try {
    // Sonarr uses TVDB, so we need to search by name
    const searchResponse = await axios.get(`${server.sonarr_url}/api/v3/series/lookup`, {
      headers: { 'X-Api-Key': apiKey },
      params: { term: title },
      timeout: 10000
    });

    if (!searchResponse.data || searchResponse.data.length === 0) {
      return { success: false, error: 'Series not found' };
    }

    const seriesData = searchResponse.data[0];

    // Get root folder
    const rootFolderResponse = await axios.get(`${server.sonarr_url}/api/v3/rootfolder`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });
    
    if (!rootFolderResponse.data || rootFolderResponse.data.length === 0) {
      return { success: false, error: 'No root folder configured in Sonarr' };
    }

    const rootFolderPath = rootFolderResponse.data[0].path;

    // Get quality profile
    const profileResponse = await axios.get(`${server.sonarr_url}/api/v3/qualityprofile`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });
    
    if (!profileResponse.data || profileResponse.data.length === 0) {
      return { success: false, error: 'No quality profile configured in Sonarr' };
    }

    const qualityProfileId = profileResponse.data[0].id;

    // Add the series to Sonarr
    const addResponse = await axios.post(`${server.sonarr_url}/api/v3/series`, {
      title: seriesData.title,
      tvdbId: seriesData.tvdbId,
      year: seriesData.year,
      qualityProfileId: qualityProfileId,
      rootFolderPath: rootFolderPath,
      monitored: true,
      seasonFolder: true,
      addOptions: {
        searchForMissingEpisodes: true
      }
    }, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    console.log(`[Sonarr] Added series: ${title}`);
    return { success: true, sonarrId: addResponse.data.id };
  } catch (error) {
    if (error.response?.status === 400 && error.response?.data?.some?.(e => e.errorCode === 'SeriesExistsValidator')) {
      return { success: true, alreadyExists: true };
    }
    console.error(`[Sonarr] Error adding series "${title}":`, error.response?.data || error.message);
    return { success: false, error: error.response?.data?.[0]?.errorMessage || error.message };
  }
}

/**
 * GET /api/requests
 * List requests (filtered by user for non-admins)
 */
router.get('/', (req, res) => {
  try {
    const { status, type } = req.query;
    
    let sql = `
      SELECT r.*, u.username as requested_by_username, p.username as processed_by_username,
             s.name as server_name
      FROM content_requests r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN users p ON r.processed_by = p.id
      LEFT JOIN plex_servers s ON r.server_id = s.id
    `;
    
    const conditions = [];
    const params = [];

    // Non-admins only see their own requests
    if (req.user.role !== 'admin') {
      conditions.push('r.user_id = ?');
      params.push(req.user.id);
    }

    if (status) {
      conditions.push('r.status = ?');
      params.push(status);
    }

    if (type) {
      conditions.push('r.content_type = ?');
      params.push(type);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY r.requested_at DESC';

    const requests = db.prepare(sql).all(...params);

    res.json(requests.map(r => ({
      id: r.id,
      userId: r.user_id,
      requestedByUsername: r.requested_by_username,
      serverId: r.server_id,
      serverName: r.server_name,
      tmdbId: r.tmdb_id,
      contentType: r.content_type,
      title: r.title,
      year: r.year,
      overview: r.overview,
      posterPath: r.poster_path,
      status: r.status,
      seasons: r.seasons ? JSON.parse(r.seasons) : null,
      requestedAt: r.requested_at,
      processedAt: r.processed_at,
      processedByUsername: r.processed_by_username,
      notes: r.notes
    })));
  } catch (error) {
    console.error('List requests error:', error.message);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

/**
 * POST /api/requests
 * Create a new content request
 */
router.post('/', async (req, res) => {
  try {
    const { 
      tmdbId, 
      contentType, 
      title, 
      year, 
      overview, 
      posterPath,
      seasons 
    } = req.body;

    // Validation
    if (!tmdbId || !contentType || !title) {
      return res.status(400).json({ error: 'TMDB ID, content type, and title required' });
    }

    if (!['movie', 'tv'].includes(contentType)) {
      return res.status(400).json({ error: 'Invalid content type' });
    }

    // Determine target server
    const serverId = req.user.primaryServerId;
    if (!serverId) {
      return res.status(400).json({ error: 'No server assigned to user' });
    }

    // Get server details
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(serverId);
    if (!server) {
      return res.status(400).json({ error: 'Server not found' });
    }

    // Check if already in Radarr/Sonarr with files (downloaded)
    try {
      if (contentType === 'movie' && server.radarr_url && server.radarr_api_key) {
        const apiKey = decrypt(server.radarr_api_key);
        const response = await axios.get(`${server.radarr_url}/api/v3/movie`, {
          headers: { 'X-Api-Key': apiKey },
          timeout: 10000
        });
        const existingMovie = response.data.find(m => m.tmdbId === tmdbId);
        if (existingMovie && existingMovie.hasFile) {
          return res.status(409).json({ 
            error: 'This movie is already downloaded in Radarr',
            status: 'downloaded'
          });
        }
        if (existingMovie && existingMovie.monitored) {
          return res.status(409).json({ 
            error: 'This movie is already being monitored in Radarr',
            status: existingMovie.status === 'released' ? 'missing' : 'unreleased'
          });
        }
      }
      
      if (contentType === 'tv' && server.sonarr_url && server.sonarr_api_key) {
        const apiKey = decrypt(server.sonarr_api_key);
        const response = await axios.get(`${server.sonarr_url}/api/v3/series`, {
          headers: { 'X-Api-Key': apiKey },
          timeout: 10000
        });
        // Sonarr uses TVDB IDs, but we can check by title/year as fallback
        const existingSeries = response.data.find(s => s.tvdbId && s.title === title);
        if (existingSeries && existingSeries.statistics?.percentOfEpisodes === 100) {
          return res.status(409).json({ 
            error: 'This series is already fully downloaded in Sonarr',
            status: 'downloaded'
          });
        }
      }
    } catch (err) {
      // Don't fail the request if we can't check - just log it
      console.error('Error checking Radarr/Sonarr:', err.message);
    }

    // Check for existing request
    const existing = db.prepare(`
      SELECT * FROM content_requests 
      WHERE tmdb_id = ? AND content_type = ? AND server_id = ? AND status IN ('pending', 'approved')
    `).get(tmdbId, contentType, serverId);

    if (existing) {
      return res.status(409).json({ error: 'Request already exists' });
    }

    // Check if user can add directly
    if (req.user.canAddDirectly) {
      // Add to Radarr/Sonarr directly
      let arrResult = { success: false };
      
      if (contentType === 'movie') {
        arrResult = await addToRadarr(server, tmdbId, title);
      } else if (contentType === 'tv') {
        arrResult = await addToSonarr(server, tmdbId, title, seasons);
      }

      // Also add to RSS feed for tracking
      const rssId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO rss_items (id, server_id, content_type, tmdb_id, title, year, overview, poster_path, seasons, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rssId,
        serverId,
        contentType,
        tmdbId,
        title,
        year || null,
        overview || null,
        posterPath || null,
        seasons ? JSON.stringify(seasons) : null,
        req.user.id
      );

      // Log the action
      db.prepare(`
        INSERT INTO audit_log (user_id, action, details, ip_address)
        VALUES (?, ?, ?, ?)
      `).run(req.user.id, 'add_content', `Added ${contentType}: ${title}`, req.ip);

      if (arrResult.success) {
        return res.status(201).json({ 
          message: `${contentType === 'movie' ? 'Movie' : 'Series'} added to ${contentType === 'movie' ? 'Radarr' : 'Sonarr'} and will start downloading`,
          status: 'added',
          rssId 
        });
      } else {
        return res.status(201).json({ 
          message: `Added to queue but ${contentType === 'movie' ? 'Radarr' : 'Sonarr'} integration failed: ${arrResult.error}`,
          status: 'added',
          warning: arrResult.error,
          rssId 
        });
      }
    }

    // Create request for approval
    const requestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO content_requests (id, user_id, server_id, tmdb_id, content_type, title, year, overview, poster_path, seasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      req.user.id,
      serverId,
      tmdbId,
      contentType,
      title,
      year || null,
      overview || null,
      posterPath || null,
      seasons ? JSON.stringify(seasons) : null
    );

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'request_content', `Requested ${contentType}: ${title}`, req.ip);

    res.status(201).json({ 
      message: 'Request submitted for approval',
      status: 'pending',
      requestId 
    });
  } catch (error) {
    console.error('Create request error:', error.message);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

/**
 * GET /api/requests/pending
 * Get pending requests count (for admin badge)
 */
router.get('/pending', requireAdmin, (req, res) => {
  try {
    const count = db.prepare("SELECT COUNT(*) as count FROM content_requests WHERE status = 'pending'").get();
    res.json({ count: count.count });
  } catch (error) {
    console.error('Pending count error:', error.message);
    res.status(500).json({ error: 'Failed to get pending count' });
  }
});

/**
 * POST /api/requests/:id/approve
 * Approve a request (admin only)
 */
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const request = db.prepare('SELECT * FROM content_requests WHERE id = ?').get(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    const { notes, seasons } = req.body;

    // Get server for Radarr/Sonarr integration
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(request.server_id);
    
    // Add to Radarr/Sonarr
    let arrResult = { success: false };
    if (server) {
      if (request.content_type === 'movie') {
        arrResult = await addToRadarr(server, request.tmdb_id, request.title);
      } else if (request.content_type === 'tv') {
        const seasonList = seasons || (request.seasons ? JSON.parse(request.seasons) : null);
        arrResult = await addToSonarr(server, request.tmdb_id, request.title, seasonList);
      }
    }

    // Add to RSS feed for tracking
    const rssId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO rss_items (id, server_id, content_type, tmdb_id, title, year, overview, poster_path, seasons, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rssId,
      request.server_id,
      request.content_type,
      request.tmdb_id,
      request.title,
      request.year,
      request.overview,
      request.poster_path,
      seasons ? JSON.stringify(seasons) : request.seasons,
      req.user.id
    );

    // Update request status
    db.prepare(`
      UPDATE content_requests 
      SET status = 'approved', processed_at = datetime('now'), processed_by = ?, notes = ?
      WHERE id = ?
    `).run(req.user.id, notes || null, request.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'approve_request', `Approved ${request.content_type}: ${request.title}`, req.ip);

    if (arrResult.success) {
      res.json({ 
        message: `Request approved and added to ${request.content_type === 'movie' ? 'Radarr' : 'Sonarr'}`,
        rssId 
      });
    } else {
      res.json({ 
        message: 'Request approved',
        warning: `${request.content_type === 'movie' ? 'Radarr' : 'Sonarr'} integration failed: ${arrResult.error}`,
        rssId 
      });
    }
  } catch (error) {
    console.error('Approve request error:', error.message);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

/**
 * POST /api/requests/:id/reject
 * Reject a request (admin only)
 */
router.post('/:id/reject', requireAdmin, (req, res) => {
  try {
    const request = db.prepare('SELECT * FROM content_requests WHERE id = ?').get(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    const { notes } = req.body;

    // Update request status
    db.prepare(`
      UPDATE content_requests 
      SET status = 'rejected', processed_at = datetime('now'), processed_by = ?, notes = ?
      WHERE id = ?
    `).run(req.user.id, notes || null, request.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'reject_request', `Rejected ${request.content_type}: ${request.title}`, req.ip);

    res.json({ message: 'Request rejected' });
  } catch (error) {
    console.error('Reject request error:', error.message);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

/**
 * DELETE /api/requests/:id
 * Cancel/delete a request
 */
router.delete('/:id', (req, res) => {
  try {
    const request = db.prepare('SELECT * FROM content_requests WHERE id = ?').get(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Users can only delete their own pending requests
    if (req.user.role !== 'admin') {
      if (request.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Cannot delete processed request' });
      }
    }

    db.prepare('DELETE FROM content_requests WHERE id = ?').run(request.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'delete_request', `Deleted request: ${request.title}`, req.ip);

    res.json({ message: 'Request deleted' });
  } catch (error) {
    console.error('Delete request error:', error.message);
    res.status(500).json({ error: 'Failed to delete request' });
  }
});

module.exports = router;
