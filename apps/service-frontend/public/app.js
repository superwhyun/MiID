(function () {
  "use strict";

  const API_BASE = "/api";
  const servicesState = new Map(); // Stores state for each service: { authStream, challengeId, profile, status }

  const elements = {
    screenDeck: document.getElementById("screen-deck"),
    servicesGrid: document.getElementById("services-grid"),
    btnAddService: document.getElementById("btn-add-service"),

    // Modal elements
    modalManage: document.getElementById("modal-manage"),
    inputOriginalId: document.getElementById("manage-id-original"),
    inputServiceId: document.getElementById("input-service-id"),
    inputServiceName: document.getElementById("input-service-name"),
    inputFields: document.getElementById("input-fields"),
    btnSaveManage: document.getElementById("btn-save-manage"),
    btnCloseManage: document.getElementById("btn-close-manage"),
    manageError: document.getElementById("manage-error")
  };

  const cardTemplate = document.getElementById("service-card-template");

  // --- Utilities ---

  function truncateId(id) {
    if (!id || id.length <= 16) return id;
    return id.substring(0, 8) + "..." + id.substring(id.length - 8);
  }

  function formatTime(isoString) {
    return new Date(isoString).toLocaleTimeString();
  }

  async function apiCall(method, path, body = null) {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include"
    };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(`${API_BASE}${path}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.message || data.error || "Request failed");
      err.code = data.error || "request_failed";
      throw err;
    }
    return data;
  }

  // --- Card Management ---

  function updateCardUI(serviceId) {
    const card = document.querySelector(`.service-card[data-service-id="${serviceId}"]`);
    if (!card) return;

    const state = servicesState.get(serviceId);
    const config = state.config;

    // Update Header
    const badge = card.querySelector(".status-badge");
    badge.textContent = config.registered ? "Registered" : "Unregistered";
    badge.className = `status-badge ${config.registered ? "registered" : "unregistered"}`;

    // Update Body
    card.querySelector(".service-name-display").textContent = config.service_name || config.service_id;
    card.querySelector(".service-id-display").textContent = config.service_id;

    // Update States
    card.querySelectorAll(".state").forEach(s => s.classList.add("hidden"));

    if (state.profile) {
      const successState = card.querySelector(".state-success");
      successState.classList.remove("hidden");
      successState.querySelector(".profile-subject-mini").textContent = truncateId(state.profile.subject_id);
      successState.querySelector(".profile-did-mini").textContent = truncateId(state.profile.did);
      successState.querySelector(".profile-risk-mini").textContent = state.profile.risk_level || "normal";
      successState.querySelector(".profile-service-mini").textContent = state.profile.service_id;

      const claimsContainer = successState.querySelector(".profile-claims-mini");
      claimsContainer.innerHTML = "";
      const requestedClaims = state.profile.requested_claims || [];
      const approvedClaims = new Set(state.profile.approved_claims || []);
      requestedClaims.forEach(claim => {
        const tag = document.createElement("div");
        const isApproved = approvedClaims.has(claim);
        tag.className = isApproved ? "claim-tag" : "claim-tag denied";
        tag.setAttribute("data-key", claim.toUpperCase());
        tag.textContent = isApproved ? (state.profile[claim] || "-") : "-";
        claimsContainer.appendChild(tag);
      });
    } else if (state.error) {
      const errorState = card.querySelector(".state-error");
      errorState.classList.remove("hidden");
      errorState.querySelector(".error-text").textContent = state.error;
    } else if (state.challengeId) {
      const waitingState = card.querySelector(".state-waiting");
      waitingState.classList.remove("hidden");
      waitingState.querySelector(".challenge-expires").textContent = state.expiresAt ? formatTime(state.expiresAt) : "-";
    } else {
      const initialState = card.querySelector(".state-initial");
      initialState.classList.remove("hidden");

      const btnLogin = initialState.querySelector(".btn-login");
      const btnRegister = initialState.querySelector(".btn-register");

      if (config.registered) {
        btnLogin.classList.remove("hidden");
        btnRegister.classList.add("hidden");
      } else {
        btnLogin.classList.add("hidden");
        btnRegister.classList.remove("hidden");
      }
    }
  }

  function createCard(config) {
    const clone = cardTemplate.content.cloneNode(true);
    const card = clone.querySelector(".service-card");
    card.dataset.serviceId = config.service_id;

    servicesState.set(config.service_id, { config, status: "initial" });
    elements.servicesGrid.appendChild(clone);
    updateCardUI(config.service_id);
  }

  async function loadServices() {
    try {
      const services = await apiCall("GET", "/services");
      // Don't clear servicesState, just update configs/status
      services.forEach(config => {
        if (servicesState.has(config.service_id)) {
          const state = servicesState.get(config.service_id);
          state.config = config;
        } else {
          createCard(config);
        }
      });
      // Remove stale ones
      const newIds = new Set(services.map(s => s.service_id));
      for (const id of servicesState.keys()) {
        if (!newIds.has(id)) {
          const card = document.querySelector(`.service-card[data-service-id="${id}"]`);
          if (card) card.remove();
          servicesState.delete(id);
        }
      }
    } catch (err) {
      console.error("Failed to load services", err);
    }
  }

  // --- Auth Logic ---

  function bindAuthStream(serviceId, challengeId) {
    const state = servicesState.get(serviceId);
    if (state.authStream) state.authStream.close();

    state.authStream = new EventSource(`${API_BASE}/auth/stream/${encodeURIComponent(challengeId)}`);

    const handlePayload = async (event) => {
      const data = JSON.parse(event.data);
      const status = data.payload.status;

      if (status === "active") {
        try {
          const result = await apiCall("POST", `/auth/complete/${challengeId}`, {});
          state.profile = result.profile;
          state.challengeId = null;
          state.authStream.close();
          updateCardUI(serviceId);
          // Bind session stream for this specific card
          bindSessionStream(serviceId);
        } catch (err) {
          state.error = err.message;
          updateCardUI(serviceId);
        }
      } else if (["denied", "expired", "error"].includes(status)) {
        state.error = data.payload.error || `Auth ${status}`;
        state.challengeId = null;
        state.authStream.close();
        updateCardUI(serviceId);
      }
    };

    state.authStream.addEventListener("snapshot", handlePayload);
    state.authStream.addEventListener("approved", handlePayload);
    state.authStream.addEventListener("active", handlePayload);
    state.authStream.addEventListener("denied", handlePayload);
    state.authStream.addEventListener("expired", handlePayload);
    state.authStream.addEventListener("error", handlePayload);
  }

  async function startLogin(serviceId) {
    const state = servicesState.get(serviceId);
    state.error = null;
    updateCardUI(serviceId);

    try {
      const result = await apiCall("POST", "/auth/start", { service_id: serviceId });
      if (result.status === "active" && result.profile) {
        state.profile = result.profile;
        bindSessionStream(serviceId);
      } else {
        state.challengeId = result.challenge_id;
        state.expiresAt = result.expires_at;
        bindAuthStream(serviceId, result.challenge_id);
      }
      updateCardUI(serviceId);
    } catch (err) {
      state.error = (err.code === "wallet_local_unreachable")
        ? "Wallet을 실행해주세요"
        : err.message;
      updateCardUI(serviceId);
    }
  }

  async function registerService(serviceId) {
    const state = servicesState.get(serviceId);
    try {
      await apiCall("POST", `/service/${encodeURIComponent(serviceId)}/register`, {});
      state.config.registered = true;
      updateCardUI(serviceId);
    } catch (err) {
      state.error = "Registration failed: " + err.message;
      updateCardUI(serviceId);
    }
  }

  async function logout(serviceId) {
    if (!serviceId) return;
    try {
      await apiCall("POST", "/logout", { service_id: serviceId });
      const state = servicesState.get(serviceId);
      if (state) {
        state.profile = null;
        if (state.sessionStream) state.sessionStream.close();
        updateCardUI(serviceId);
      }
    } catch (err) {
      console.error(`Logout failed for ${serviceId}`, err);
    }
  }

  function bindSessionStream(serviceId) {
    const state = servicesState.get(serviceId);
    if (!state) return;

    if (state.sessionStream) state.sessionStream.close();
    state.sessionStream = new EventSource(`${API_BASE}/session/stream?service_id=${encodeURIComponent(serviceId)}`);

    state.sessionStream.addEventListener("force_logout", (event) => {
      const data = JSON.parse(event.data);
      const targetId = data.payload?.service_id || serviceId;
      console.log(`[service-frontend] session revoked for service=${targetId}`);

      const targetState = servicesState.get(targetId);
      if (targetState && targetState.profile) {
        targetState.profile = null;
        if (targetState.sessionStream) targetState.sessionStream.close();
        updateCardUI(targetId);
      }
    });

    state.sessionStream.onerror = () => {
      // Auto reconnecting but we can log
    };
  }

  // --- Modal & UI Events ---

  function openManageModal(serviceId = null) {
    elements.manageError.classList.add("hidden");
    if (serviceId) {
      const config = servicesState.get(serviceId).config;
      elements.inputOriginalId.value = serviceId;
      elements.inputServiceId.value = config.service_id;
      elements.inputServiceName.value = config.service_name;
      elements.inputFields.value = (config.requested_claims || []).join(", ");
    } else {
      elements.inputOriginalId.value = "";
      elements.inputServiceId.value = "";
      elements.inputServiceName.value = "";
      elements.inputFields.value = "name, email, nickname";
    }
    elements.modalManage.classList.add("active");
  }

  async function saveConfig() {
    const originalId = elements.inputOriginalId.value;
    const body = {
      service_id: elements.inputServiceId.value.trim(),
      service_name: elements.inputServiceName.value.trim(),
      requested_fields: elements.inputFields.value.trim()
    };

    if (!body.service_id) return (elements.manageError.textContent = "Service ID required", elements.manageError.classList.remove("hidden"));

    try {
      await apiCall("POST", "/service/save", body);
      elements.modalManage.classList.remove("active");
      await loadServices();
    } catch (err) {
      elements.manageError.textContent = err.message;
      elements.manageError.classList.remove("hidden");
    }
  }

  // --- Event Delegation ---

  elements.servicesGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".service-card");
    if (!card) return;
    const serviceId = card.dataset.serviceId;

    if (e.target.closest(".btn-login")) startLogin(serviceId);
    if (e.target.closest(".btn-register")) registerService(serviceId);
    if (e.target.closest(".btn-setup")) openManageModal(serviceId);
    if (e.target.closest(".btn-logout")) logout(serviceId);
    if (e.target.closest(".btn-cancel")) {
      const state = servicesState.get(serviceId);
      if (state.authStream) state.authStream.close();
      state.challengeId = null;
      updateCardUI(serviceId);
    }
    if (e.target.closest(".btn-retry")) {
      const state = servicesState.get(serviceId);
      state.error = null;
      updateCardUI(serviceId);
    }
  });

  elements.btnAddService.addEventListener("click", () => openManageModal());
  elements.btnSaveManage.addEventListener("click", saveConfig);
  elements.btnCloseManage.addEventListener("click", () => elements.modalManage.classList.remove("active"));

  // --- Init ---

  async function init() {
    await loadServices();
    // Check sessions for all loaded services
    for (const serviceId of servicesState.keys()) {
      try {
        const profile = await apiCall("GET", `/profile?service_id=${encodeURIComponent(serviceId)}`);
        if (profile && profile.service_id === serviceId) {
          const state = servicesState.get(serviceId);
          if (state) {
            state.profile = profile;
            updateCardUI(serviceId);
            bindSessionStream(serviceId);
          }
        }
      } catch (err) {
        // No session for this service, ignore
      }
    }
  }

  init();

})();
