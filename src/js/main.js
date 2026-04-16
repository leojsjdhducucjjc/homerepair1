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
  } else if (params.get("error") === "config") {
    loginStatus.textContent =
      "Dashboard storage is not configured yet. Add the Supabase environment variables and database tables first.";
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
  } else if (error === "config") {
    resetStatus.textContent =
      "Password reset is not available until Supabase is configured and the database tables are set up.";
    resetStatus.dataset.state = "error";
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
  const addressInput = quoteForm.querySelector("[data-address-input]");
  initializeGoogleAddressAutocomplete(addressInput);

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

let googleMapsScriptPromise = null;

async function initializeGoogleAddressAutocomplete(addressInput) {
  if (!addressInput) {
    return;
  }

  try {
    const response = await fetch("/api/maps-config", {
      headers: {
        Accept: "application/json",
      },
    });
    const config = await response.json().catch(() => ({}));
    const apiKey = typeof config.googleMapsApiKey === "string" ? config.googleMapsApiKey.trim() : "";

    if (!response.ok || !apiKey) {
      return;
    }

    await loadGoogleMapsPlaces(apiKey);

    if (!window.google?.maps?.places?.Autocomplete) {
      return;
    }

    const autocomplete = new window.google.maps.places.Autocomplete(addressInput, {
      componentRestrictions: { country: "us" },
      fields: ["formatted_address"],
      types: ["address"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();

      if (place?.formatted_address) {
        addressInput.value = place.formatted_address;
      }
    });
  } catch (_error) {
    // Keep the field usable as a normal text input if Google autocomplete is unavailable.
  }
}

function loadGoogleMapsPlaces(apiKey) {
  if (googleMapsScriptPromise) {
    return googleMapsScriptPromise;
  }

  googleMapsScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) {
      resolve();
      return;
    }

    const existingScript = document.querySelector("[data-google-maps-loader]");
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMapsLoader = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), {
      once: true,
    });
    document.head.appendChild(script);
  });

  return googleMapsScriptPromise;
}
