const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

const loginStatus = document.querySelector("[data-login-status]");
if (loginStatus) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("error") === "invalid") {
    loginStatus.textContent = "That username or password did not match.";
    loginStatus.dataset.state = "error";
  }
}

const resetStatus = document.querySelector("[data-reset-status]");
if (resetStatus) {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const success = params.get("success");

  if (success === "1") {
    resetStatus.textContent = "Password updated successfully.";
    resetStatus.dataset.state = "success";
  } else if (error === "current") {
    resetStatus.textContent = "Your current password was incorrect.";
    resetStatus.dataset.state = "error";
  } else if (error === "length") {
    resetStatus.textContent = "Your new password must be at least 8 characters.";
    resetStatus.dataset.state = "error";
  } else if (error === "match") {
    resetStatus.textContent = "Your new passwords did not match.";
    resetStatus.dataset.state = "error";
  } else if (error === "same") {
    resetStatus.textContent = "Choose a new password that is different from the current one.";
    resetStatus.dataset.state = "error";
  }
}

const quoteForm = document.querySelector("[data-quote-form]");
if (quoteForm) {
  const submitButton = quoteForm.querySelector(".submit-btn");
  const formStatus = quoteForm.querySelector("[data-form-status]");

  quoteForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(quoteForm);
    const payload = Object.fromEntries(formData.entries());

    if (formStatus) {
      formStatus.textContent = "Sending your request...";
      formStatus.dataset.state = "pending";
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending...";
    }

    try {
      const response = await fetch("/api/quote-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "We could not send your request.");
      }

      quoteForm.reset();

      if (formStatus) {
        formStatus.textContent = "Quote request sent. We will reach out soon.";
        formStatus.dataset.state = "success";
      }
    } catch (error) {
      if (formStatus) {
        formStatus.textContent = error.message || "We could not send your request.";
        formStatus.dataset.state = "error";
      }
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Send Quote Request";
      }
    }
  });
}

const dashboardGrid = document.getElementById("dashboard-grid");
if (dashboardGrid) {
  const dashboardStatus = document.getElementById("dashboard-status");
  const dashboardSummary = document.getElementById("dashboard-summary");
  const dashboardEmpty = document.getElementById("dashboard-empty");

  const loadRequests = async () => {
    try {
      const response = await fetch("/api/quote-requests", {
        headers: {
          Accept: "application/json",
        },
      });

      const result = await response.json().catch(() => ({}));

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (!response.ok) {
        throw new Error(result.error || "We could not load quote requests.");
      }

      const requests = Array.isArray(result.requests) ? result.requests : [];

      if (dashboardSummary) {
        dashboardSummary.textContent =
          requests.length === 1 ? "1 request received" : `${requests.length} requests received`;
      }

      if (dashboardStatus) {
        dashboardStatus.textContent = "";
      }

      if (dashboardEmpty) {
        dashboardEmpty.hidden = requests.length > 0;
      }

      dashboardGrid.innerHTML = requests.map(renderRequestCard).join("");
    } catch (error) {
      if (dashboardStatus) {
        dashboardStatus.textContent = error.message || "We could not load quote requests.";
      }

      if (dashboardSummary) {
        dashboardSummary.textContent = "Requests unavailable right now.";
      }
    }
  };

  loadRequests();
}

const navShell = document.querySelector(".sticky-nav-shell");
if (navShell) {
  const root = document.documentElement;
  let lastScrollY = window.scrollY;
  let ticking = false;

  const updateNavHeight = () => {
    root.style.setProperty("--nav-shell-height", `${navShell.offsetHeight}px`);
  };

  updateNavHeight();
  window.addEventListener("resize", updateNavHeight);

  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;

      ticking = true;
      window.requestAnimationFrame(() => {
        const currentY = window.scrollY;

        if (currentY <= 20) {
          document.body.classList.remove("nav-hidden");
        } else if (currentY > lastScrollY + 8) {
          document.body.classList.add("nav-hidden");
        } else if (currentY < lastScrollY - 8) {
          document.body.classList.remove("nav-hidden");
        }

        lastScrollY = currentY;
        ticking = false;
      });
    },
    { passive: true }
  );
}

function renderRequestCard(request) {
  const submittedAt = request.submittedAt
    ? new Date(request.submittedAt).toLocaleString()
    : "Unknown time";

  return `
    <article class="request-card">
      <div class="request-card-head">
        <div>
          <h3>${escapeHtml(request.name || "Unnamed lead")}</h3>
          <p>${escapeHtml(request.service || "Service not listed")}</p>
        </div>
        <span class="request-timestamp">${escapeHtml(submittedAt)}</span>
      </div>
      <dl class="request-meta">
        <div><dt>Phone</dt><dd><a href="tel:${escapeHtmlAttr(request.phone || "")}">${escapeHtml(request.phone || "Not provided")}</a></dd></div>
        <div><dt>Email</dt><dd><a href="mailto:${escapeHtmlAttr(request.email || "")}">${escapeHtml(request.email || "Not provided")}</a></dd></div>
        <div><dt>City / Area</dt><dd>${escapeHtml(request.city || "Not provided")}</dd></div>
        <div><dt>Timeline</dt><dd>${escapeHtml(request.timeline || "Not provided")}</dd></div>
      </dl>
      <div class="request-details">
        <h4>Project Details</h4>
        <p>${escapeHtml(request.details || "No project details were added.")}</p>
      </div>
    </article>
  `;
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
