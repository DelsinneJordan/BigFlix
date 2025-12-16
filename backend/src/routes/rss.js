/**
 * RSS Feed Routes
 * RSS feed generation for Radarr and Sonarr
 */

const express = require('express');
const RSS = require('rss');
const db = require('../database');
const { optionalAuth, authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/rss/movies/:serverId
 * Get movie RSS feed for a specific server
 */
router.get('/movies/:serverId', (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const items = db.prepare(`
      SELECT * FROM rss_items 
      WHERE server_id = ? AND content_type = 'movie'
      ORDER BY added_at DESC
    `).all(req.params.serverId);

    const feed = new RSS({
      title: `${server.name} - Movie Requests`,
      description: `Movies requested for ${server.name}`,
      feed_url: `${req.protocol}://${req.get('host')}/api/rss/movies/${server.id}`,
      site_url: `${req.protocol}://${req.get('host')}`,
      language: 'en'
    });

    items.forEach(item => {
      feed.item({
        title: item.title,
        description: item.overview || '',
        url: `https://www.themoviedb.org/movie/${item.tmdb_id}`,
        guid: item.id,
        date: new Date(item.added_at),
        custom_elements: [
          { 'tmdb:id': item.tmdb_id },
          { 'media:year': item.year }
        ]
      });
    });

    res.set('Content-Type', 'application/rss+xml');
    res.send(feed.xml());
  } catch (error) {
    console.error('Movie RSS feed error:', error.message);
    res.status(500).json({ error: 'Failed to generate RSS feed' });
  }
});

/**
 * GET /api/rss/tv/:serverId
 * Get TV series RSS feed for a specific server
 */
router.get('/tv/:serverId', (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const items = db.prepare(`
      SELECT * FROM rss_items 
      WHERE server_id = ? AND content_type = 'tv'
      ORDER BY added_at DESC
    `).all(req.params.serverId);

    const feed = new RSS({
      title: `${server.name} - TV Series Requests`,
      description: `TV series requested for ${server.name}`,
      feed_url: `${req.protocol}://${req.get('host')}/api/rss/tv/${server.id}`,
      site_url: `${req.protocol}://${req.get('host')}`,
      language: 'en'
    });

    items.forEach(item => {
      const seasons = item.seasons ? JSON.parse(item.seasons) : null;
      feed.item({
        title: item.title,
        description: item.overview || '',
        url: `https://www.themoviedb.org/tv/${item.tmdb_id}`,
        guid: item.id,
        date: new Date(item.added_at),
        custom_elements: [
          { 'tmdb:id': item.tmdb_id },
          { 'media:year': item.year },
          { 'media:seasons': seasons ? seasons.join(',') : 'all' }
        ]
      });
    });

    res.set('Content-Type', 'application/rss+xml');
    res.send(feed.xml());
  } catch (error) {
    console.error('TV RSS feed error:', error.message);
    res.status(500).json({ error: 'Failed to generate RSS feed' });
  }
});

/**
 * GET /api/rss/items
 * List RSS items for the user's servers
 */
router.get('/items', authenticateToken, (req, res) => {
  try {
    const { serverId, type } = req.query;
    
    let sql = 'SELECT r.*, u.username as added_by_username, s.name as server_name FROM rss_items r';
    sql += ' LEFT JOIN users u ON r.added_by = u.id';
    sql += ' LEFT JOIN plex_servers s ON r.server_id = s.id';
    
    const conditions = [];
    const params = [];

    // Filter by user's servers
    if (req.user.role !== 'admin') {
      const serverIds = req.user.servers.map(s => s.id);
      if (serverIds.length === 0) {
        return res.json([]);
      }
      conditions.push(`r.server_id IN (${serverIds.map(() => '?').join(',')})`);
      params.push(...serverIds);
    }

    if (serverId) {
      conditions.push('r.server_id = ?');
      params.push(serverId);
    }

    if (type) {
      conditions.push('r.content_type = ?');
      params.push(type);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY r.added_at DESC';

    const items = db.prepare(sql).all(...params);

    res.json(items.map(item => ({
      id: item.id,
      serverId: item.server_id,
      serverName: item.server_name,
      contentType: item.content_type,
      tmdbId: item.tmdb_id,
      title: item.title,
      year: item.year,
      overview: item.overview,
      posterPath: item.poster_path,
      seasons: item.seasons ? JSON.parse(item.seasons) : null,
      addedBy: item.added_by_username,
      addedAt: item.added_at
    })));
  } catch (error) {
    console.error('List RSS items error:', error.message);
    res.status(500).json({ error: 'Failed to list RSS items' });
  }
});

/**
 * DELETE /api/rss/items/:id
 * Remove an item from RSS feed
 */
router.delete('/items/:id', authenticateToken, (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM rss_items WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Check access
    if (req.user.role !== 'admin') {
      const hasAccess = req.user.servers.some(s => s.id === item.server_id);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // Non-admins can only remove items they added
      if (item.added_by !== req.user.id) {
        return res.status(403).json({ error: 'Can only remove items you added' });
      }
    }

    db.prepare('DELETE FROM rss_items WHERE id = ?').run(item.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'remove_rss_item', `Removed ${item.content_type}: ${item.title}`, req.ip);

    res.json({ message: 'Item removed from RSS feed' });
  } catch (error) {
    console.error('Remove RSS item error:', error.message);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

module.exports = router;
