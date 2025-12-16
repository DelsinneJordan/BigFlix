/**
 * BigFlix - Main Entry Point
 * Centralized media management platform for Plex, Radarr, and Sonarr
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Import database and initialize
const db = require('./database');
const { initializeDatabase } = require('./database/init');

// Import routes
const authRoutes = require('./routes/auth');
const setupRoutes = require('./routes/setup');
const userRoutes = require('./routes/users');
const serverRoutes = require('./routes/servers');
const searchRoutes = require('./routes/search');
const requestRoutes = require('./routes/requests');
const rssRoutes = require('./routes/rss');
const adminRoutes = require('./routes/admin');
const backupRoutes = require('./routes/backup');

// Import middleware
const { authenticateToken, optionalAuth } = require('./middleware/auth');
const { requireSetup, requireNoSetup } = require('./middleware/setup');

const app = express();
const PORT = process.env.PORT || 5000;

// Rate limiting - generous limits for normal usage
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 login attempts per 15 minutes
  message: { error: 'Too many login attempts, please try again later.' }
});

// Middleware
app.use(cors({ 
  origin: true, // Allow all origins in development
  credentials: true 
}));
app.use(express.json());
app.use(limiter);

// Serve static files from React build
app.use(express.static(path.join(__dirname, '../../frontend/build')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// Setup status endpoint (no auth required)
app.get('/api/setup/status', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE key = ?').get('setup_complete');
  const isConfigured = settings?.value === 'true';
  res.json({ configured: isConfigured });
});

// Public routes (no auth required)
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/setup', requireNoSetup, setupRoutes);

// Protected routes (require authentication)
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/servers', authenticateToken, serverRoutes);
app.use('/api/search', authenticateToken, searchRoutes);
app.use('/api/requests', authenticateToken, requestRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/backup', authenticateToken, backupRoutes);

// RSS feeds (can be public or protected based on settings)
app.use('/api/rss', rssRoutes);

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/build', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal server error' 
  });
});

// Initialize database and start server
async function startServer() {
  try {
    console.log('🚀 BigFlix v2.0.0');
    console.log('========================');
    
    // Initialize database
    initializeDatabase();
    console.log('✅ Database initialized');
    
    // Check if setup is complete
    const settings = db.prepare('SELECT * FROM settings WHERE key = ?').get('setup_complete');
    if (settings?.value === 'true') {
      console.log('✅ System configured - ready for use');
    } else {
      console.log('⚠️  First-time setup required - visit the web interface');
    }
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log('========================');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
