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
const allowedAttachmentMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];
const allowedAttachmentExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
]);
const quoteNotificationTo = parseEmailList(
  process.env.QUOTE_NOTIFICATION_TO || process.env.OWNER_EMAIL || ""
);
const quoteNotificationFrom = cleanValue(process.env.QUOTE_NOTIFICATION_FROM);
const squareAccessToken = cleanValue(process.env.SQUARE_ACCESS_TOKEN);
const squareLocationId = cleanValue(process.env.SQUARE_LOCATION_ID);
const squareEnvironment = cleanValue(process.env.SQUARE_ENVIRONMENT).toLowerCase() === "sandbox"
  ? "sandbox"
  : "production";
const squareApiBaseUrl =
  squareEnvironment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
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

  const requestIds = (data || []).map((request) => request.id);
  const invoicesByRequestId = await loadInvoicesByRequestId(requestIds);
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
      invoices: invoicesByRequestId.get(request.id) || [],
    }))
  );

  res.json({ requests });
});

app.post("/api/invoices", requireAuthenticatedApi, async (req, res) => {
  const payload = normalizeInvoiceRequest(req.body);

  if (!payload.requestId) {
    return res.status(400).json({ error: "Choose a quote request before sending a Square link." });
  }

  if (payload.items.length === 0) {
    return res.status(400).json({ error: "Add at least one payment line item." });
  }

  const { data: quoteRequest, error: requestError } = await supabase
    .from("quote_requests")
    .select("id, name, phone, email, city, service, timeline, details")
    .eq("id", payload.requestId)
    .maybeSingle();

  if (requestError) {
    console.error("Failed to load quote request for invoice", requestError);
    return res.status(500).json({ error: "We could not load that quote request right now." });
  }

  if (!quoteRequest) {
    return res.status(404).json({ error: "That quote request no longer exists." });
  }

  if (!isValidEmail(quoteRequest.email)) {
    return res.status(400).json({ error: "The customer does not have a valid email address." });
  }

  const now = new Date().toISOString();
  let squarePaymentLink;

  try {
    squarePaymentLink = await createSquarePaymentLink(payload, quoteRequest);
  } catch (squareError) {
    console.error("Failed to create Square payment link", squareError);
    return res.status(500).json({
      error: "We could not create the Square payment link. Check the Square environment variables.",
    });
  }

  const invoice = {
    id: createInvoiceId(),
    quote_request_id: quoteRequest.id,
    customer_name: quoteRequest.name,
    customer_email: quoteRequest.email,
    title: payload.title || "Project Invoice",
    notes: payload.notes,
    line_items: payload.items,
    subtotal: payload.total,
    total: payload.total,
    due_date: payload.dueDate || null,
    status: "square_link_created",
    square_payment_link_id: squarePaymentLink.id,
    square_payment_link_url: squarePaymentLink.url,
    square_order_id: squarePaymentLink.orderId,
    sent_at: now,
    created_at: now,
  };

  const { error: insertError } = await supabase.from("invoices").insert(invoice);

  if (insertError) {
    console.error("Failed to save invoice", insertError);
    return res.status(500).json({ error: "We could not save that Square payment link right now." });
  }

  try {
    await sendInvoiceEmail(invoice, quoteRequest);
  } catch (emailError) {
    console.error("Failed to send invoice email", emailError);
    await supabase
      .from("invoices")
      .update({ status: "email_failed" })
      .eq("id", invoice.id);
    return res.status(500).json({ error: "The Square link was saved, but the email did not send." });
  }

  res.status(201).json({
    success: true,
    invoice: serializeInvoice(invoice),
  });
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

async function loadInvoicesByRequestId(requestIds) {
  const uniqueRequestIds = [...new Set((requestIds || []).filter(Boolean))];
  const invoicesByRequestId = new Map();

  if (uniqueRequestIds.length === 0) {
    return invoicesByRequestId;
  }

  const { data, error } = await supabase
    .from("invoices")
    .select("id, quote_request_id, title, total, status, due_date, square_payment_link_url, sent_at, created_at")
    .in("quote_request_id", uniqueRequestIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load invoices", error);
    return invoicesByRequestId;
  }

  for (const invoice of data || []) {
    const requestId = invoice.quote_request_id;
    const invoices = invoicesByRequestId.get(requestId) || [];
    invoices.push(serializeInvoice(invoice));
    invoicesByRequestId.set(requestId, invoices);
  }

  return invoicesByRequestId;
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

  const bucketOptions = {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: allowedAttachmentMimeTypes,
  };

  if ((data || []).some((bucket) => bucket.name === attachmentsBucket)) {
    const { error: updateError } = await supabase.storage.updateBucket(
      attachmentsBucket,
      bucketOptions
    );

    if (updateError) {
      throw new Error(`Supabase attachments bucket update failed: ${updateError.message}`);
    }

    return;
  }

  const { error: createError } = await supabase.storage.createBucket(
    attachmentsBucket,
    bucketOptions
  );

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

function normalizeInvoiceRequest(body) {
  const items = Array.isArray(body.items)
    ? body.items
        .map((item) => ({
          description: cleanValue(item.description),
          amount: Math.round(Number(item.amount || 0) * 100) / 100,
        }))
        .filter((item) => item.description && Number.isFinite(item.amount) && item.amount > 0)
    : [];

  return {
    requestId: cleanValue(body.requestId),
    title: cleanValue(body.title) || "Project Invoice",
    dueDate: cleanValue(body.dueDate),
    notes: cleanValue(body.notes),
    items,
    total: Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
  };
}

function isAllowedAttachment(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  return (
    allowedAttachmentMimeTypes.includes(cleanValue(file.mimetype)) ||
    allowedAttachmentExtensions.has(extension)
  );
}

function getAttachmentContentType(file) {
  const mimeType = cleanValue(file.mimetype);

  if (allowedAttachmentMimeTypes.includes(mimeType)) {
    return mimeType;
  }

  const extension = path.extname(file.originalname || file.filename || "").toLowerCase();
  const contentTypeByExtension = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
  };

  return contentTypeByExtension[extension] || "text/plain";
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
    contentType: getAttachmentContentType(file),
  }));

  try {
    for (const file of files) {
      const storagePath = getAttachmentStoragePath(requestId, file.filename);
      const buffer = fs.readFileSync(file.path);
      const { error } = await supabase.storage.from(attachmentsBucket).upload(storagePath, buffer, {
        contentType: getAttachmentContentType(file),
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
  const siteUrl = getSiteUrl();
  const logoUrl = getPublicAssetUrl("/assets/header-logo.png");
  const attachmentNames = Array.isArray(attachments)
    ? attachments.map((attachment) => cleanValue(attachment.originalName)).filter(Boolean)
    : [];
  const ownerEmailPayload = {
    from: quoteNotificationFrom,
    to: recipients,
    subject: `New quote request from ${request.name || "website visitor"}`,
    html: buildQuoteNotificationHtml(request, attachmentNames, dashboardUrl, logoUrl),
    text: buildQuoteNotificationText(request, attachmentNames, dashboardUrl),
  };

  if (isValidEmail(request.email)) {
    ownerEmailPayload.replyTo = request.email;
  }

  const { error } = await resend.emails.send(ownerEmailPayload);

  if (error) {
    throw new Error(error.message || "Resend email failed.");
  }

  if (!isValidEmail(request.email)) {
    return;
  }

  const customerEmailPayload = {
    from: quoteNotificationFrom,
    to: request.email,
    subject: "We received your free quote request",
    html: buildQuoteConfirmationHtml(request, attachmentNames, siteUrl, logoUrl),
    text: buildQuoteConfirmationText(request, attachmentNames, siteUrl),
  };

  const customerEmailResult = await resend.emails.send(customerEmailPayload);

  if (customerEmailResult.error) {
    throw new Error(customerEmailResult.error.message || "Resend customer confirmation email failed.");
  }
}

async function sendInvoiceEmail(invoice, quoteRequest) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  if (!quoteNotificationFrom) {
    throw new Error("QUOTE_NOTIFICATION_FROM is not configured.");
  }

  const dashboardUrl = getDashboardUrl();
  const logoUrl = getPublicAssetUrl("/assets/header-logo.png");
  const subject = `${invoice.title || "Project Payment Link"} from Jason's Lake Ozarks`;
  const text = buildInvoiceEmailText(invoice, quoteRequest, dashboardUrl);
  const html = buildInvoiceEmailHtml(invoice, quoteRequest, dashboardUrl, logoUrl);

  const { error } = await resend.emails.send({
    from: quoteNotificationFrom,
    to: quoteRequest.email,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(error.message || "Resend invoice email failed.");
  }
}

async function createSquarePaymentLink(invoicePayload, quoteRequest) {
  if (!squareAccessToken) {
    throw new Error("SQUARE_ACCESS_TOKEN is not configured.");
  }

  if (!squareLocationId) {
    throw new Error("SQUARE_LOCATION_ID is not configured.");
  }

  const amountCents = Math.round(Number(invoicePayload.total || 0) * 100);

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Square payment amount must be greater than zero.");
  }

  const response = await fetch(`${squareApiBaseUrl}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${squareAccessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-12-18",
    },
    body: JSON.stringify({
      idempotency_key: createIdempotencyKey(),
      quick_pay: {
        name: invoicePayload.title || `Project payment for ${quoteRequest.name || "customer"}`,
        price_money: {
          amount: amountCents,
          currency: "USD",
        },
        location_id: squareLocationId,
      },
      checkout_options: {
        ask_for_shipping_address: false,
      },
      pre_populated_data: {
        buyer_email: quoteRequest.email,
      },
      payment_note: `Quote request ${quoteRequest.id} - ${quoteRequest.service || "Project"}`,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      Array.isArray(result.errors) && result.errors.length > 0
        ? result.errors.map((error) => error.detail || error.code).filter(Boolean).join("; ")
        : "Square payment link request failed.";
    throw new Error(message);
  }

  const paymentLink = result.payment_link || {};

  if (!paymentLink.url) {
    throw new Error("Square did not return a payment link URL.");
  }

  return {
    id: paymentLink.id || "",
    url: paymentLink.url,
    orderId: paymentLink.order_id || "",
  };
}

function buildInvoiceEmailText(invoice, quoteRequest, dashboardUrl) {
  const lineItems = getInvoiceLineItemsFromRecord(invoice)
    .map((item) => `- ${item.description}: ${formatCurrency(item.amount)}`)
    .join("\n");

  return [
    `Hi ${quoteRequest.name || "there"},`,
    "",
    `Here is your Square payment link from Jason's Lake Ozarks Pro Painting and Remodeling.`,
    "",
    `Payment Request: ${invoice.title || "Project Payment"}`,
    invoice.due_date ? `Due Date: ${invoice.due_date}` : "",
    "",
    "Line Items:",
    lineItems,
    "",
    `Total: ${formatCurrency(invoice.total)}`,
    invoice.square_payment_link_url ? `Pay securely with Square: ${invoice.square_payment_link_url}` : "",
    invoice.notes ? `\nNotes:\n${invoice.notes}` : "",
    dashboardUrl ? `\nQuestions? You can reply to this email or contact us from ${dashboardUrl.replace(/\/dashboard$/, "")}.` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildInvoiceEmailHtml(invoice, quoteRequest, dashboardUrl, logoUrl) {
  const lineItems = getInvoiceLineItemsFromRecord(invoice);
  const itemRows = lineItems
    .map(
      (item) => `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #d8e4f2;color:#263c55;">${escapeHtml(item.description)}</td>
          <td style="padding:12px;border-bottom:1px solid #d8e4f2;text-align:right;color:#263c55;font-weight:700;">${escapeHtml(formatCurrency(item.amount))}</td>
        </tr>
      `
    )
    .join("");
  const logoMarkup = logoUrl
    ? `<div style="margin:0 0 18px;text-align:center;"><img src="${escapeHtmlAttr(logoUrl)}" alt="Jason's Lake Ozarks Pro Painting and Remodeling" style="display:inline-block;max-width:260px;width:100%;height:auto;" /></div>`
    : "";
  const notesMarkup = invoice.notes
    ? `<h2 style="margin:22px 0 8px;color:#163f70;font-size:18px;">Notes</h2><p style="margin:0;white-space:pre-wrap;line-height:1.55;">${escapeHtml(invoice.notes)}</p>`
    : "";
  const paymentButton = invoice.square_payment_link_url
    ? `<p style="margin:24px 0 0;text-align:center;"><a href="${escapeHtmlAttr(invoice.square_payment_link_url)}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#1d5ea8;color:#ffffff;text-decoration:none;font-weight:800;">Pay Securely With Square</a></p>`
    : "";

  return `
    <div style="margin:0;padding:24px;background:#eef4fb;font-family:Arial,sans-serif;color:#263c55;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d8e4f2;border-radius:18px;padding:24px;">
        ${logoMarkup}
        <p style="margin:0 0 8px;color:#f58220;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">Square Payment Link</p>
        <h1 style="margin:0 0 10px;color:#163f70;font-size:28px;line-height:1.15;">${escapeHtml(invoice.title || "Project Payment")}</h1>
        <p style="margin:0 0 18px;line-height:1.55;">Hi ${escapeHtml(quoteRequest.name || "there")}, here is your secure Square payment link for your ${escapeHtml(quoteRequest.service || "project")} request.</p>
        ${invoice.due_date ? `<p style="margin:0 0 18px;"><strong>Due date:</strong> ${escapeHtml(invoice.due_date)}</p>` : ""}
        <table style="width:100%;border-collapse:collapse;margin-top:12px;border:1px solid #d8e4f2;">
          <thead>
            <tr>
              <th style="padding:12px;background:#f5f9ff;color:#24486f;text-align:left;">Description</th>
              <th style="padding:12px;background:#f5f9ff;color:#24486f;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr>
              <td style="padding:14px;text-align:right;color:#163f70;font-weight:800;">Total</td>
              <td style="padding:14px;text-align:right;color:#163f70;font-weight:800;font-size:20px;">${escapeHtml(formatCurrency(invoice.total))}</td>
            </tr>
          </tfoot>
        </table>
        ${notesMarkup}
        ${paymentButton}
        <p style="margin:24px 0 0;color:#34506f;line-height:1.55;">Questions? Reply to this email and we will help.</p>
        ${dashboardUrl ? `<p style="margin:8px 0 0;color:#7890aa;font-size:12px;">Payment link created from the owner dashboard.</p>` : ""}
      </div>
    </div>
  `;
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

function buildQuoteNotificationHtml(request, attachmentNames, dashboardUrl, logoUrl) {
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
  const logoMarkup = logoUrl
    ? `<div style="margin:0 0 18px;text-align:center;"><img src="${escapeHtmlAttr(logoUrl)}" alt="Jason's Lake Ozarks Pro Painting and Remodeling" style="display:inline-block;max-width:260px;width:100%;height:auto;" /></div>`
    : "";

  return `
    <div style="margin:0;padding:24px;background:#eef4fb;font-family:Arial,sans-serif;color:#263c55;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d8e4f2;border-radius:18px;padding:24px;">
        ${logoMarkup}
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

function buildQuoteNotificationText(request, attachmentNames, dashboardUrl) {
  return [
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
}

function buildQuoteConfirmationText(request, attachmentNames, siteUrl) {
  return [
    `Hi ${request.name || "there"},`,
    "",
    "We received your free quote request and will review it shortly.",
    "",
    `Service: ${request.service || "Not provided"}`,
    `Property Address / Area: ${request.city || "Not provided"}`,
    `Timeline: ${request.timeline || "Not provided"}`,
    `Submitted: ${formatSubmittedAt(request.submitted_at)}`,
    "",
    "Project Details:",
    request.details || "No project details were added.",
    "",
    `Attachments Received: ${attachmentNames.length ? attachmentNames.join(", ") : "None"}`,
    "",
    "If you need to add anything else, just reply to this email.",
    siteUrl ? `Website: ${siteUrl}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildQuoteConfirmationHtml(request, attachmentNames, siteUrl, logoUrl) {
  const fields = [
    ["Service", request.service || "Not provided"],
    ["Property Address / Area", request.city || "Not provided"],
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
  const logoMarkup = logoUrl
    ? `<div style="margin:0 0 18px;text-align:center;"><img src="${escapeHtmlAttr(logoUrl)}" alt="Jason's Lake Ozarks Pro Painting and Remodeling" style="display:inline-block;max-width:260px;width:100%;height:auto;" /></div>`
    : "";
  const siteButton = siteUrl
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtmlAttr(siteUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#1d5ea8;color:#ffffff;text-decoration:none;font-weight:700;">Visit Website</a></p>`
    : "";

  return `
    <div style="margin:0;padding:24px;background:#eef4fb;font-family:Arial,sans-serif;color:#263c55;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d8e4f2;border-radius:18px;padding:24px;">
        ${logoMarkup}
        <p style="margin:0 0 8px;color:#f58220;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">Quote Request Received</p>
        <h1 style="margin:0 0 12px;color:#163f70;font-size:28px;line-height:1.15;">Thanks, ${escapeHtml(request.name || "there")}</h1>
        <p style="margin:0 0 18px;line-height:1.55;">We received your free quote request and will review the details shortly. Here is a copy of what you sent us.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">${rows}</table>
        <h2 style="margin:0 0 8px;color:#163f70;font-size:18px;">Project Details</h2>
        <p style="margin:0 0 18px;white-space:pre-wrap;line-height:1.55;">${escapeHtml(request.details || "No project details were added.")}</p>
        <h2 style="margin:0 0 8px;color:#163f70;font-size:18px;">Attachments Received</h2>
        <ul style="margin:0;padding-left:20px;line-height:1.55;">${attachmentText}</ul>
        <p style="margin:22px 0 0;line-height:1.55;">If you want to add more details before we follow up, just reply to this email.</p>
        ${siteButton}
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
  const siteUrl = getSiteUrl();

  if (!siteUrl) {
    return "";
  }

  return `${siteUrl}/dashboard`;
}

function getPublicAssetUrl(assetPath) {
  const siteUrl = getSiteUrl();

  if (!siteUrl) {
    return "";
  }

  return `${siteUrl}/${cleanValue(assetPath).replace(/^\/+/, "")}`;
}

function getSiteUrl() {
  const siteUrl =
    cleanValue(process.env.SITE_URL) ||
    cleanValue(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    cleanValue(process.env.VERCEL_URL);

  if (!siteUrl) {
    return "";
  }

  const normalizedUrl = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`;
  return normalizedUrl.replace(/\/+$/, "");
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

function createInvoiceId() {
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createIdempotencyKey() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function serializeInvoice(invoice) {
  return {
    id: invoice.id,
    quoteRequestId: invoice.quote_request_id,
    title: invoice.title,
    total: Number(invoice.total) || 0,
    status: invoice.status,
    paymentUrl: invoice.square_payment_link_url,
    dueDate: invoice.due_date,
    sentAt: invoice.sent_at,
    createdAt: invoice.created_at,
  };
}

function getInvoiceLineItemsFromRecord(invoice) {
  return Array.isArray(invoice.line_items)
    ? invoice.line_items
        .map((item) => ({
          description: cleanValue(item.description),
          amount: Number(item.amount) || 0,
        }))
        .filter((item) => item.description && item.amount > 0)
    : [];
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function getAttachmentsRoot() {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "homerepair-quote-attachments");
  }

  return path.join(rootDir, "data", "quote-attachments");
}
