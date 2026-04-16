const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");

loadEnvFile();

const app = express();
const port = Number(process.env.PORT) || 3000;
const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const databasePath = path.join(dataDir, "site.db");
const legacyRequestsFile = path.join(dataDir, "quote-requests.json");
const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS) || 24;
const sessionTtlSeconds = sessionTtlHours * 60 * 60;
const sessionCookieName = "dashboard_session";
const db = initializeDatabase();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/login", (req, res) => {
  if (getAuthenticatedUser(req)) {
    return res.redirect("/dashboard");
  }

  res.sendFile(path.join(rootDir, "login.html"));
});

app.get("/reset-password", requireAuthenticatedPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "reset-password.html"));
});

app.post("/auth/login", (req, res) => {
  const username = cleanValue(req.body.username);
  const password = cleanValue(req.body.password);
  const user = findUserByUsername(username);

  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.redirect("/login?error=invalid");
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.redirect("/dashboard");
});

app.post("/auth/logout", (req, res) => {
  const token = readSessionToken(req);

  if (token) {
    deleteSession(token);
  }

  clearSessionCookie(res);
  res.redirect("/login");
});

app.post("/auth/reset-password", requireAuthenticatedPage, (req, res) => {
  const currentPassword = cleanValue(req.body.currentPassword);
  const newPassword = cleanValue(req.body.newPassword);
  const confirmPassword = cleanValue(req.body.confirmPassword);
  const currentUser = findUserById(req.user.id);

  if (!currentUser) {
    clearSessionCookie(res);
    return res.redirect("/login");
  }

  if (!verifyPassword(currentPassword, currentUser.password_salt, currentUser.password_hash)) {
    return res.redirect("/reset-password?error=current");
  }

  if (newPassword.length < 8) {
    return res.redirect("/reset-password?error=length");
  }

  if (newPassword !== confirmPassword) {
    return res.redirect("/reset-password?error=match");
  }

  if (verifyPassword(newPassword, currentUser.password_salt, currentUser.password_hash)) {
    return res.redirect("/reset-password?error=same");
  }

  const { salt, hash } = createPasswordRecord(newPassword);
  const now = new Date().toISOString();

  db.prepare(
    `
      UPDATE users
      SET password_hash = ?, password_salt = ?, updated_at = ?
      WHERE id = ?
    `
  ).run(hash, salt, now, currentUser.id);

  deleteSessionsForUser(currentUser.id);
  const token = createSession(currentUser.id);
  setSessionCookie(res, token);
  res.redirect("/reset-password?success=1");
});

app.post("/api/quote-requests", (req, res) => {
  const payload = normalizeRequest(req.body);

  if (!payload.name || !payload.phone || !payload.email || !payload.city || !payload.service) {
    return res.status(400).json({ error: "Please fill out all required fields." });
  }

  const entry = {
    id: createRequestId(),
    submittedAt: new Date().toISOString(),
    ...payload,
  };

  try {
    db.prepare(
      `
        INSERT INTO quote_requests (
          id,
          submitted_at,
          name,
          phone,
          email,
          city,
          service,
          timeline,
          details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      entry.id,
      entry.submittedAt,
      entry.name,
      entry.phone,
      entry.email,
      entry.city,
      entry.service,
      entry.timeline,
      entry.details
    );

    res.status(201).json({ success: true, request: entry });
  } catch (error) {
    console.error("Failed to save quote request", error);
    res.status(500).json({ error: "We could not save your quote request right now." });
  }
});

app.get("/dashboard", requireAuthenticatedPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "dashboard.html"));
});

app.get("/api/quote-requests", requireAuthenticatedApi, (_req, res) => {
  try {
    const requests = db
      .prepare(
        `
          SELECT
            id,
            submitted_at AS submittedAt,
            name,
            phone,
            email,
            city,
            service,
            timeline,
            details
          FROM quote_requests
          ORDER BY submitted_at DESC
        `
      )
      .all();

    res.json({ requests });
  } catch (error) {
    console.error("Failed to load quote requests", error);
    res.status(500).json({ error: "We could not load quote requests right now." });
  }
});

app.use(express.static(rootDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((_req, res) => {
  res.status(404).send("Not found");
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of envLines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function initializeDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quote_requests (
      id TEXT PRIMARY KEY,
      submitted_at TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      city TEXT NOT NULL,
      service TEXT NOT NULL,
      timeline TEXT NOT NULL,
      details TEXT NOT NULL
    );
  `);

  migrateLegacyQuoteRequests(database);
  seedOwnerUser(database);
  purgeExpiredSessions(database);

  return database;
}

function migrateLegacyQuoteRequests(database) {
  if (!fs.existsSync(legacyRequestsFile)) {
    return;
  }

  const existingCount = database.prepare("SELECT COUNT(*) AS count FROM quote_requests").get().count;

  if (existingCount > 0) {
    return;
  }

  try {
    const legacyRequests = JSON.parse(fs.readFileSync(legacyRequestsFile, "utf8"));

    if (!Array.isArray(legacyRequests) || legacyRequests.length === 0) {
      return;
    }

    const insertRequest = database.prepare(
      `
        INSERT OR IGNORE INTO quote_requests (
          id,
          submitted_at,
          name,
          phone,
          email,
          city,
          service,
          timeline,
          details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    for (const request of legacyRequests) {
      insertRequest.run(
        cleanValue(request.id) || createRequestId(),
        cleanValue(request.submittedAt) || new Date().toISOString(),
        cleanValue(request.name),
        cleanValue(request.phone),
        cleanValue(request.email),
        cleanValue(request.city),
        cleanValue(request.service),
        cleanValue(request.timeline),
        cleanValue(request.details)
      );
    }
  } catch (error) {
    console.error("Failed to migrate legacy quote requests", error);
  }
}

function seedOwnerUser(database) {
  const username = process.env.DASHBOARD_USERNAME || "owner";
  const password = process.env.DASHBOARD_PASSWORD || "change-me";
  const userCount = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;

  if (userCount > 0) {
    return;
  }

  const { salt, hash } = createPasswordRecord(password);
  const now = new Date().toISOString();

  database
    .prepare(
      `
        INSERT INTO users (username, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(username, hash, salt, now, now);
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) {
    return false;
  }

  const candidateHash = crypto.scryptSync(password, salt, 64);
  const storedHash = Buffer.from(expectedHash, "hex");

  if (candidateHash.length !== storedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateHash, storedHash);
}

function findUserByUsername(username) {
  if (!username) {
    return null;
  }

  return (
    db
      .prepare(
        `
          SELECT id, username, password_hash, password_salt
          FROM users
          WHERE username = ?
        `
      )
      .get(username) || null
  );
}

function findUserById(userId) {
  return (
    db
      .prepare(
        `
          SELECT id, username, password_hash, password_salt
          FROM users
          WHERE id = ?
        `
      )
      .get(userId) || null
  );
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString();

  db.prepare(
    `
      INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `
  ).run(userId, tokenHash, now.toISOString(), expiresAt);

  return token;
}

function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

function deleteSessionsForUser(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function purgeExpiredSessions(database = db) {
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

function getAuthenticatedUser(req) {
  purgeExpiredSessions();

  const token = readSessionToken(req);

  if (!token) {
    return null;
  }

  return (
    db
      .prepare(
        `
          SELECT users.id, users.username
          FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ?
            AND sessions.expires_at > ?
        `
      )
      .get(hashSessionToken(token), new Date().toISOString()) || null
  );
}

function requireAuthenticatedPage(req, res, next) {
  const user = getAuthenticatedUser(req);

  if (!user) {
    return res.redirect("/login");
  }

  req.user = user;
  next();
}

function requireAuthenticatedApi(req, res, next) {
  const user = getAuthenticatedUser(req);

  if (!user) {
    return res.status(401).json({ error: "Please log in to continue." });
  }

  req.user = user;
  next();
}

function setSessionCookie(res, token) {
  const cookieParts = [
    `${sessionCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessionTtlSeconds}`,
  ];

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[sessionCookieName] || "";
}

function parseCookies(cookieHeader) {
  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeRequest(body) {
  return {
    name: cleanValue(body.name),
    phone: cleanValue(body.phone),
    email: cleanValue(body.email),
    city: cleanValue(body.city),
    service: cleanValue(body.service),
    timeline: cleanValue(body.timeline),
    details: cleanValue(body.details),
  };
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createRequestId() {
  return `qr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
