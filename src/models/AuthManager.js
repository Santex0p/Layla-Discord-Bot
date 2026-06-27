import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import crypto from 'crypto';

const DB_PATH = path.join(process.cwd(), 'data', 'layla.sqlite');

class AuthManager {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[AUTH] Error conectando a SQLite:', err.message);
      } else {
        this.initDb();
      }
    });
  }

  initDb() {
    this.db.serialize(() => {
      // Create users table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS dashboard_users (
          discord_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          avatar TEXT
        )
      `);

      // Create sessions table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS dashboard_sessions (
          token TEXT PRIMARY KEY,
          discord_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(discord_id) REFERENCES dashboard_users(discord_id)
        )
      `);
    });
  }

  async createOrUpdateUser(discordId, username, avatar) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO dashboard_users (discord_id, username, avatar)
        VALUES (?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET
          username = excluded.username,
          avatar = excluded.avatar
      `;
      this.db.run(query, [discordId, username, avatar], function(err) {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  async createSession(discordId) {
    const token = crypto.randomBytes(32).toString('hex');
    return new Promise((resolve, reject) => {
      this.db.run(`INSERT INTO dashboard_sessions (token, discord_id) VALUES (?, ?)`, [token, discordId], function(err) {
        if (err) return reject(err);
        resolve(token);
      });
    });
  }

  async getUserByToken(token) {
    if (!token) return null;
    return new Promise((resolve, reject) => {
      const query = `
        SELECT u.discord_id as id, u.username, u.avatar 
        FROM dashboard_sessions s
        JOIN dashboard_users u ON s.discord_id = u.discord_id
        WHERE s.token = ?
      `;
      this.db.get(query, [token], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  async logout(token) {
    if (!token) return;
    return new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM dashboard_sessions WHERE token = ?`, [token], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

export default new AuthManager();
