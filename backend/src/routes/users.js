/**
 * User Management Routes
 * Admin user management endpoints
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/users
 * List all users (admin only)
 */
router.get('/', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, username, email, role, can_add_directly, primary_server_id, 
             created_at, last_login
      FROM users
      ORDER BY created_at DESC
    `).all();

    // Get servers for each user
    const usersWithServers = users.map(user => {
      const servers = db.prepare(`
        SELECT ps.id, ps.name FROM plex_servers ps
        JOIN user_servers us ON ps.id = us.server_id
        WHERE us.user_id = ?
      `).all(user.id);

      return {
        ...user,
        canAddDirectly: user.can_add_directly === 1,
        servers
      };
    });

    res.json(usersWithServers);
  } catch (error) {
    console.error('List users error:', error.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * POST /api/users
 * Create a new user (admin only)
 */
router.post('/', requireAdmin, (req, res) => {
  try {
    const { username, password, email, role, canAddDirectly, serverIds, primaryServerId } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check for existing username
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Create user
    const userId = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, 12);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, email, role, can_add_directly, primary_server_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      username.toLowerCase(),
      passwordHash,
      email || null,
      role || 'user',
      canAddDirectly ? 1 : 0,
      primaryServerId || null
    );

    // Assign servers
    if (serverIds && serverIds.length > 0) {
      const insertServer = db.prepare('INSERT INTO user_servers (user_id, server_id) VALUES (?, ?)');
      for (const serverId of serverIds) {
        insertServer.run(userId, serverId);
      }

      // If no primary server specified, use the first one
      if (!primaryServerId) {
        db.prepare('UPDATE users SET primary_server_id = ? WHERE id = ?')
          .run(serverIds[0], userId);
      }
    }

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'create_user', `Created user: ${username}`, req.ip);

    res.status(201).json({ 
      message: 'User created successfully',
      userId 
    });
  } catch (error) {
    console.error('Create user error:', error.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * GET /api/users/:id
 * Get user details
 */
router.get('/:id', (req, res) => {
  try {
    // Users can view their own profile, admins can view anyone
    if (req.params.id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare(`
      SELECT id, username, email, role, can_add_directly, primary_server_id, 
             created_at, last_login
      FROM users WHERE id = ?
    `).get(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const servers = db.prepare(`
      SELECT ps.id, ps.name FROM plex_servers ps
      JOIN user_servers us ON ps.id = us.server_id
      WHERE us.user_id = ?
    `).all(user.id);

    res.json({
      ...user,
      canAddDirectly: user.can_add_directly === 1,
      servers
    });
  } catch (error) {
    console.error('Get user error:', error.message);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * PUT /api/users/:id
 * Update user (admin only, or own profile)
 */
router.put('/:id', (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const isOwnProfile = req.params.id === req.user.id;

    if (!isAdmin && !isOwnProfile) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { email, role, canAddDirectly, serverIds, primaryServerId, password } = req.body;

    // Non-admins can only update email and password
    if (!isAdmin) {
      if (password) {
        if (password.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const passwordHash = bcrypt.hashSync(password, 12);
        db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
          .run(passwordHash, user.id);
      }
      
      if (email !== undefined) {
        db.prepare("UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?")
          .run(email, user.id);
      }
    } else {
      // Admin can update everything
      const updates = [];
      const values = [];

      if (email !== undefined) {
        updates.push('email = ?');
        values.push(email);
      }

      if (role !== undefined) {
        updates.push('role = ?');
        values.push(role);
      }

      if (canAddDirectly !== undefined) {
        updates.push('can_add_directly = ?');
        values.push(canAddDirectly ? 1 : 0);
      }

      if (primaryServerId !== undefined) {
        updates.push('primary_server_id = ?');
        values.push(primaryServerId);
      }

      if (password) {
        if (password.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        updates.push('password_hash = ?');
        values.push(bcrypt.hashSync(password, 12));
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(user.id);
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      // Update server assignments
      if (serverIds !== undefined) {
        db.prepare('DELETE FROM user_servers WHERE user_id = ?').run(user.id);
        const insertServer = db.prepare('INSERT INTO user_servers (user_id, server_id) VALUES (?, ?)');
        for (const serverId of serverIds) {
          insertServer.run(user.id, serverId);
        }
      }
    }

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'update_user', `Updated user: ${user.username}`, req.ip);

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Update user error:', error.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/users/:id
 * Delete user (admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting yourself
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
      if (adminCount.count <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'delete_user', `Deleted user: ${user.username}`, req.ip);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
