/**
 * Setup Middleware
 * Handles first-time setup flow
 */

const db = require('../database');

/**
 * Require that setup is complete
 */
function requireSetup(req, res, next) {
  try {
    const settings = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
    if (settings?.value !== 'true') {
      return res.status(503).json({ 
        error: 'Setup required',
        setupRequired: true 
      });
    }
    next();
  } catch (error) {
    // If settings table doesn't exist, setup is required
    return res.status(503).json({ 
      error: 'Setup required',
      setupRequired: true 
    });
  }
}

/**
 * Require that setup is NOT complete (for setup endpoints)
 */
function requireNoSetup(req, res, next) {
  try {
    const settings = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
    if (settings?.value === 'true') {
      return res.status(403).json({ 
        error: 'Setup already complete',
        setupComplete: true 
      });
    }
    next();
  } catch (error) {
    // If error, setup is not complete
    next();
  }
}

module.exports = {
  requireSetup,
  requireNoSetup
};
