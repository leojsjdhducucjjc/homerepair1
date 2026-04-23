const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

loadEnvFile();

const app = express();
const rootDir = __dirname;
const legacyRequestsFile = path.join(rootDir, "data", "quote-requests.json");
const attachmentsRoot = getAttachmentsRoot();
const attachmentsBucket = process.env.SUPABASE_ATTACHMENTS_BUCKET || "quote-attachments";
const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS) || 24;
const sessionTtlSeconds = sessionTtlHours * 60 * 60;
const sessionCookieName = "dashboard_session";
const quoteNotificationTo = parseEmailList(
  process.env.QUOTE_NOTIFICATION_TO || process.env.OWNER_EMAIL || ""
);
const quoteNotificationFrom = cleanValue(process.env.QUOTE_NOTIFICATION_FROM);
const hasSupabaseConfig = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const supabase = hasSupabaseConfig
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    })
  : null;

const dataLayerState = {
  ready: false,
  error: hasSupabaseConfig ? null : "Supabase is not configured yet.",
  userEmailColumnReady: false,
};

const dataLayerReadyPromise = initializeDataLayer();

fs.mkdirSync(attachmentsRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const requestId = req.uploadRequestId || createRequestId();
      req.uploadRequestId = requestId;
      const requestDir = path.join(attachmentsRoot, requestId);
      fs.mkdirSync(requestDir, { recursive: true });
      cb(null, requestDir);
    },
    filename(_req, file, cb) {
      const originalName = cleanValue(file.originalname) || "attachment";
      const extension = path.extname(originalName).slice(0, 12).toLowerCase();
      const basename = path
        .basename(originalName, extension)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "attachment";
      cb(null, `${Date.now().toString(36)}-${basename}${extension}`);
    },
  }),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    if (isAllowedAttachment(file)) {
      cb(null, true);
      return;
    }

    cb(new Error("Unsupported file type. Please upload images, PDFs, or common document files."));
  },
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/login", async (req, res) => {
  if (await getAuthenticatedUser(req)) {
    return res.redirect("/dashboard");
  }

  res.sendFile(path.join(rootDir, "login.html"));
});

app.get("/reset-password", requireAuthenticatedPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "reset-password.html"));
});

app.post("/auth/login", async (req, res) => {
  if (!(await ensureDataLayerReady())) {
    return res.redirect("/login?error=config");
  }

  const login = cleanValue(req.body.username);
  const password = cleanValue(req.body.password);
  const user = await findUserByLogin(login);

  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.redirect("/login?error=invalid");
  }

  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.redirect("/dashboard");
});

app.post("/auth/logout", async (req, res) => {
  const token = readSessionToken(req);

  if (token && (await ensureDataLayerReady())) {
    await deleteSession(token);
  }

  clearSessionCookie(res);
  res.redirect("/login");
});

app.post("/auth/reset-password", requireAuthenticatedPage, async (req, res) => {
  const currentPassword = cleanValue(req.body.currentPassword);
  const newPassword = cleanValue(req.body.newPassword);
  const confirmPassword = cleanValue(req.body.confirmPassword);
  const currentUser = await findUserById(req.user.id);

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
  const { error } = await supabase
    .from("users")
    .update({
      password_hash: hash,
      password_salt: salt,
      updated_at: now,
    })
    .eq("id", currentUser.id);

  if (error) {
    console.error("Failed to update owner password", error);
    return res.redirect("/reset-password?error=config");
  }

  await deleteSessionsForUser(currentUser.id);
  const token = await createSession(currentUser.id);
  setSessionCookie(res, token);
  res.redirect("/reset-password?success=1");
});

app.post("/api/quote-requests", (req, res) => {
  req.uploadRequestId = createRequestId();

  upload.array("attachments", 5)(req, res, async (uploadError) => {
    if (uploadError) {
      cleanupRequestAttachments(req.uploadRequestId);
      const message =
        uploadError.code === "LIMIT_FILE_SIZE"
          ? "Each file must be 10MB or smaller."
          : uploadError.code === "LIMIT_FILE_COUNT"
            ? "You can upload up to 5 files per request."
            : uploadError.message || "We could not upload your attachments.";
      return res.status(400).json({ error: message });
    }

    if (!(await ensureDataLayerReady())) {
      cleanupRequestAttachments(req.uploadRequestId);
      return res.status(503).json({
        error: "Quote request storage is not configured yet. Add Supabase environment variables first.",
      });
    }

    const payload = normalizeRequest(req.body);

    if (!payload.name || !payload.phone || !payload.email || !payload.city || !payload.service) {
      cleanupRequestAttachments(req.uploadRequestId);
      return res.status(400).json({ error: "Please fill out all required fields." });
    }

    if (!isValidEmail(payload.email)) {
      cleanupRequestAttachments(req.uploadRequestId);
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const entry = {
      id: req.uploadRequestId,
      submitted_at: new Date().toISOString(),
      ...payload,
    };

    const { error } = await supabase.from("quote_requests").insert(entry);

    if (error) {
      cleanupRequestAttachments(req.uploadRequestId);
      console.error("Failed to save quote request", error);
      return res.status(500).json({ error: "We could not save your quote request right now." });
    }

    let attachments = [];

    try {
      attachments = await saveRequestAttachments(entry.id, req.files || []);
    } catch (attachmentError) {
      await supabase.from("quote_requests").delete().eq("id", entry.id);
      console.error("Failed to save quote request attachments", attachmentError);
      cleanupRequestAttachments(req.uploadRequestId);
      return res.status(500).json({
        error: "We had trouble uploading your photo or file. Please try again, or send your request without attachments and we will follow up with you.",
      });
    }

    try {
      await sendQuoteNotification(entry, attachments);
    } catch (emailError) {
      console.error("Failed to send quote request notification email", emailError);
    }

    res.status(201).json({
      success: true,
      request: {
        id: entry.id,
        submittedAt: entry.submitted_at,
        name: entry.name,
        phone: entry.phone,
        email: entry.email,
        city: entry.city,
        service: entry.service,
        timeline: entry.timeline,
        details: entry.details,
        attachments,
      },
    });
  });
});

app.get("/api/maps-config", (_req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY || "",
  });
});

app.get("/dashboard", requireAuthenticatedPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "dashboard.html"));
});

app.get("/api/quote-requests", requireAuthenticatedApi, async (_req, res) => {
  const { data, error } = await supabase
    .from("quote_requests")
    .select("id, submitted_at, name, phone, email, city, service, timeline, details")
    .order("submitted_at", { ascending: false });

  if (error) {
    console.error("Failed to load quote requests", error);
    return res.status(500).json({ error: "We could not load quote requests right now." });
  }

  const requests = await Promise.all(
    (data || []).map(async (request) => ({
      id: request.id,
      submittedAt: request.submitted_at,
      name: request.name,
      phone: request.phone,
      email: request.email,
      city: request.city,
      service: request.service,
      timeline: request.timeline,
      details: request.details,
      attachments: await loadRequestAttachments(request.id),
    }))
  );

  res.json({ requests });
});

app.delete("/api/quote-requests/:requestId", requireAuthenticatedApi, async (req, res) => {
  const requestId = cleanValue(req.params.requestId);

  if (!requestId) {
    return res.status(400).json({ error: "A request id is required." });
  }

  const { data: existingRequest, error: findError } = await supabase
    .from("quote_requests")
    .select("id")
    .eq("id", requestId)
    .maybeSingle();

  if (findError) {
    console.error("Failed to find quote request for deletion", findError);
    return res.status(500).json({ error: "We could not delete that request right now." });
  }

  if (!existingRequest) {
    return res.status(404).json({ error: "That request no longer exists." });
  }

  await deleteStoredAttachments(requestId);
  cleanupRequestAttachments(requestId);

  const { error } = await supabase.from("quote_requests").delete().eq("id", requestId);

  if (error) {
    console.error("Failed to delete quote request", error);
    return res.status(500).json({ error: "We could not delete that request right now." });
  }

  res.json({ success: true });
});

app.delete("/api/quote-requests", requireAuthenticatedApi, async (_req, res) => {
  const { data, error: loadError } = await supabase.from("quote_requests").select("id");

  if (loadError) {
    console.error("Failed to load quote requests for bulk deletion", loadError);
    return res.status(500).json({ error: "We could not clear the requests right now." });
  }

  const requestIds = (data || [])
    .map((request) => cleanValue(request.id))
    .filter(Boolean);

  for (const requestId of requestIds) {
    await deleteStoredAttachments(requestId);
    cleanupRequestAttachments(requestId);
  }

  const { error } = await supabase.from("quote_requests").delete().neq("id", "");

  if (error) {
    console.error("Failed to clear quote requests", error);
    return res.status(500).json({ error: "We could not clear the requests right now." });
  }

  res.json({ success: true, deleted: requestIds.length });
});

app.use("/quote-attachments", express.static(attachmentsRoot));
app.use(express.static(rootDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled Express error", err);
  res.status(500).send("Internal server error");
});

app.use((_req, res) => {
  res.status(404).send("Not found");
});

module.exports = app;

async function initializeDataLayer() {
  if (!hasSupabaseConfig) {
    console.warn("Supabase is not configured. Login and quote-request storage will stay unavailable.");
    return;
  }

  try {
    await detectUserEmailColumn();
    await seedOwnerUser();
    await ensureAttachmentsBucket();
    await migrateLegacyQuoteRequests();
    await purgeExpiredSessions();
    dataLayerState.ready = true;
    dataLayerState.error = null;
  } catch (error) {
    dataLayerState.ready = false;
    dataLayerState.error = error.message || "Supabase setup failed.";
    console.error("Supabase initialization failed", error);
  }
}

async function ensureDataLayerReady() {
  await dataLayerReadyPromise;
  return dataLayerState.ready;
}

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

async function migrateLegacyQuoteRequests() {
  if (!fs.existsSync(legacyRequestsFile)) {
    return;
  }

  const { count, error: countError } = await supabase
    .from("quote_requests")
    .select("id", { head: true, count: "exact" });

  if (countError) {
    throw new Error(`Supabase quote_requests table is unavailable: ${countError.message}`);
  }

  if ((count || 0) > 0) {
    return;
  }

  const legacyRequests = JSON.parse(fs.readFileSync(legacyRequestsFile, "utf8"));

  if (!Array.isArray(legacyRequests) || legacyRequests.length === 0) {
    return;
  }

  const rows = legacyRequests.map((request) => ({
    id: cleanValue(request.id) || createRequestId(),
    submitted_at: cleanValue(request.submittedAt) || new Date().toISOString(),
    name: cleanValue(request.name),
    phone: cleanValue(request.phone),
    email: cleanValue(request.email),
    city: cleanValue(request.city),
    service: cleanValue(request.service),
    timeline: cleanValue(request.timeline),
    details: cleanValue(request.details),
  }));

  const { error } = await supabase.from("quote_requests").upsert(rows, { onConflict: "id" });

  if (error) {
    throw new Error(`Supabase quote-request migration failed: ${error.message}`);
  }
}

async function seedOwnerUser() {
  const username = process.env.DASHBOARD_USERNAME || "owner";
  const password = process.env.DASHBOARD_PASSWORD || "change-me";
  const email = cleanValue(
    process.env.DASHBOARD_EMAIL || process.env.OWNER_EMAIL || quoteNotificationTo[0] || ""
  );

  const { count, error: countError } = await supabase
    .from("users")
    .select("id", { head: true, count: "exact" });

  if (countError) {
    throw new Error(`Supabase users table is unavailable: ${countError.message}`);
  }

  if ((count || 0) > 0) {
    return;
  }

  const { salt, hash } = createPasswordRecord(password);
  const now = new Date().toISOString();
  const ownerRecord = {
    username,
    password_hash: hash,
    password_salt: salt,
    created_at: now,
    updated_at: now,
  };

  if (dataLayerState.userEmailColumnReady && email) {
    ownerRecord.email = email;
  }

  const { error } = await supabase.from("users").insert(ownerRecord);

  if (error) {
    throw new Error(`Supabase owner seed failed: ${error.message}`);
  }
}

async function detectUserEmailColumn() {
  const { error } = await supabase.from("users").select("email").limit(1);
  dataLayerState.userEmailColumnReady = !error;

  if (error) {
    console.warn(
      "Supabase users.email column is not available yet. Email login and database-based notification recipients will stay disabled until the schema is updated."
    );
  }
}

async function ensureAttachmentsBucket() {
  const { data, error } = await supabase.storage.listBuckets();

  if (error) {
    throw new Error(`Supabase storage is unavailable: ${error.message}`);
  }

  if ((data || []).some((bucket) => bucket.name === attachmentsBucket)) {
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(attachmentsBucket, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
  });

  if (createError && !String(createError.message || "").toLowerCase().includes("already exists")) {
    throw new Error(`Supabase attachments bucket setup failed: ${createError.message}`);
  }
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

async function findUserByLogin(login) {
  if (!login) {
    return null;
  }

  const { data: usernameUser, error: usernameError } = await supabase
    .from("users")
    .select("id, username, password_hash, password_salt")
    .eq("username", login)
    .maybeSingle();

  if (usernameError) {
    console.error("Failed to load user by username", usernameError);
    return null;
  }

  if (usernameUser || !dataLayerState.userEmailColumnReady) {
    return usernameUser;
  }

  const { data: emailUser, error: emailError } = await supabase
    .from("users")
    .select("id, username, password_hash, password_salt")
    .ilike("email", login)
    .maybeSingle();

  if (emailError) {
    console.error("Failed to load user by email", emailError);
    return null;
  }

  return emailUser;
}

async function findUserById(userId) {
  const { data, error } = await supabase
    .from("users")
    .select("id, username, password_hash, password_salt")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load user by id", error);
    return null;
  }

  return data;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString();

  const { error } = await supabase.from("sessions").insert({
    user_id: userId,
    token_hash: tokenHash,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Failed to create session: ${error.message}`);
  }

  return token;
}

async function deleteSession(token) {
  const { error } = await supabase
    .from("sessions")
    .delete()
    .eq("token_hash", hashSessionToken(token));

  if (error) {
    console.error("Failed to delete session", error);
  }
}

async function deleteSessionsForUser(userId) {
  const { error } = await supabase.from("sessions").delete().eq("user_id", userId);

  if (error) {
    console.error("Failed to delete user sessions", error);
  }
}

async function purgeExpiredSessions() {
  const { error } = await supabase
    .from("sessions")
    .delete()
    .lte("expires_at", new Date().toISOString());

  if (error) {
    console.error("Failed to purge expired sessions", error);
  }
}

async function getAuthenticatedUser(req) {
  if (!(await ensureDataLayerReady())) {
    return null;
  }

  await purgeExpiredSessions();

  const token = readSessionToken(req);

  if (!token) {
    return null;
  }

  const { data: session, error } = await supabase
    .from("sessions")
    .select("user_id")
    .eq("token_hash", hashSessionToken(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !session) {
    return null;
  }

  const user = await findUserById(session.user_id);

  return user ? { id: user.id, username: user.username } : null;
}

async function requireAuthenticatedPage(req, res, next) {
  if (!(await ensureDataLayerReady())) {
    return res.redirect("/login?error=config");
  }

  const user = await getAuthenticatedUser(req);

  if (!user) {
    return res.redirect("/login");
  }

  req.user = user;
  next();
}

async function requireAuthenticatedApi(req, res, next) {
  if (!(await ensureDataLayerReady())) {
    return res.status(503).json({
      error:
        dataLayerState.error ||
        "Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }

  const user = await getAuthenticatedUser(req);

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
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
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

function isAllowedAttachment(file) {
  const allowedMimeTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ]);
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".doc", ".docx", ".txt"]);
  const extension = path.extname(file.originalname || "").toLowerCase();
  return allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(extension);
}

async function saveRequestAttachments(requestId, files) {
  if (!Array.isArray(files) || files.length === 0) {
    cleanupRequestAttachments(requestId, { removeDirectoryIfEmpty: true });
    return [];
  }

  const attachments = files.map((file) => ({
    originalName: cleanValue(file.originalname) || file.filename,
    storedName: file.filename,
    size: Number(file.size) || 0,
    contentType: cleanValue(file.mimetype) || "application/octet-stream",
  }));

  try {
    for (const file of files) {
      const storagePath = getAttachmentStoragePath(requestId, file.filename);
      const buffer = fs.readFileSync(file.path);
      const { error } = await supabase.storage.from(attachmentsBucket).upload(storagePath, buffer, {
        contentType: file.mimetype || "application/octet-stream",
        upsert: true,
      });

      if (error) {
        throw new Error(error.message || "Attachment upload failed.");
      }
    }

    const manifestPath = getAttachmentManifestPath(requestId);
    const manifestBuffer = Buffer.from(JSON.stringify(attachments, null, 2), "utf8");
    const { error: manifestError } = await supabase.storage
      .from(attachmentsBucket)
      .upload(manifestPath, manifestBuffer, {
        contentType: "text/plain",
        upsert: true,
      });

    if (manifestError) {
      throw new Error(manifestError.message || "Attachment manifest upload failed.");
    }

    return attachments.map((attachment) => ({
      originalName: cleanValue(attachment.originalName) || attachment.storedName,
      storedName: cleanValue(attachment.storedName),
      size: Number(attachment.size) || 0,
      contentType: cleanValue(attachment.contentType),
      url: "",
    }));
  } catch (error) {
    await deleteStoredAttachments(requestId);
    throw error;
  } finally {
    cleanupRequestAttachments(requestId);
  }
}

async function loadRequestAttachments(requestId) {
  if (!requestId) {
    return [];
  }

  const storedAttachments = await loadStoredAttachments(requestId);

  if (storedAttachments.length > 0) {
    return storedAttachments;
  }

  const metadataPath = path.join(attachmentsRoot, requestId, "attachments.json");

  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Failed to read attachment metadata", error);
    return [];
  }
}

async function loadStoredAttachments(requestId) {
  try {
    const manifest = await loadAttachmentManifest(requestId);

    if (!Array.isArray(manifest) || manifest.length === 0) {
      return [];
    }

    return await buildSignedAttachments(requestId, manifest);
  } catch (error) {
    console.error("Failed to load stored attachments", error);
    return [];
  }
}

async function loadAttachmentManifest(requestId) {
  const { data, error } = await supabase.storage
    .from(attachmentsBucket)
    .download(getAttachmentManifestPath(requestId));

  if (error) {
    const lowerMessage = String(error.message || "").toLowerCase();
    if (lowerMessage.includes("not found") || lowerMessage.includes("404")) {
      return [];
    }

    console.error("Failed to load attachment manifest", error);
    return [];
  }

  try {
    const contents = await readStorageBodyAsString(data);
    const manifest = JSON.parse(contents);
    return Array.isArray(manifest) ? manifest : [];
  } catch (manifestError) {
    console.error("Failed to parse attachment manifest", manifestError);
    return [];
  }
}

async function buildSignedAttachments(requestId, manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return [];
  }

  const paths = manifest.map((attachment) =>
    getAttachmentStoragePath(requestId, attachment.storedName)
  );
  const { data, error } = await supabase.storage
    .from(attachmentsBucket)
    .createSignedUrls(paths, 60 * 60);

  if (error) {
    throw new Error(error.message || "Could not create attachment URLs.");
  }

  const urlByPath = new Map((data || []).map((entry) => [entry.path, entry.signedUrl || ""]));

  return manifest
    .map((attachment) => {
      const storagePath = getAttachmentStoragePath(requestId, attachment.storedName);
      const signedUrl = urlByPath.get(storagePath);

      if (!signedUrl) {
        return null;
      }

      return {
        originalName: cleanValue(attachment.originalName) || attachment.storedName,
        storedName: cleanValue(attachment.storedName),
        size: Number(attachment.size) || 0,
        contentType: cleanValue(attachment.contentType),
        url: signedUrl,
      };
    })
    .filter(Boolean);
}

async function deleteStoredAttachments(requestId) {
  if (!requestId) {
    return;
  }

  const manifest = await loadAttachmentManifest(requestId);
  const paths = manifest
    .map((attachment) => getAttachmentStoragePath(requestId, attachment.storedName))
    .filter(Boolean);

  paths.push(getAttachmentManifestPath(requestId));

  const { error } = await supabase.storage.from(attachmentsBucket).remove(paths);

  if (error) {
    console.error("Failed to delete stored attachments", error);
  }
}

async function sendQuoteNotification(request, attachments = []) {
  if (!resend) {
    console.warn("Quote notification email skipped: RESEND_API_KEY is not configured.");
    return;
  }

  if (!quoteNotificationFrom) {
    console.warn("Quote notification email skipped: QUOTE_NOTIFICATION_FROM is not configured.");
    return;
  }

  const recipients = await getQuoteNotificationRecipients();

  if (recipients.length === 0) {
    console.warn(
      "Quote notification email skipped: no recipient emails found in users.email or QUOTE_NOTIFICATION_TO."
    );
    return;
  }

  const dashboardUrl = getDashboardUrl();
  const attachmentNames = Array.isArray(attachments)
    ? attachments.map((attachment) => cleanValue(attachment.originalName)).filter(Boolean)
    : [];
  const subject = `New quote request from ${request.name || "website visitor"}`;
  const text = [
    "A new free quote request was submitted on the website.",
    "",
    `Name: ${request.name || "Not provided"}`,
    `Phone: ${request.phone || "Not provided"}`,
    `Email: ${request.email || "Not provided"}`,
    `Property Address / Area: ${request.city || "Not provided"}`,
    `Service: ${request.service || "Not provided"}`,
    `Timeline: ${request.timeline || "Not provided"}`,
    `Submitted: ${formatSubmittedAt(request.submitted_at)}`,
    "",
    "Project Details:",
    request.details || "No project details were added.",
    "",
    `Attachments: ${attachmentNames.length ? attachmentNames.join(", ") : "None"}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  const html = buildQuoteNotificationHtml(request, attachmentNames, dashboardUrl);

  const emailPayload = {
    from: quoteNotificationFrom,
    to: recipients,
    subject,
    html,
    text,
  };

  if (isValidEmail(request.email)) {
    emailPayload.replyTo = request.email;
  }

  const { error } = await resend.emails.send(emailPayload);

  if (error) {
    throw new Error(error.message || "Resend email failed.");
  }
}

async function getQuoteNotificationRecipients() {
  if (!dataLayerState.userEmailColumnReady) {
    return quoteNotificationTo;
  }

  const { data, error } = await supabase
    .from("users")
    .select("email")
    .not("email", "is", null);

  if (error) {
    console.error("Failed to load owner notification emails", error);
    return quoteNotificationTo;
  }

  const userEmails = (data || [])
    .map((user) => cleanValue(user.email))
    .filter(Boolean);

  return [...new Set([...userEmails, ...quoteNotificationTo])];
}

function buildQuoteNotificationHtml(request, attachmentNames, dashboardUrl) {
  const fields = [
    ["Name", request.name || "Not provided"],
    ["Phone", request.phone || "Not provided"],
    ["Email", request.email || "Not provided"],
    ["Property Address / Area", request.city || "Not provided"],
    ["Service", request.service || "Not provided"],
    ["Timeline", request.timeline || "Not provided"],
    ["Submitted", formatSubmittedAt(request.submitted_at)],
  ];
  const rows = fields
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 12px;border:1px solid #d8e4f2;background:#f5f9ff;font-weight:700;color:#24486f;">${escapeHtml(label)}</td>
          <td style="padding:10px 12px;border:1px solid #d8e4f2;color:#263c55;">${escapeHtml(value)}</td>
        </tr>
      `
    )
    .join("");
  const attachmentText = attachmentNames.length
    ? attachmentNames.map((name) => `<li>${escapeHtml(name)}</li>`).join("")
    : "<li>None</li>";
  const dashboardLink = dashboardUrl
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtmlAttr(dashboardUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#1d5ea8;color:#ffffff;text-decoration:none;font-weight:700;">Open Dashboard</a></p>`
    : "";

  return `
    <div style="margin:0;padding:24px;background:#eef4fb;font-family:Arial,sans-serif;color:#263c55;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d8e4f2;border-radius:18px;padding:24px;">
        <p style="margin:0 0 8px;color:#f58220;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">New Website Lead</p>
        <h1 style="margin:0 0 18px;color:#163f70;font-size:28px;line-height:1.15;">Free Quote Request</h1>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">${rows}</table>
        <h2 style="margin:0 0 8px;color:#163f70;font-size:18px;">Project Details</h2>
        <p style="margin:0 0 18px;white-space:pre-wrap;line-height:1.55;">${escapeHtml(request.details || "No project details were added.")}</p>
        <h2 style="margin:0 0 8px;color:#163f70;font-size:18px;">Attachments</h2>
        <ul style="margin:0;padding-left:20px;line-height:1.55;">${attachmentText}</ul>
        ${dashboardLink}
      </div>
    </div>
  `;
}

function cleanupRequestAttachments(requestId, options = {}) {
  if (!requestId) {
    return;
  }

  const requestDir = path.join(attachmentsRoot, requestId);

  if (!fs.existsSync(requestDir)) {
    return;
  }

  const entries = fs.readdirSync(requestDir);

  for (const entry of entries) {
    fs.rmSync(path.join(requestDir, entry), { force: true, recursive: true });
  }

  if (options.removeDirectoryIfEmpty !== false) {
    fs.rmSync(requestDir, { force: true, recursive: true });
  }
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseEmailList(value) {
  return cleanValue(value)
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

function isValidEmail(value) {
  const email = cleanValue(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatSubmittedAt(value) {
  if (!value) {
    return "Unknown time";
  }

  try {
    return new Date(value).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Chicago",
    });
  } catch (_error) {
    return value;
  }
}

function getDashboardUrl() {
  const siteUrl =
    cleanValue(process.env.SITE_URL) ||
    cleanValue(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    cleanValue(process.env.VERCEL_URL);

  if (!siteUrl) {
    return "";
  }

  const normalizedUrl = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`;
  return `${normalizedUrl.replace(/\/+$/, "")}/dashboard`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function getAttachmentManifestPath(requestId) {
  return `${requestId}/attachments.json`;
}

function getAttachmentStoragePath(requestId, storedName) {
  return `${requestId}/${cleanValue(storedName)}`;
}

async function readStorageBodyAsString(body) {
  if (!body) {
    return "";
  }

  if (typeof body.text === "function") {
    return body.text();
  }

  if (typeof body.arrayBuffer === "function") {
    const buffer = Buffer.from(await body.arrayBuffer());
    return buffer.toString("utf8");
  }

  return Buffer.from(body).toString("utf8");
}

function createRequestId() {
  return `qr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getAttachmentsRoot() {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "homerepair-quote-attachments");
  }

  return path.join(rootDir, "data", "quote-attachments");
}
