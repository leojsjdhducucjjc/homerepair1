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
        body: formData,
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

const reviewForm = document.querySelector("[data-review-form]");
if (reviewForm) {
  const reviewGrid = document.querySelector("[data-reviews-grid]");
  const reviewStatus = reviewForm.querySelector("[data-review-status]");
  const reviewsLoadStatus = document.querySelector("[data-reviews-load-status]");
  const reviewSubmitButton = reviewForm.querySelector(".submit-btn");

  const loadReviews = async () => {
    if (!reviewGrid) {
      return;
    }

    if (reviewsLoadStatus) {
      reviewsLoadStatus.textContent = "Loading reviews...";
      reviewsLoadStatus.dataset.state = "pending";
    }

    try {
      const response = await fetch("/api/reviews", {
        headers: {
          Accept: "application/json",
        },
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "We could not load reviews.");
      }

      const reviews = Array.isArray(result.reviews) ? result.reviews : [];
      reviewGrid.innerHTML = reviews.length
        ? reviews.map(renderPublicReviewCard).join("")
        : `<article class="testimonial-card"><p class="quote">No site reviews yet. Be the first to leave one.</p></article>`;

      if (reviewsLoadStatus) {
        reviewsLoadStatus.textContent = "";
        delete reviewsLoadStatus.dataset.state;
      }
    } catch (error) {
      if (reviewsLoadStatus) {
        reviewsLoadStatus.textContent = error.message || "We could not load reviews.";
        reviewsLoadStatus.dataset.state = "error";
      }
    }
  };

  reviewForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(reviewForm);
    const payload = {
      name: formData.get("name") || "",
      city: formData.get("city") || "",
      rating: formData.get("rating") || "",
      quote: formData.get("quote") || "",
    };

    if (reviewStatus) {
      reviewStatus.textContent = "Sending your review...";
      reviewStatus.dataset.state = "pending";
    }

    if (reviewSubmitButton) {
      reviewSubmitButton.disabled = true;
      reviewSubmitButton.textContent = "Sending...";
    }

    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "We could not save your review.");
      }

      reviewForm.reset();

      if (reviewStatus) {
        reviewStatus.textContent = "Review sent. Thank you for sharing your feedback.";
        reviewStatus.dataset.state = "success";
      }

      await loadReviews();
    } catch (error) {
      if (reviewStatus) {
        reviewStatus.textContent = error.message || "We could not save your review.";
        reviewStatus.dataset.state = "error";
      }
    } finally {
      if (reviewSubmitButton) {
        reviewSubmitButton.disabled = false;
        reviewSubmitButton.textContent = "Send Review";
      }
    }
  });

  loadReviews();
}

const dashboardGrid = document.getElementById("dashboard-grid");
if (dashboardGrid) {
  const dashboardStatus = document.getElementById("dashboard-status");
  const dashboardSummary = document.getElementById("dashboard-summary");
  const dashboardEmpty = document.getElementById("dashboard-empty");
  const clearAllButton = document.getElementById("dashboard-clear-all");
  const invoiceModal = document.getElementById("invoice-modal");
  const invoiceForm = document.getElementById("invoice-form");
  const invoiceStatus = document.getElementById("invoice-status");
  const invoiceSubmit = document.getElementById("invoice-submit");
  const invoiceCustomerSummary = document.getElementById("invoice-customer-summary");
  const invoiceRequestId = document.getElementById("invoice-request-id");
  const invoiceLineItems = document.getElementById("invoice-line-items");
  const invoiceAddLine = document.getElementById("invoice-add-line");
  let dashboardRequests = [];

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
      dashboardRequests = requests;

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

      if (clearAllButton) {
        clearAllButton.disabled = requests.length === 0;
      }
    } catch (error) {
      if (dashboardStatus) {
        dashboardStatus.textContent = error.message || "We could not load quote requests.";
      }

      if (dashboardSummary) {
        dashboardSummary.textContent = "Requests unavailable right now.";
      }

      if (clearAllButton) {
        clearAllButton.disabled = true;
      }
    }
  };

  dashboardGrid.addEventListener("click", async (event) => {
    const invoiceButton = event.target.closest("[data-create-invoice]");
    if (invoiceButton) {
      const requestId = invoiceButton.getAttribute("data-create-invoice") || "";
      const request = dashboardRequests.find((item) => item.id === requestId);

      if (request) {
        openInvoiceModal(request);
      }

      return;
    }

    const deleteButton = event.target.closest("[data-delete-request]");

    if (!deleteButton) {
      return;
    }

    const requestId = deleteButton.getAttribute("data-delete-request") || "";
    const requestName = deleteButton.getAttribute("data-request-name") || "this request";

    if (!requestId) {
      return;
    }

    const confirmed = await showDashboardConfirm(
      `Delete ${requestName}? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    deleteButton.disabled = true;

    if (dashboardStatus) {
      dashboardStatus.textContent = "Deleting request...";
    }

    try {
      const response = await fetch(`/api/quote-requests/${encodeURIComponent(requestId)}`, {
        method: "DELETE",
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
        throw new Error(result.error || "We could not delete that request.");
      }

      if (dashboardStatus) {
        dashboardStatus.textContent = "Request deleted.";
      }

      await loadRequests();
    } catch (error) {
      if (dashboardStatus) {
        dashboardStatus.textContent = error.message || "We could not delete that request.";
      }

      deleteButton.disabled = false;
    }
  });

  if (clearAllButton) {
    clearAllButton.addEventListener("click", async () => {
      const confirmed = await showDashboardConfirm(
        "Delete all quote requests? This will permanently remove every response and attachment."
      );

      if (!confirmed) {
        return;
      }

      clearAllButton.disabled = true;

      if (dashboardStatus) {
        dashboardStatus.textContent = "Deleting all requests...";
      }

      try {
        const response = await fetch("/api/quote-requests", {
          method: "DELETE",
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
          throw new Error(result.error || "We could not clear the requests.");
        }

        if (dashboardStatus) {
          dashboardStatus.textContent = "All requests deleted.";
        }

        await loadRequests();
      } catch (error) {
        if (dashboardStatus) {
          dashboardStatus.textContent = error.message || "We could not clear the requests.";
        }

        clearAllButton.disabled = false;
      }
    });
  }

  if (invoiceAddLine) {
    invoiceAddLine.addEventListener("click", () => {
      addInvoiceLineItem();
    });
  }

  if (invoiceModal) {
    invoiceModal.addEventListener("click", (event) => {
      if (event.target?.matches("[data-invoice-close]")) {
        closeInvoiceModal();
      }
    });
  }

  if (invoiceForm) {
    invoiceForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const requestId = invoiceRequestId?.value || "";
      const title = invoiceForm.elements.title?.value || "";
      const dueDate = invoiceForm.elements.dueDate?.value || "";
      const notes = invoiceForm.elements.notes?.value || "";
      const items = getInvoiceLineItems();

      if (items.length === 0) {
        if (invoiceStatus) {
          invoiceStatus.textContent = "Add at least one payment line item.";
          invoiceStatus.dataset.state = "error";
        }
        return;
      }

      if (invoiceStatus) {
        invoiceStatus.textContent = "Sending Square payment link...";
        invoiceStatus.dataset.state = "pending";
      }

      if (invoiceSubmit) {
        invoiceSubmit.disabled = true;
        invoiceSubmit.textContent = "Sending...";
      }

      try {
        const response = await fetch("/api/invoices", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requestId, title, dueDate, notes, items }),
        });

        const result = await response.json().catch(() => ({}));

        if (response.status === 401) {
          window.location.href = "/login";
          return;
        }

        if (!response.ok) {
          throw new Error(result.error || "We could not send that Square payment link.");
        }

        if (invoiceStatus) {
          invoiceStatus.textContent = "Square payment link sent.";
          invoiceStatus.dataset.state = "success";
        }

        await loadRequests();
        window.setTimeout(closeInvoiceModal, 700);
      } catch (error) {
        if (invoiceStatus) {
          invoiceStatus.textContent = error.message || "We could not send that Square payment link.";
          invoiceStatus.dataset.state = "error";
        }
      } finally {
        if (invoiceSubmit) {
          invoiceSubmit.disabled = false;
          invoiceSubmit.textContent = "Send Square Link";
        }
      }
    });
  }

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
      ${renderAttachmentList(request.attachments)}
      <div class="request-details">
        <h4>Project Details</h4>
        <p>${escapeHtml(request.details || "No project details were added.")}</p>
      </div>
      ${renderInvoiceSummary(request.invoices)}
      <div class="request-card-actions">
        <button
          class="request-invoice-btn"
          type="button"
          data-create-invoice="${escapeHtmlAttr(request.id || "")}"
        >
          Create Square Link
        </button>
        <button
          class="request-delete-btn"
          type="button"
          data-delete-request="${escapeHtmlAttr(request.id || "")}"
          data-request-name="${escapeHtmlAttr(request.name || "this request")}"
        >
          Delete Request
        </button>
      </div>
    </article>
  `;
}

function renderPublicReviewCard(review) {
  const cityMarkup = review.city
    ? `<p class="city">${escapeHtml(review.city)}</p>`
    : "";

  return `
    <article class="testimonial-card">
      <p class="stars" aria-label="${escapeHtmlAttr(`${review.rating || 5} out of 5 stars`)}">${renderStarString(review.rating || 5)}</p>
      <p class="quote">"${escapeHtml(review.quote || "")}"</p>
      <div class="person-row">
        <div class="person-meta">
          <p class="name">${escapeHtml(review.name || "Customer")}</p>
          ${cityMarkup}
        </div>
        <div class="avatar">${escapeHtml(getInitials(review.name || "Customer"))}</div>
      </div>
    </article>
  `;
}

function renderInvoiceSummary(invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) {
    return "";
  }

  return `
    <div class="request-details invoice-history">
      <h4>Square Links Sent</h4>
      <ul>
        ${invoices
          .map(
            (invoice) => `
              <li>
                <span>${escapeHtml(invoice.title || "Payment Link")}</span>
                <strong>${formatMoney(invoice.total || 0)}</strong>
                ${
                  invoice.paymentUrl
                    ? `<a href="${escapeHtmlAttr(invoice.paymentUrl)}" target="_blank" rel="noreferrer">Open Square Link</a>`
                    : ""
                }
                <small>${escapeHtml(invoice.sentAt ? new Date(invoice.sentAt).toLocaleString() : "Sent")}</small>
              </li>
            `
          )
          .join("")}
      </ul>
    </div>
  `;
}

function openInvoiceModal(request) {
  const invoiceModal = document.getElementById("invoice-modal");
  const invoiceForm = document.getElementById("invoice-form");
  const invoiceStatus = document.getElementById("invoice-status");
  const invoiceCustomerSummary = document.getElementById("invoice-customer-summary");
  const invoiceRequestId = document.getElementById("invoice-request-id");
  const invoiceLineItems = document.getElementById("invoice-line-items");

  if (!invoiceModal || !invoiceForm || !invoiceRequestId || !invoiceLineItems) {
    return;
  }

  invoiceForm.reset();
  invoiceRequestId.value = request.id || "";

  if (invoiceCustomerSummary) {
    invoiceCustomerSummary.textContent = `Sending to ${request.name || "customer"} at ${request.email || "no email listed"}.`;
  }

  if (invoiceStatus) {
    invoiceStatus.textContent = "";
    delete invoiceStatus.dataset.state;
  }

  invoiceLineItems.innerHTML = "";
  addInvoiceLineItem(`${request.service || "Project service"}`, "");
  invoiceModal.hidden = false;
  document.body.classList.add("modal-open");
  invoiceForm.querySelector("input[name='itemDescription']")?.focus();
}

function closeInvoiceModal() {
  const invoiceModal = document.getElementById("invoice-modal");
  const invoiceSubmit = document.getElementById("invoice-submit");

  if (invoiceModal) {
    invoiceModal.hidden = true;
  }

  if (invoiceSubmit) {
    invoiceSubmit.disabled = false;
    invoiceSubmit.textContent = "Send Square Link";
  }

  document.body.classList.remove("modal-open");
}

function addInvoiceLineItem(description = "", amount = "") {
  const invoiceLineItems = document.getElementById("invoice-line-items");

  if (!invoiceLineItems) {
    return;
  }

  const row = document.createElement("div");
  row.className = "invoice-line-item";
  row.innerHTML = `
    <div>
      <label>Description</label>
      <input name="itemDescription" type="text" placeholder="Example: Painting labor and materials" value="${escapeHtmlAttr(description)}" required />
    </div>
    <div>
      <label>Amount</label>
      <input name="itemAmount" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtmlAttr(amount)}" required />
    </div>
    <button class="invoice-remove-line" type="button" aria-label="Remove line item">×</button>
  `;

  row.querySelector(".invoice-remove-line")?.addEventListener("click", () => {
    if (invoiceLineItems.querySelectorAll(".invoice-line-item").length > 1) {
      row.remove();
    }
  });

  invoiceLineItems.append(row);
}

function getInvoiceLineItems() {
  return Array.from(document.querySelectorAll("#invoice-line-items .invoice-line-item"))
    .map((row) => {
      const description = row.querySelector("input[name='itemDescription']")?.value.trim() || "";
      const amount = Number(row.querySelector("input[name='itemAmount']")?.value || 0);
      return { description, amount };
    })
    .filter((item) => item.description && Number.isFinite(item.amount) && item.amount > 0);
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function renderAttachmentList(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }

  const imageAttachments = attachments.filter(isImageAttachment);
  const fileAttachments = attachments.filter((attachment) => !isImageAttachment(attachment));

  return `
    <div class="request-details request-attachments">
      <h4>Attached Files</h4>
      ${imageAttachments.length > 0 ? renderAttachmentPreviewGrid(imageAttachments) : ""}
      ${fileAttachments.length > 0 ? renderAttachmentFileList(fileAttachments) : ""}
    </div>
  `;
}

function renderStarString(rating) {
  return Array.from({ length: 5 }, (_, index) => (index < rating ? "★" : "☆")).join(" ");
}

function getInitials(name) {
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "JR";
  }

  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function renderAttachmentPreviewGrid(attachments) {
  return `
    <div class="attachment-preview-grid">
      ${attachments
        .map(
          (attachment) => `
            <a
              class="attachment-preview-link"
              href="${escapeHtmlAttr(attachment.url || "#")}"
              target="_blank"
              rel="noreferrer"
            >
              <img
                class="attachment-preview-image"
                src="${escapeHtmlAttr(attachment.url || "#")}"
                alt="${escapeHtmlAttr(attachment.originalName || "Attached image")}"
                loading="lazy"
              />
              <span class="attachment-preview-caption">${escapeHtml(attachment.originalName || "Attached image")}</span>
            </a>
          `
        )
        .join("")}
    </div>
  `;
}

function renderAttachmentFileList(attachments) {
  return `
    <ul class="attachment-list">
      ${attachments
        .map(
          (attachment) => `
            <li>
              <a href="${escapeHtmlAttr(attachment.url || "#")}" target="_blank" rel="noreferrer">
                ${escapeHtml(attachment.originalName || "Attachment")}
              </a>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function isImageAttachment(attachment) {
  const url = String(attachment?.url || "").toLowerCase();
  const name = String(attachment?.originalName || "").toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].some(
    (extension) => url.endsWith(extension) || name.endsWith(extension)
  );
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

function showDashboardConfirm(message) {
  const modal = document.getElementById("dashboard-confirm");
  const messageEl = document.getElementById("dashboard-confirm-message");
  const okButton = document.getElementById("dashboard-confirm-ok");
  const cancelButton = document.getElementById("dashboard-confirm-cancel");

  if (!modal || !messageEl || !okButton || !cancelButton) {
    return Promise.resolve(window.confirm(message));
  }

  messageEl.textContent = message;
  modal.hidden = false;
  document.body.classList.add("modal-open");

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.hidden = true;
      document.body.classList.remove("modal-open");
      okButton.removeEventListener("click", handleOk);
      cancelButton.removeEventListener("click", handleCancel);
      modal.removeEventListener("click", handleBackdrop);
      document.removeEventListener("keydown", handleKeydown);
      resolve(result);
    };

    const handleOk = () => cleanup(true);
    const handleCancel = () => cleanup(false);
    const handleBackdrop = (event) => {
      if (event.target?.matches("[data-confirm-cancel]")) {
        cleanup(false);
      }
    };
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        cleanup(false);
      }
    };

    okButton.addEventListener("click", handleOk);
    cancelButton.addEventListener("click", handleCancel);
    modal.addEventListener("click", handleBackdrop);
    document.addEventListener("keydown", handleKeydown);
    okButton.focus();
  });
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

    if (typeof window.google?.maps?.importLibrary === "function") {
      await window.google.maps.importLibrary("places");
    }

    if (window.google?.maps?.places?.AutocompleteService) {
      initializeGoogleAddressAutocompleteService(addressInput);
      return;
    }

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

function initializeGoogleAddressAutocompleteService(addressInput) {
  addressInput.setAttribute("autocomplete", "off");
  addressInput.setAttribute("spellcheck", "false");

  const wrapper = addressInput.parentElement;

  if (!wrapper) {
    return;
  }

  wrapper.classList.add("address-autocomplete");

  let dropdown = wrapper.querySelector(".address-autocomplete-menu");

  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.className = "address-autocomplete-menu";
    dropdown.hidden = true;
    dropdown.setAttribute("role", "listbox");
    wrapper.appendChild(dropdown);
  }

  let requestCounter = 0;
  let activeIndex = -1;
  let suggestions = [];
  let sessionToken = new window.google.maps.places.AutocompleteSessionToken();
  const autocompleteService = new window.google.maps.places.AutocompleteService();

  const clearSuggestions = () => {
    suggestions = [];
    activeIndex = -1;
    dropdown.innerHTML = "";
    dropdown.hidden = true;
    addressInput.removeAttribute("aria-activedescendant");
    addressInput.setAttribute("aria-expanded", "false");
  };

  const setActiveSuggestion = (nextIndex) => {
    const items = Array.from(dropdown.querySelectorAll(".address-autocomplete-item"));

    items.forEach((item, index) => {
      const isActive = index === nextIndex;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");

      if (isActive) {
        addressInput.setAttribute("aria-activedescendant", item.id);
      }
    });

    activeIndex = nextIndex;
  };

  const selectSuggestion = async (prediction) => {
    if (!prediction) {
      return;
    }

    addressInput.value = prediction.description || addressInput.value;

    sessionToken = new window.google.maps.places.AutocompleteSessionToken();
    clearSuggestions();
  };

  const renderSuggestions = (items) => {
    suggestions = items;
    activeIndex = -1;
    dropdown.innerHTML = "";

    if (!items.length) {
      clearSuggestions();
      return;
    }

    const fragment = document.createDocumentFragment();

    items.slice(0, 5).forEach((prediction, index) => {
      const button = document.createElement("button");
      const suggestionText = prediction.description || "";
      button.type = "button";
      button.className = "address-autocomplete-item";
      button.id = `address-suggestion-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.textContent = suggestionText;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", async () => {
        try {
          await selectSuggestion(prediction);
        } catch (_error) {
          clearSuggestions();
        }
      });
      fragment.appendChild(button);
    });

    dropdown.appendChild(fragment);
    dropdown.hidden = false;
    addressInput.setAttribute("aria-expanded", "true");
  };

  const fetchSuggestions = debounce(async () => {
    const query = addressInput.value.trim();

    if (query.length < 3) {
      clearSuggestions();
      return;
    }

    const currentRequest = ++requestCounter;

    try {
      const result = await autocompleteService.getPlacePredictions({
        input: query,
        sessionToken,
        componentRestrictions: { country: "us" },
      });

      if (currentRequest !== requestCounter) {
        return;
      }

      renderSuggestions(Array.isArray(result?.predictions) ? result.predictions : []);
    } catch (_error) {
      clearSuggestions();
    }
  }, 220);

  addressInput.setAttribute("role", "combobox");
  addressInput.setAttribute("aria-autocomplete", "list");
  addressInput.setAttribute("aria-expanded", "false");

  addressInput.addEventListener("input", () => {
    fetchSuggestions();
  });

  addressInput.addEventListener("keydown", async (event) => {
    if (dropdown.hidden || suggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(activeIndex < suggestions.length - 1 ? activeIndex + 1 : 0);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(activeIndex > 0 ? activeIndex - 1 : suggestions.length - 1);
      return;
    }

    if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();

      try {
        await selectSuggestion(suggestions[activeIndex]);
      } catch (_error) {
        clearSuggestions();
      }

      return;
    }

    if (event.key === "Escape") {
      clearSuggestions();
    }
  });

  addressInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      clearSuggestions();
    }, 150);
  });
}

function debounce(callback, delay) {
  let timeoutId = null;

  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback(...args);
    }, delay);
  };
}
