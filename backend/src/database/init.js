/**
 * Database Initialization
 * Creates all required tables and initial data
 */

const db = require('./index');

function initializeDatabase() {
  // Create settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      encrypted INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      can_add_directly INTEGER DEFAULT 0,
      primary_server_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      FOREIGN KEY (primary_server_id) REFERENCES plex_servers(id) ON DELETE SET NULL
    )
  `);

  // Create plex_servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS plex_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      token TEXT NOT NULL,
      library_section_id TEXT DEFAULT '1',
      radarr_url TEXT,
      radarr_api_key TEXT,
      sonarr_url TEXT,
      sonarr_api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create user_servers table (many-to-many relationship)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_servers (
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      PRIMARY KEY (user_id, server_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES plex_servers(id) ON DELETE CASCADE
    )
  `);

  // Create content_requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'tv')),
      title TEXT NOT NULL,
      year INTEGER,
      overview TEXT,
      poster_path TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'downloaded')),
      seasons TEXT,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      processed_by TEXT,
      notes TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES plex_servers(id) ON DELETE CASCADE,
      FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Create rss_items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rss_items (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'tv')),
      tmdb_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      overview TEXT,
      poster_path TEXT,
      seasons TEXT,
      added_by TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES plex_servers(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(server_id, content_type, tmdb_id)
    )
  `);

  // Create sessions table for JWT token management
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create audit_log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_requests_user ON content_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON content_requests(status);
    CREATE INDEX IF NOT EXISTS idx_rss_server ON rss_items(server_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  `);

  // Store encryption key if not exists
  const encryptionKey = db.encrypt ? null : require('./index').getEncryptionKey();

  console.log('Database tables created successfully');
}

module.exports = { initializeDatabase };
