import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTH_FILE = path.join(process.cwd(), 'data', 'auth.json');

class AuthManager {
  constructor() {
    this.data = { users: {}, sessions: {} };
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(AUTH_FILE)) {
        const fileContent = fs.readFileSync(AUTH_FILE, 'utf-8');
        this.data = JSON.parse(fileContent);
      }
    } catch (err) {
      console.error('[AUTH] Error loading auth.json:', err.message);
    }
  }

  saveData() {
    try {
      fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[AUTH] Error saving auth.json:', err.message);
    }
  }

  async createOrUpdateUser(discordId, username, avatar) {
    this.data.users[discordId] = { discordId, username, avatar };
    this.saveData();
    return true;
  }

  async createSession(discordId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[token] = {
      discordId,
      createdAt: new Date().toISOString()
    };
    this.saveData();
    return token;
  }

  async getUserByToken(token) {
    if (!token) return null;
    const session = this.data.sessions[token];
    if (!session) return null;
    const user = this.data.users[session.discordId];
    if (!user) return null;
    return {
      id: user.discordId,
      username: user.username,
      avatar: user.avatar
    };
  }

  async logout(token) {
    if (!token) return;
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.saveData();
    }
  }
}

export default new AuthManager();
