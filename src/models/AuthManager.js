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
    const query = `
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        password_hash TEXT NOT NULL,
        session_token TEXT
      )
    `;
    this.db.run(query, (err) => {
      if (err) console.error('[AUTH] Error creando tabla admins:', err.message);
    });
  }

  async hasAdmin() {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT COUNT(*) as count FROM admins`, (err, row) => {
        if (err) return reject(err);
        resolve(row.count > 0);
      });
    });
  }

  async registerAdmin(password) {
    const hasAdmin = await this.hasAdmin();
    if (hasAdmin) {
      throw new Error('Ya existe un administrador registrado. No se puede registrar otro.');
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    return new Promise((resolve, reject) => {
      this.db.run(`INSERT INTO admins (password_hash) VALUES (?)`, [hash], function(err) {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  async loginAdmin(password) {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT id, password_hash FROM admins LIMIT 1`, async (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null); // No admin

        const isValid = await bcrypt.compare(password, row.password_hash);
        if (!isValid) return resolve(null); // Contraseña incorrecta

        const token = crypto.randomBytes(32).toString('hex');
        this.db.run(`UPDATE admins SET session_token = ? WHERE id = ?`, [token, row.id], (updateErr) => {
          if (updateErr) return reject(updateErr);
          resolve(token);
        });
      });
    });
  }

  async validateToken(token) {
    if (!token) return false;
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT id FROM admins WHERE session_token = ?`, [token], (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      });
    });
  }

  async logoutAdmin(token) {
    if (!token) return;
    return new Promise((resolve, reject) => {
      this.db.run(`UPDATE admins SET session_token = NULL WHERE session_token = ?`, [token], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

export default new AuthManager();
