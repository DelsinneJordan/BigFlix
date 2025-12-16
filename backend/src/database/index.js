/**
 * Database Connection and Utilities
 * Uses better-sqlite3 for synchronous SQLite operations
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Database file location
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'bigflix.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create database connection
const db = new Database(DB_PATH);

// Enable foreign keys and WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Encryption key for sensitive data (generated on first run, stored in settings)
let encryptionKey = null;

/**
 * Get or create the encryption key
 */
function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;
  
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('encryption_key');
    if (row) {
      encryptionKey = row.value;
    } else {
      // Generate new encryption key
      encryptionKey = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('encryption_key', encryptionKey);
    }
    return encryptionKey;
  } catch (error) {
    // Settings table might not exist yet
    encryptionKey = crypto.randomBytes(32).toString('hex');
    return encryptionKey;
  }
}

/**
 * Encrypt sensitive data
 */
function encrypt(text) {
  if (!text) return null;
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const key = Buffer.from(getEncryptionKey(), 'hex');
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return null;
  }
}

// Export database and utilities
module.exports = db;
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
module.exports.getEncryptionKey = getEncryptionKey;
