(function() {
  "use strict";

  const API_BASE = "/api";
  let currentChallengeId = null;
  let authStream = null;

  const screens = {
    login: document.getElementById("screen-login"),
    waiting: document.getElementById("screen-waiting"),
    success: document.getElementById("screen-success"),
    error: document.getElementById("screen-error")
  };

  const elements = {
    btnLogin: document.getElementById("btn-login"),
    btnCancel: document.getElementById("btn-cancel"),
    btnLogout: document.getElementById("btn-logout"),
    btnRetry: document.getElementById("btn-retry"),
    loginError: document.getElementById("login-error"),
    challengeId: document.getElementById("challenge-id"),
    challengeStatus: document.getElementById("challenge-status"),
    challengeExpires: document.getElementById("challenge-expires"),
    progressFill: document.getElementById("progress-fill"),
    errorMessage: document.getElementById("error-message"),
    profileSubject: document.getElementById("profile-subject"),
    profileDid: document.getElementById("profile-did"),
    profileService: document.getElementById("profile-service"),
    profileScope: document.getElementById("profile-scope"),
    profileRisk: document.getElementById("profile-risk")
  };

  function showScreen(screenName) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[screenName].classList.add("active");
  }

  function setLoading(button, loading) {
    const textEl = button.querySelector(".btn-text");
    const loadingEl = button.querySelector(".btn-loading");
    if (loading) {
      button.disabled = true;
      if (textEl) textEl.classList.add("hidden");
      if (loadingEl) loadingEl.classList.remove("hidden");
    } else {
      button.disabled = false;
      if (textEl) textEl.classList.remove("hidden");
      if (loadingEl) loadingEl.classList.add("hidden");
    }
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.remove("hidden");
  }

  function hideError(element) {
    element.classList.add("hidden");
  }

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
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || "Request failed");
    return data;
  }

  async function completeLogin(challengeId) {
    const result = await apiCall("POST", `/auth/complete/${challengeId}`, {});
    return result.profile;
  }

  function updateWaitingStatus(status) {
    elements.challengeStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    elements.challengeStatus.className = `value status-${status}`;
  }

  function bindAuthStream(challengeId) {
    if (authStream) {
      authStream.close();
      authStream = null;
    }
    authStream = new EventSource(`${API_BASE}/auth/stream/${encodeURIComponent(challengeId)}`);

    const handlePayload = async (event) => {
      const data = JSON.parse(event.data);
      const status = data.payload.status;
      updateWaitingStatus(status);

      if (status === "approved") {
        // wait for backend finalize
        return;
      }
      if (status === "active") {
        try {
          const profile = await completeLogin(challengeId);
          elements.profileSubject.textContent = truncateId(profile.subject_id);
          elements.profileDid.textContent = profile.did;
          elements.profileService.textContent = profile.service_id;
          elements.profileScope.textContent = profile.scope || "profile email";
          elements.profileRisk.textContent = profile.risk_level || "normal";
          showScreen("success");
        } catch (err) {
          elements.errorMessage.textContent = `Complete login failed: ${err.message}`;
          showScreen("error");
        }
        authStream.close();
      } else if (status === "denied") {
        elements.errorMessage.textContent = "로그인 요청이 Wallet에서 거부되었습니다.";
        showScreen("error");
        authStream.close();
      } else if (status === "expired") {
        elements.errorMessage.textContent = "로그인 요청이 만료되었습니다. 다시 시도해주세요.";
        showScreen("error");
        authStream.close();
      } else if (status === "error") {
        elements.errorMessage.textContent = data.payload.error || "인증 처리 중 오류가 발생했습니다.";
        showScreen("error");
        authStream.close();
      }
    };

    authStream.addEventListener("snapshot", handlePayload);
    authStream.addEventListener("approved", handlePayload);
    authStream.addEventListener("active", handlePayload);
    authStream.addEventListener("denied", handlePayload);
    authStream.addEventListener("expired", handlePayload);
    authStream.addEventListener("error", handlePayload);
  }

  async function startLogin() {
    hideError(elements.loginError);
    setLoading(elements.btnLogin, true);

    try {
      const result = await apiCall("POST", "/auth/start", {});
      currentChallengeId = result.challenge_id;
      elements.challengeId.textContent = truncateId(result.challenge_id);
      elements.challengeExpires.textContent = formatTime(result.expires_at);
      elements.progressFill.style.width = "100%";
      updateWaitingStatus("pending");
      showScreen("waiting");
      bindAuthStream(result.challenge_id);
    } catch (err) {
      showError(elements.loginError, err.message);
    } finally {
      setLoading(elements.btnLogin, false);
    }
  }

  function cancelLogin() {
    if (authStream) {
      authStream.close();
      authStream = null;
    }
    currentChallengeId = null;
    showScreen("login");
  }

  async function logout() {
    try {
      await apiCall("POST", "/logout", {});
    } catch (_err) {
      // ignore
    }
    currentChallengeId = null;
    if (authStream) {
      authStream.close();
      authStream = null;
    }
    showScreen("login");
  }

  function retry() {
    currentChallengeId = null;
    if (authStream) {
      authStream.close();
      authStream = null;
    }
    showScreen("login");
  }

  async function checkSession() {
    try {
      const profile = await apiCall("GET", "/profile");
      elements.profileSubject.textContent = truncateId(profile.subject_id);
      elements.profileDid.textContent = profile.did;
      elements.profileService.textContent = profile.service_id;
      elements.profileScope.textContent = profile.scope || "profile email";
      elements.profileRisk.textContent = profile.risk_level || "normal";
      showScreen("success");
    } catch (_err) {
      showScreen("login");
    }
  }

  elements.btnLogin.addEventListener("click", startLogin);
  elements.btnCancel.addEventListener("click", cancelLogin);
  elements.btnLogout.addEventListener("click", logout);
  elements.btnRetry.addEventListener("click", retry);

  checkSession();
})();
