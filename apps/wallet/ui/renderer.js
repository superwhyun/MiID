const didsEl = document.getElementById("dids");
const addDidBtn = document.getElementById("addDidBtn");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const didLabelEl = document.getElementById("didLabel");

const challengeDrafts = new Map();
const policyCache = new Map();
const expandedDids = new Set();

let wallets = [];
let sessionsByDid = new Map();
let approvedByDid = new Map();

function setStatus(text) {
  statusEl.textContent = text || "";
}

function clearStatus() {
  statusEl.textContent = "";
}

function policyKey(did, serviceId) {
  return `${did}::${serviceId}`;
}

async function getPolicy(did, serviceId) {
  const key = policyKey(did, serviceId);
  if (policyCache.has(key)) {
    return policyCache.get(key);
  }
  try {
    const result = await window.miid.getClaimPolicy({ did, serviceId });
    const claims = Array.isArray(result?.claims) ? result.claims : [];
    policyCache.set(key, claims);
    return claims;
  } catch (_err) {
    policyCache.set(key, []);
    return [];
  }
}

function setPolicy(did, serviceId, claims) {
  const normalized = Array.isArray(claims)
    ? [...new Set(claims)].filter((v) => typeof v === "string")
    : [];
  policyCache.set(policyKey(did, serviceId), normalized);
  window.miid.setClaimPolicy({ did, serviceId, claims: normalized }).catch(() => {});
}

async function loadWalletsData() {
  const result = await window.miid.listWallets();
  wallets = Array.isArray(result?.wallets) ? result.wallets : [];
  didLabelEl.textContent = wallets.length > 0 ? `${wallets.length} DID(s)` : "No DID";
}

async function loadSessionsData() {
  const data = await window.miid.listSessions();
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  await Promise.all(sessions.map((s) => getPolicy(s.did, s.service_id)));

  const grouped = new Map();
  sessions.forEach((session) => {
    const did = session.did || "unknown";
    const list = grouped.get(did) || [];
    list.push(session);
    grouped.set(did, list);
  });
  sessionsByDid = grouped;
}

async function loadApprovedData() {
  const data = await window.miid.listApproved();
  const approved = Array.isArray(data?.approved) ? data.approved : [];
  const grouped = new Map();
  approved.forEach((item) => {
    const did = item.did || "unknown";
    const list = grouped.get(did) || [];
    list.push(item);
    grouped.set(did, list);
  });
  approvedByDid = grouped;
}

function createClaimChip(claim, active, onToggle) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `claim-chip${active ? " active" : ""}`;
  chip.textContent = claim;
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  chip.addEventListener("click", onToggle);
  return chip;
}

function createSessionCard(session) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${session.service_id}</strong>`;
  wrapper.appendChild(title);

  const requestedClaims = Array.isArray(session.requested_claims) ? session.requested_claims : [];
  const approvedClaims = Array.isArray(session.approved_claims) ? session.approved_claims : [];
  const policyClaims = policyCache.get(policyKey(session.did, session.service_id));
  const selected = new Set(Array.isArray(policyClaims) && policyClaims.length > 0 ? policyClaims : approvedClaims);

  const chips = document.createElement("div");
  chips.className = "claim-chip-group";
  requestedClaims.forEach((claim) => {
    const chip = createClaimChip(claim, selected.has(claim), () => {
      if (selected.has(claim)) {
        selected.delete(claim);
      } else {
        selected.add(claim);
      }
      chip.classList.toggle("active", selected.has(claim));
      chip.setAttribute("aria-pressed", selected.has(claim) ? "true" : "false");
      const claims = requestedClaims.filter((c) => selected.has(c));
      setPolicy(session.did, session.service_id, claims);
      clearStatus();
    });
    chips.appendChild(chip);
  });
  if (requestedClaims.length > 0) {
    wrapper.appendChild(chips);
  }

  const risk = document.createElement("div");
  risk.className = "meta";
  risk.textContent = `Risk: ${session.risk_level}`;
  wrapper.appendChild(risk);

  const exp = document.createElement("div");
  exp.className = "meta";
  exp.textContent = `Expires: ${session.expires_at}`;
  wrapper.appendChild(exp);

  const actions = document.createElement("div");
  actions.className = "actions";
  const revokeBtn = document.createElement("button");
  revokeBtn.className = "revoke";
  revokeBtn.textContent = "Revoke";
  revokeBtn.onclick = async () => {
    try {
      await window.miid.revokeSession({ sessionId: session.session_id, did: session.did });
      await loadSessionsData();
      await loadApprovedData();
      renderDids();
      clearStatus();
    } catch (err) {
      setStatus(`Revoke failed: ${err.message}`);
    }
  };
  actions.appendChild(revokeBtn);
  wrapper.appendChild(actions);

  return wrapper;
}

function createApprovedCard(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${item.service_id}</strong>`;
  wrapper.appendChild(title);

  const claims = Array.isArray(item.approved_claims) ? item.approved_claims : [];
  if (claims.length > 0) {
    const chips = document.createElement("div");
    chips.className = "claim-chip-group";
    claims.forEach((claim) => {
      const chip = document.createElement("span");
      chip.className = "claim-chip active";
      chip.textContent = claim;
      chips.appendChild(chip);
    });
    wrapper.appendChild(chips);
  }

  const exp = document.createElement("div");
  exp.className = "meta";
  exp.textContent = `Approved, waiting for service completion · Expires: ${item.expires_at}`;
  wrapper.appendChild(exp);
  return wrapper;
}

function createDidCard(wallet) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const header = document.createElement("div");
  header.className = "did-header";

  const left = document.createElement("div");
  left.className = "did-left";

  const didApproved = approvedByDid.get(wallet.did) || [];
  const didSessions = sessionsByDid.get(wallet.did) || [];
  const connectedServices = new Set();
  didApproved.forEach((item) => connectedServices.add(item.service_id));
  didSessions.forEach((item) => connectedServices.add(item.service_id));

  const countBadge = document.createElement("span");
  countBadge.className = "service-count";
  countBadge.textContent = String(connectedServices.size);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "did-toggle";
  toggleBtn.innerHTML = `<strong>${wallet.did}</strong>`;

  left.appendChild(countBadge);
  left.appendChild(toggleBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "icon-btn light";
  settingsBtn.title = "DID settings";
  settingsBtn.textContent = "⚙";

  header.appendChild(left);
  header.appendChild(settingsBtn);
  wrapper.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "meta";
  summary.textContent = `name=${wallet.name || "-"}, email=${wallet.email || "-"}, nickname=${wallet.nickname || "-"}`;
  wrapper.appendChild(summary);

  const form = document.createElement("div");
  form.className = "profile-grid hidden";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = wallet.name || "";
  nameLabel.appendChild(nameInput);

  const emailLabel = document.createElement("label");
  emailLabel.textContent = "Email";
  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.value = wallet.email || "";
  emailLabel.appendChild(emailInput);

  const nickLabel = document.createElement("label");
  nickLabel.textContent = "Nickname";
  const nickInput = document.createElement("input");
  nickInput.type = "text";
  nickInput.value = wallet.nickname || "";
  nickLabel.appendChild(nickInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "save";
  saveBtn.textContent = "Save Profile";
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await window.miid.updateProfile({
        did: wallet.did,
        profile: {
          name: nameInput.value || "",
          email: emailInput.value || "",
          nickname: nickInput.value || ""
        }
      });
      await loadWalletsData();
      renderDids();
      clearStatus();
    } catch (err) {
      setStatus(`Profile update failed: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  form.appendChild(nameLabel);
  form.appendChild(emailLabel);
  form.appendChild(nickLabel);
  form.appendChild(saveBtn);
  wrapper.appendChild(form);

  const sessionsPanel = document.createElement("div");
  sessionsPanel.className = "did-sessions";
  if (!expandedDids.has(wallet.did)) {
    sessionsPanel.classList.add("hidden");
  }

  if (didApproved.length > 0) {
    const approvedTitle = document.createElement("div");
    approvedTitle.className = "subhead";
    approvedTitle.textContent = "Approved (Waiting)";
    sessionsPanel.appendChild(approvedTitle);
    didApproved.forEach((item) => {
      sessionsPanel.appendChild(createApprovedCard(item));
    });
  }

  if (didSessions.length > 0) {
    const activeTitle = document.createElement("div");
    activeTitle.className = "subhead";
    activeTitle.textContent = "Active Sessions";
    sessionsPanel.appendChild(activeTitle);
    didSessions.forEach((session) => {
      sessionsPanel.appendChild(createSessionCard(session));
    });
  }

  wrapper.appendChild(sessionsPanel);

  toggleBtn.addEventListener("click", () => {
    if (expandedDids.has(wallet.did)) {
      expandedDids.delete(wallet.did);
    } else {
      expandedDids.add(wallet.did);
    }
    renderDids();
  });

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    form.classList.toggle("hidden");
  });

  return wrapper;
}

function renderDids() {
  didsEl.innerHTML = "";
  if (wallets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No DIDs yet.";
    didsEl.appendChild(empty);
    return;
  }
  wallets.forEach((wallet) => didsEl.appendChild(createDidCard(wallet)));
}

async function getChallengeDraft(challenge) {
  const current = challengeDrafts.get(challenge.challenge_id);
  if (current) {
    return current;
  }

  const availableDids = Array.isArray(challenge.available_dids) ? challenge.available_dids : [];
  const selectedDid = challenge.did_hint || availableDids[0] || wallets[0]?.did || null;
  const requestedClaims = Array.isArray(challenge.requested_claims) ? challenge.requested_claims : [];
  const policyClaims = selectedDid ? await getPolicy(selectedDid, challenge.service_id) : [];
  const selectedClaims = policyClaims.length > 0
    ? requestedClaims.filter((claim) => policyClaims.includes(claim))
    : [...requestedClaims];

  const draft = { did: selectedDid, claims: selectedClaims };
  challengeDrafts.set(challenge.challenge_id, draft);
  return draft;
}

async function createChallengeCard(challenge) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${challenge.service_id}</strong>`;
  wrapper.appendChild(title);

  const requestedClaims = Array.isArray(challenge.requested_claims) ? challenge.requested_claims : [];
  const availableDids = Array.isArray(challenge.available_dids) ? challenge.available_dids : [];
  const draft = await getChallengeDraft(challenge);

  const didRow = document.createElement("div");
  didRow.className = "meta";
  didRow.textContent = "Select DID:";
  wrapper.appendChild(didRow);

  const didSelect = document.createElement("select");
  didSelect.className = "did-select";
  availableDids.forEach((did) => {
    const option = document.createElement("option");
    option.value = did;
    option.textContent = did;
    if (did === draft.did) {
      option.selected = true;
    }
    didSelect.appendChild(option);
  });
  if (challenge.did_hint || availableDids.length <= 1) {
    didSelect.disabled = true;
  }
  wrapper.appendChild(didSelect);

  const claimTitle = document.createElement("div");
  claimTitle.className = "meta";
  claimTitle.textContent = "Claimed data:";
  wrapper.appendChild(claimTitle);

  const claimList = document.createElement("div");
  claimList.className = "claim-list";

  const applyClaims = (claims) => {
    Array.from(claimList.querySelectorAll("input[type=checkbox]")).forEach((input) => {
      input.checked = claims.includes(input.value);
    });
  };

  requestedClaims.forEach((claim) => {
    const row = document.createElement("label");
    row.className = "claim-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = claim;
    checkbox.checked = draft.claims.includes(claim);
    checkbox.addEventListener("change", () => {
      const selected = Array.from(claimList.querySelectorAll("input:checked")).map((el) => el.value);
      challengeDrafts.set(challenge.challenge_id, { did: didSelect.value, claims: selected });
    });
    row.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = claim;
    row.appendChild(text);
    claimList.appendChild(row);
  });
  wrapper.appendChild(claimList);

  didSelect.addEventListener("change", async () => {
    const nextDid = didSelect.value;
    const policyClaims = await getPolicy(nextDid, challenge.service_id);
    const selectedClaims = policyClaims.length > 0
      ? requestedClaims.filter((claim) => policyClaims.includes(claim))
      : [...requestedClaims];
    challengeDrafts.set(challenge.challenge_id, { did: nextDid, claims: selectedClaims });
    applyClaims(selectedClaims);
  });

  const exp = document.createElement("div");
  exp.className = "meta";
  exp.textContent = `Expires: ${challenge.expires_at}`;
  wrapper.appendChild(exp);

  const action = document.createElement("div");
  action.className = "actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "approve";
  approveBtn.textContent = "Approve";
  approveBtn.onclick = async () => {
    const selectedDid = didSelect.value;
    const approvedClaims = Array.from(claimList.querySelectorAll("input:checked")).map((el) => el.value);
    setPolicy(selectedDid, challenge.service_id, approvedClaims);
    try {
      await window.miid.approve({
        challengeId: challenge.challenge_id,
        did: selectedDid,
        approvedClaims
      });
      challengeDrafts.delete(challenge.challenge_id);
      await loadChallenges();
      await loadSessionsData();
      await loadApprovedData();
      renderDids();
      clearStatus();
    } catch (err) {
      setStatus(`Approve failed: ${err.message}`);
    }
  };

  const denyBtn = document.createElement("button");
  denyBtn.className = "deny";
  denyBtn.textContent = "Deny";
  denyBtn.onclick = async () => {
    const selectedDid = didSelect.value;
    try {
      await window.miid.deny({ challengeId: challenge.challenge_id, did: selectedDid });
      challengeDrafts.delete(challenge.challenge_id);
      await loadChallenges();
      clearStatus();
    } catch (err) {
      setStatus(`Deny failed: ${err.message}`);
    }
  };

  action.appendChild(approveBtn);
  action.appendChild(denyBtn);
  wrapper.appendChild(action);

  return wrapper;
}

async function loadChallenges() {
  try {
    const data = await window.miid.listChallenges();
    const challenges = Array.isArray(data?.challenges) ? data.challenges : [];
    const activeIds = new Set(challenges.map((c) => c.challenge_id));
    Array.from(challengeDrafts.keys()).forEach((challengeId) => {
      if (!activeIds.has(challengeId)) {
        challengeDrafts.delete(challengeId);
      }
    });

    listEl.innerHTML = "";
    if (challenges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No pending approval requests.";
      listEl.appendChild(empty);
      return;
    }

    for (const challenge of challenges) {
      const card = await createChallengeCard(challenge);
      listEl.appendChild(card);
    }
  } catch (err) {
    setStatus(`Pending load failed: ${err.message}`);
  }
}

async function addDid() {
  addDidBtn.disabled = true;
  try {
    await window.miid.createWallet({ name: "user" });
    await loadWalletsData();
    await loadSessionsData();
    await loadApprovedData();
    renderDids();
    await loadChallenges();
    clearStatus();
  } catch (err) {
    setStatus(`Create DID failed: ${err.message}`);
  } finally {
    addDidBtn.disabled = false;
  }
}

async function refreshAll() {
  await loadWalletsData();
  await loadSessionsData();
  await loadApprovedData();
  renderDids();
  await loadChallenges();
}

async function boot() {
  await refreshAll();
  clearStatus();

  window.miid.onChallengeEvent(async () => {
    await refreshAll();
  });
}

addDidBtn.addEventListener("click", addDid);
boot();
