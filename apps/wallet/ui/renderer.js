const didsEl = document.getElementById("dids");
const addDidBtn = document.getElementById("addDidBtn");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const didLabelEl = document.getElementById("didLabel");
const pendingCountEl = document.getElementById("pendingCount");
const identityCountEl = document.getElementById("identityCount");

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

function shortenDid(did) {
  if (!did || typeof did !== "string") return "-";
  if (did.length <= 20) return did;
  return did.slice(0, 12) + "..." + did.slice(-8);
}

function getInitials(name) {
  if (!name) return "?";
  return name.slice(0, 2).toUpperCase();
}

async function loadWalletsData() {
  const result = await window.miid.listWallets();
  wallets = Array.isArray(result?.wallets) ? result.wallets : [];
  
  if (wallets.length > 0) {
    didLabelEl.textContent = `${wallets.length}개의 아이덴티티`;
    identityCountEl.textContent = wallets.length;
    identityCountEl.classList.remove("hidden");
  } else {
    didLabelEl.textContent = "새로운 아이덴티티를 만들어보세요";
    identityCountEl.classList.add("hidden");
  }
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
  wrapper.className = "session-card";

  const header = document.createElement("div");
  header.className = "card-header";
  
  const title = document.createElement("div");
  title.className = "service-name";
  title.textContent = session.service_id;
  header.appendChild(title);
  wrapper.appendChild(header);

  const requestedClaims = Array.isArray(session.requested_claims) ? session.requested_claims : [];
  const approvedClaims = Array.isArray(session.approved_claims) ? session.approved_claims : [];
  const policyClaims = policyCache.get(policyKey(session.did, session.service_id));
  const selected = new Set(Array.isArray(policyClaims) && policyClaims.length > 0 ? policyClaims : approvedClaims);

  const claimsSection = document.createElement("div");
  claimsSection.className = "claims-section";
  
  const chips = document.createElement("div");
  chips.className = "claim-chips";
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
    claimsSection.appendChild(chips);
  }
  wrapper.appendChild(claimsSection);

  const meta = document.createElement("div");
  meta.className = "meta";
  
  // 위험도 표시
  const riskLevel = session.risk_level || "medium";
  const riskClass = riskLevel === "high" ? "risk-high" : riskLevel === "low" ? "risk-low" : "risk-medium";
  const riskText = riskLevel === "high" ? "높음" : riskLevel === "low" ? "낮음" : "중간";
  
  meta.innerHTML = `
    <span class="meta-item">
      <span class="risk-badge ${riskClass}">보안 ${riskText}</span>
    </span>
    <span class="meta-item">⏰ ${session.expires_at || "만료 정보 없음"}까지</span>
  `;
  wrapper.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  const revokeBtn = document.createElement("button");
  revokeBtn.className = "btn btn-secondary";
  revokeBtn.innerHTML = "🔗 연결 해제";
  revokeBtn.onclick = async () => {
    try {
      await window.miid.revokeSession({ sessionId: session.session_id, did: session.did });
      await loadSessionsData();
      await loadApprovedData();
      renderDids();
      clearStatus();
    } catch (err) {
      setStatus(`연결 해제 실패: ${err.message}`);
    }
  };
  actions.appendChild(revokeBtn);
  wrapper.appendChild(actions);

  return wrapper;
}

function createApprovedCard(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "session-card";

  const header = document.createElement("div");
  header.className = "card-header";
  
  const title = document.createElement("div");
  title.className = "service-name";
  title.textContent = item.service_id;
  header.appendChild(title);
  wrapper.appendChild(header);

  const claims = Array.isArray(item.approved_claims) ? item.approved_claims : [];
  if (claims.length > 0) {
    const claimsSection = document.createElement("div");
    claimsSection.className = "claims-section";
    const chips = document.createElement("div");
    chips.className = "claim-chips";
    claims.forEach((claim) => {
      const chip = document.createElement("span");
      chip.className = "claim-chip active";
      chip.textContent = claim;
      chips.appendChild(chip);
    });
    claimsSection.appendChild(chips);
    wrapper.appendChild(claimsSection);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span class="meta-item">⏳ 승인 완료 · ⏰ ${item.expires_at || "만료 정보 없음"}까지</span>`;
  wrapper.appendChild(meta);
  return wrapper;
}

function createDidCard(wallet) {
  const wrapper = document.createElement("div");
  wrapper.className = `card did-card${expandedDids.has(wallet.did) ? " expanded" : ""}`;

  const header = document.createElement("div");
  header.className = "did-header";

  const info = document.createElement("div");
  info.className = "did-info";

  const didApproved = approvedByDid.get(wallet.did) || [];
  const didSessions = sessionsByDid.get(wallet.did) || [];
  const connectedServices = new Set();
  didApproved.forEach((item) => connectedServices.add(item.service_id));
  didSessions.forEach((item) => connectedServices.add(item.service_id));

  // 아바타 (닉네임 이니셜 또는 이름)
  const displayName = wallet.nickname || wallet.name || "나";
  const avatar = document.createElement("div");
  avatar.className = "did-avatar";
  avatar.textContent = getInitials(displayName);

  const details = document.createElement("div");
  details.className = "did-details";

  const nameEl = document.createElement("div");
  nameEl.className = "did-name";
  nameEl.textContent = displayName;

  const addressEl = document.createElement("div");
  addressEl.className = "did-address";
  addressEl.textContent = shortenDid(wallet.did);
  addressEl.title = wallet.did; // 툴팁에 전체 주소

  details.appendChild(nameEl);
  details.appendChild(addressEl);

  info.appendChild(avatar);
  info.appendChild(details);

  const stats = document.createElement("div");
  stats.className = "did-stats";

  const serviceCount = connectedServices.size;
  if (serviceCount > 0) {
    const statBadge = document.createElement("span");
    statBadge.className = "stat-badge active";
    statBadge.innerHTML = `🔗 ${serviceCount}`;
    stats.appendChild(statBadge);
  }

  // 설정 버튼
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "settings-btn";
  settingsBtn.innerHTML = "⚙️";
  settingsBtn.title = "프로필 편집";
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    const form = document.getElementById(`profile-${wallet.did}`);
    form.classList.toggle("hidden");
  };
  stats.appendChild(settingsBtn);

  const expandIcon = document.createElement("span");
  expandIcon.className = "did-expand-icon";
  expandIcon.textContent = "▼";
  stats.appendChild(expandIcon);

  header.appendChild(info);
  header.appendChild(stats);
  wrapper.appendChild(header);

  // 프로필 편집 영역 (설정 버튼으로 토글)
  const form = document.createElement("div");
  form.className = "did-profile hidden";
  form.id = `profile-${wallet.did}`;

  const profileGrid = document.createElement("div");
  profileGrid.className = "profile-grid";

  const nameField = document.createElement("div");
  nameField.className = "profile-field";
  nameField.innerHTML = `
    <label>이름</label>
    <input type="text" id="name-${wallet.did}" value="${wallet.name || ""}" placeholder="이름을 입력하세요">
  `;

  const emailField = document.createElement("div");
  emailField.className = "profile-field";
  emailField.innerHTML = `
    <label>이메일</label>
    <input type="email" id="email-${wallet.did}" value="${wallet.email || ""}" placeholder="이메일을 입력하세요">
  `;

  const nickField = document.createElement("div");
  nickField.className = "profile-field";
  nickField.innerHTML = `
    <label>닉네임</label>
    <input type="text" id="nick-${wallet.did}" value="${wallet.nickname || ""}" placeholder="닉네임을 입력하세요">
  `;

  profileGrid.appendChild(nameField);
  profileGrid.appendChild(emailField);
  profileGrid.appendChild(nickField);
  form.appendChild(profileGrid);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.innerHTML = "💾 프로필 저장";
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await window.miid.updateProfile({
        did: wallet.did,
        profile: {
          name: document.getElementById(`name-${wallet.did}`).value || "",
          email: document.getElementById(`email-${wallet.did}`).value || "",
          nickname: document.getElementById(`nick-${wallet.did}`).value || ""
        }
      });
      await loadWalletsData();
      renderDids();
      clearStatus();
    } catch (err) {
      setStatus(`프로필 저장 실패: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  });
  form.appendChild(saveBtn);
  wrapper.appendChild(form);

  // 세션 목록
  const sessionsPanel = document.createElement("div");
  sessionsPanel.className = "did-sessions";

  if (didApproved.length > 0) {
    const approvedGroup = document.createElement("div");
    approvedGroup.className = "session-group";
    const approvedTitle = document.createElement("div");
    approvedTitle.className = "session-group-title";
    approvedTitle.innerHTML = "⏳ 승인 대기 중";
    approvedGroup.appendChild(approvedTitle);
    didApproved.forEach((item) => {
      approvedGroup.appendChild(createApprovedCard(item));
    });
    sessionsPanel.appendChild(approvedGroup);
  }

  if (didSessions.length > 0) {
    const activeGroup = document.createElement("div");
    activeGroup.className = "session-group";
    const activeTitle = document.createElement("div");
    activeTitle.className = "session-group-title";
    activeTitle.innerHTML = "✅ 연결된 서비스";
    activeGroup.appendChild(activeTitle);
    didSessions.forEach((session) => {
      activeGroup.appendChild(createSessionCard(session));
    });
    sessionsPanel.appendChild(activeGroup);
  }

  // 연결된 서비스가 없을 때
  if (didApproved.length === 0 && didSessions.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "empty-state";
    emptyMsg.style.padding = "20px";
    emptyMsg.innerHTML = `
      <div class="empty-state-text">아직 연결된 서비스가 없어요</div>
      <div class="empty-state-hint">새로운 요청이 오면 여기에 표시됩니다</div>
    `;
    sessionsPanel.appendChild(emptyMsg);
  }

  wrapper.appendChild(sessionsPanel);

  // 클릭으로 확장/축소
  header.addEventListener("click", () => {
    if (expandedDids.has(wallet.did)) {
      expandedDids.delete(wallet.did);
    } else {
      expandedDids.add(wallet.did);
    }
    renderDids();
  });

  return wrapper;
}

function renderDids() {
  didsEl.innerHTML = "";
  if (wallets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-state-icon">👤</div>
      <div class="empty-state-text">아이덴티티가 없어요</div>
      <div class="empty-state-hint">우측 상단의 + 버튼을 눌러 새로 만들어보세요</div>
    `;
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

  const header = document.createElement("div");
  header.className = "card-header";
  
  const title = document.createElement("div");
  title.className = "service-name";
  title.textContent = challenge.service_id;
  header.appendChild(title);
  wrapper.appendChild(header);

  const requestedClaims = Array.isArray(challenge.requested_claims) ? challenge.requested_claims : [];
  const availableDids = Array.isArray(challenge.available_dids) ? challenge.available_dids : [];
  const draft = await getChallengeDraft(challenge);

  // DID 선택
  const didLabel = document.createElement("div");
  didLabel.className = "claims-label";
  didLabel.textContent = "아이덴티티 선택";
  wrapper.appendChild(didLabel);

  const didSelect = document.createElement("select");
  didSelect.className = "did-select";
  availableDids.forEach((did) => {
    const option = document.createElement("option");
    option.value = did;
    option.textContent = shortenDid(did);
    option.title = did;
    if (did === draft.did) {
      option.selected = true;
    }
    didSelect.appendChild(option);
  });
  if (challenge.did_hint || availableDids.length <= 1) {
    didSelect.disabled = true;
  }
  wrapper.appendChild(didSelect);

  // Claims 선택
  const claimLabel = document.createElement("div");
  claimLabel.className = "claims-label";
  claimLabel.textContent = "공유할 정보";
  claimLabel.style.marginTop = "12px";
  wrapper.appendChild(claimLabel);

  const claimList = document.createElement("div");
  claimList.className = "checkbox-list";

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

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span class="meta-item">⏰ ${challenge.expires_at || "만료 정보 없음"}까지</span>`;
  wrapper.appendChild(meta);

  const action = document.createElement("div");
  action.className = "actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn btn-primary";
  approveBtn.innerHTML = "✓ 승인";
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
      setStatus(`승인 실패: ${err.message}`);
    }
  };

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn btn-secondary";
  denyBtn.innerHTML = "✕ 거절";
  denyBtn.onclick = async () => {
    const selectedDid = didSelect.value;
    try {
      await window.miid.deny({ challengeId: challenge.challenge_id, did: selectedDid });
      challengeDrafts.delete(challenge.challenge_id);
      await loadChallenges();
      clearStatus();
    } catch (err) {
      setStatus(`거절 실패: ${err.message}`);
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

    // 배지 업데이트
    if (challenges.length > 0) {
      pendingCountEl.textContent = challenges.length;
      pendingCountEl.classList.remove("hidden");
    } else {
      pendingCountEl.classList.add("hidden");
    }

    listEl.innerHTML = "";
    if (challenges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">새로운 요청이 없어요</div>
        <div class="empty-state-hint">서비스에서 로그인을 요청하면 여기에 표시됩니다</div>
      `;
      listEl.appendChild(empty);
      return;
    }

    for (const challenge of challenges) {
      const card = await createChallengeCard(challenge);
      listEl.appendChild(card);
    }
  } catch (err) {
    setStatus(`요청 로딩 실패: ${err.message}`);
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
    setStatus(`아이덴티티 생성 실패: ${err.message}`);
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
