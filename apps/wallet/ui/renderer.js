const didsEl = document.getElementById("dids");
const addDidBtn = document.getElementById("addDidBtn");
const listEl = document.getElementById("list");
const pendingSectionEl = document.getElementById("pendingSection");
const statusEl = document.getElementById("status");
const didLabelEl = document.getElementById("didLabel");
const pendingCountEl = document.getElementById("pendingCount");
const identityCountEl = document.getElementById("identityCount");
const identityServiceSearchEl = document.getElementById("identityServiceSearch");
const profileModal = document.getElementById("profileModal");
const profileModalBody = document.getElementById("profileModalBody");
const deleteModal = document.getElementById("deleteModal");
const deleteDidNameEl = document.getElementById("deleteDidName");

const challengeDrafts = new Map();
const policyCache = new Map();
const expandedDids = new Set();

let wallets = [];
let activeServicesByDid = new Map();
let approvedByDid = new Map();
let profileFields = [];
let currentEditingDid = null;
let currentDeletingDid = null;
let identityServiceKeyword = "";

// 설정 파일 로드 (샘플 필드 정의용으로만 사용)
async function loadProfileFields() {
  try {
    const result = await window.miid.getProfileFields();
    profileFields = Array.isArray(result) ? result : [];
  } catch (err) {
    profileFields = [
      { label: "이름", key: "name", type: "text", placeholder: "실명을 입력하세요" },
      { label: "닉네임", key: "nickname", type: "text", placeholder: "표시될 이름" },
      { label: "이메일", key: "email", type: "email", placeholder: "email@example.com" }
    ];
  }
}

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
  window.miid.setClaimPolicy({ did, serviceId, claims: normalized }).catch(() => { });
}

// 기존 활성 서비스에서 해당 서비스에 대해 승인된 claims 조회
async function getExistingApprovedClaims(serviceId, did) {
  if (!did) return [];
  try {
    const activeServices = activeServicesByDid.get(did) || [];
    const matchingActiveService = activeServices.find((s) => s.service_id === serviceId && !s.revoked_at);
    return matchingActiveService?.approved_claims || [];
  } catch (_err) {
    return [];
  }
}

function shortenDid(did) {
  if (!did || typeof did !== "string") return "-";
  if (did.length <= 20) return did;
  return did.slice(0, 12) + "..." + did.slice(-8);
}

function getInitials(name) {
  if (!name || typeof name !== "string") return "?";
  return name.slice(0, 2).toUpperCase();
}

function createServiceNameNode(serviceName, serviceId) {
  const el = document.createElement("div");
  el.className = "service-name";

  const primary = document.createElement("span");
  primary.textContent = serviceName || serviceId || "-";
  el.appendChild(primary);

  if (serviceName && serviceId && serviceName !== serviceId) {
    const secondary = document.createElement("span");
    secondary.className = "service-name-id";
    secondary.textContent = `(${serviceId})`;
    el.appendChild(secondary);
  }
  return el;
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

async function loadActiveServicesData() {
  const data = await window.miid.listActiveServices();
  const activeServices = Array.isArray(data?.active_services) ? data.active_services : [];
  await Promise.all(activeServices.map((s) => getPolicy(s.did, s.service_id)));

  const grouped = new Map();
  activeServices.forEach((activeService) => {
    const did = activeService.did || "unknown";
    const list = grouped.get(did) || [];
    list.push(activeService);
    grouped.set(did, list);
  });
  activeServicesByDid = grouped;
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

// Claim 헬퍼
function getWalletClaimValue(wallet, claim) {
  if (!wallet) return null;
  const profile = wallet.profile || {};
  return profile[claim]?.value || null;
}

function getClaimLabel(claim) {
  const wallet = wallets.find(w => currentEditingDid === w.did);
  if (wallet?.profile?.[claim]) {
    return wallet.profile[claim].label || claim;
  }
  const field = profileFields.find(f => f.key === claim);
  return field ? field.label : claim;
}

// ==================== 모달 함수 ====================

function openProfileModal(did) {
  currentEditingDid = did;
  const wallet = wallets.find(w => w.did === did);
  if (!wallet) return;

  profileModalBody.innerHTML = "";

  // ===== 통합 프로필 섹션 =====
  const profileSection = document.createElement("div");
  profileSection.style.marginBottom = "24px";

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;";

  const title = document.createElement("div");
  title.style.cssText = "font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;";
  title.textContent = "프로필 정보";

  const addBtn = document.createElement("button");
  addBtn.innerHTML = "+ 필드 추가";
  addBtn.style.cssText = "background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border: none; border-radius: 8px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer;";
  addBtn.onclick = () => addProfileFieldRow();

  headerRow.appendChild(title);
  headerRow.appendChild(addBtn);
  profileSection.appendChild(headerRow);

  // 테이블 헤더
  const tableHeader = document.createElement("div");
  tableHeader.style.cssText = "display: grid; grid-template-columns: 1fr 1fr 1.5fr auto; gap: 8px; padding: 8px; font-size: 11px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0; margin-bottom: 8px;";
  tableHeader.innerHTML = `<span>표시 이름</span><span>Claim 키</span><span>값</span><span></span>`;
  profileSection.appendChild(tableHeader);

  const fieldsContainer = document.createElement("div");
  fieldsContainer.id = "profileFieldsContainer";
  profileSection.appendChild(fieldsContainer);

  // 통합 프로필 데이터 로드
  const profile = wallet.profile || {};
  const profileKeys = Object.keys(profile);

  // 기본 필드(profileFields.json)는 프로필이 완전히 비어있는 경우(신규)에만 가이드로 보여줌
  // 그 외의 경우(이미 데이터가 있는 경우)에는 저장된 필드만 보여주어 삭제가 유지되도록 함
  if (profileKeys.length === 0) {
    profileFields.forEach(f => {
      addProfileFieldRow(f.label, f.key, "", fieldsContainer);
    });
  } else {
    // 저장된 필드들만 표시 (사용자가 삭제한 기본 필드는 다시 나타나지 않음)
    Object.entries(profile).forEach(([key, data]) => {
      addProfileFieldRow(data.label || key, key, data.value || "", fieldsContainer);
    });
  }

  profileModalBody.appendChild(profileSection);

  // ===== 위험 구역 =====
  const dangerZone = document.createElement("div");
  dangerZone.className = "danger-zone";
  dangerZone.innerHTML = `
    <div class="danger-title">🗑️ 위험 구역</div>
    <div class="danger-hint">이 아이덴티티를 삭제하면 모든 연결이 끊어지며 복구할 수 없습니다.</div>
  `;

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-danger";
  deleteBtn.style.width = "100%";
  deleteBtn.innerHTML = "🗑️ 아이덴티티 삭제";
  deleteBtn.onclick = () => {
    closeProfileModal();
    openDeleteModal(did);
  };

  dangerZone.appendChild(deleteBtn);
  profileModalBody.appendChild(dangerZone);

  profileModal.classList.add("active");
}

function addProfileFieldRow(label = "", key = "", value = "", targetContainer = null) {
  const container = targetContainer || document.getElementById("profileFieldsContainer");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "profile-field-row";
  row.style.cssText = "display: grid; grid-template-columns: 1fr 1fr 1.5fr auto; gap: 8px; align-items: center; padding: 6px 8px; margin-bottom: 4px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;";

  // 표시 이름
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "field-label-input";
  labelInput.value = label;
  labelInput.placeholder = "표시이름";
  labelInput.style.cssText = "border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; font-size: 13px; background: white; box-sizing: border-box; width: 100%;";

  // Claim 키
  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "field-key-input";
  keyInput.value = key;
  keyInput.placeholder = "claim_key";
  keyInput.style.cssText = "border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: monospace; background: white; box-sizing: border-box; width: 100%;";

  // 값
  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "field-value-input";
  valueInput.value = value;
  valueInput.placeholder = "값 입력";
  valueInput.style.cssText = "border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; font-size: 13px; background: white; box-sizing: border-box; width: 100%;";

  // 삭제 버튼
  const btnCell = document.createElement("div");
  btnCell.style.cssText = "display: flex; justify-content: center;";
  const deleteBtn = document.createElement("button");
  deleteBtn.innerHTML = "🗑️";
  deleteBtn.style.cssText = "background: none; border: none; cursor: pointer; font-size: 14px; padding: 4px;";
  deleteBtn.onclick = () => row.remove();
  btnCell.appendChild(deleteBtn);

  // 자동 키 생성
  labelInput.addEventListener("blur", () => {
    if (labelInput.value && !keyInput.value) {
      keyInput.value = generateFieldKey(labelInput.value);
    }
  });

  row.appendChild(labelInput);
  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(btnCell);
  container.appendChild(row);
}

function closeProfileModal() {
  profileModal.classList.remove("active");
  currentEditingDid = null;
}

async function saveProfile() {
  if (!currentEditingDid) return;

  const btn = document.getElementById("saveProfileBtn");
  btn.disabled = true;

  try {
    const profile = {};
    const container = document.getElementById("profileFieldsContainer");
    if (container) {
      container.querySelectorAll(".profile-field-row").forEach((row) => {
        const labelInput = row.querySelector(".field-label-input");
        const keyInput = row.querySelector(".field-key-input");
        const valueInput = row.querySelector(".field-value-input");

        const label = labelInput?.value?.trim();
        const key = keyInput?.value?.trim();
        const value = valueInput?.value?.trim();

        if (key && label) {
          profile[key] = { label, value: value || "" };
        }
      });
    }

    await window.miid.updateProfile({
      did: currentEditingDid,
      profile
    });

    btn.innerHTML = "✅ 저장됨";
    setTimeout(() => {
      btn.innerHTML = "💾 저장";
    }, 2000);

    await loadWalletsData();
    renderDids();
    closeProfileModal();
    clearStatus();
  } catch (err) {
    setStatus(`프로필 저장 실패: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ==================== 삭제 모달 ====================

function openDeleteModal(did) {
  currentDeletingDid = did;
  const wallet = wallets.find(w => w.did === did);
  const profile = wallet?.profile || {};
  const displayName = profile.nickname?.value || profile.name?.value || shortenDid(did);
  deleteDidNameEl.textContent = displayName;
  deleteModal.classList.add("active");
}

function closeDeleteModal() {
  deleteModal.classList.remove("active");
  currentDeletingDid = null;
}

async function confirmDeleteDid() {
  if (!currentDeletingDid) return;

  const btn = document.getElementById("confirmDeleteBtn");
  btn.disabled = true;

  try {
    await window.miid.deleteWallet({ did: currentDeletingDid });
    expandedDids.delete(currentDeletingDid);

    await loadWalletsData();
    await loadActiveServicesData();
    await loadApprovedData();
    renderDids();
    closeDeleteModal();
    clearStatus();
  } catch (err) {
    setStatus(`삭제 실패: ${err.message}`);
    closeDeleteModal();
  } finally {
    btn.disabled = false;
  }
}

// ==================== UI 생성 함수 ====================

function createClaimChip(claim, active, onToggle) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `claim-chip${active ? " active" : ""}`;
  chip.textContent = claim;
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  chip.addEventListener("click", onToggle);
  return chip;
}

function createActiveServiceCard(activeService) {
  const wrapper = document.createElement("div");
  wrapper.className = "service-card";

  const header = document.createElement("div");
  header.className = "card-header";

  const title = createServiceNameNode(activeService.service_name, activeService.service_id);
  header.appendChild(title);
  wrapper.appendChild(header);

  const requestedClaims = Array.isArray(activeService.requested_claims) ? activeService.requested_claims : [];
  const approvedClaims = Array.isArray(activeService.approved_claims) ? activeService.approved_claims : [];
  const policyClaims = policyCache.get(policyKey(activeService.did, activeService.service_id));
  const selected = new Set(Array.isArray(policyClaims) && policyClaims.length > 0 ? policyClaims : approvedClaims);

  const claimsSection = document.createElement("div");
  claimsSection.className = "claims-section";

  const chips = document.createElement("div");
  chips.className = "claim-chips";
  requestedClaims.forEach((claim) => {
    const chip = createClaimChip(claim, selected.has(claim), () => {
      if (selected.has(claim)) selected.delete(claim);
      else selected.add(claim);
      chip.classList.toggle("active", selected.has(claim));
      chip.setAttribute("aria-pressed", selected.has(claim) ? "true" : "false");
      setPolicy(activeService.did, activeService.service_id, requestedClaims.filter((c) => selected.has(c)));
      clearStatus();
    });
    chips.appendChild(chip);
  });

  if (requestedClaims.length > 0) claimsSection.appendChild(chips);
  wrapper.appendChild(claimsSection);

  const meta = document.createElement("div");
  meta.className = "meta";
  const riskLevel = activeService.risk_level || "medium";
  const riskClass = riskLevel === "high" ? "risk-high" : riskLevel === "low" ? "risk-low" : "risk-medium";
  const riskText = riskLevel === "high" ? "높음" : riskLevel === "low" ? "낮음" : "중간";

  meta.innerHTML = `
    <span class="meta-item">✅ 활성 서비스</span>
    <span class="meta-item"><span class="risk-badge ${riskClass}">보안 ${riskText}</span></span>
    <span class="meta-item">⏰ ${activeService.expires_at || "만료 정보 없음"}까지</span>
  `;
  wrapper.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  const revokeBtn = document.createElement("button");
  revokeBtn.className = "btn btn-secondary";
  revokeBtn.innerHTML = "🔗 연결 해제";
  revokeBtn.onclick = async () => {
    try {
      const payload = {
        activeServiceId: activeService.active_service_id || activeService.session_id,
        serviceId: activeService.service_id,
        did: activeService.did
      };
      if (typeof window.miid.disconnectActiveService === "function") {
        await window.miid.disconnectActiveService(payload);
      } else if (typeof window.miid.revokeSession === "function") {
        await window.miid.revokeSession(payload);
      } else {
        throw new Error("disconnect_api_not_available");
      }
      await loadActiveServicesData();
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
  wrapper.className = "service-card";

  const header = document.createElement("div");
  header.className = "card-header";

  const title = createServiceNameNode(item.service_name, item.service_id);
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
  meta.innerHTML = `<span class="meta-item">✅ 승인 완료 · 교환 대기 · ⏰ ${item.expires_at || "만료 정보 없음"}까지</span>`;
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
  const didActiveServices = activeServicesByDid.get(wallet.did) || [];
  const connectedServices = new Set();
  didApproved.forEach((item) => connectedServices.add(item.service_id));
  didActiveServices.forEach((item) => connectedServices.add(item.service_id));
  if (identityServiceKeyword) {
    const keyword = identityServiceKeyword.toLowerCase();
    const matched = [...didApproved, ...didActiveServices].some((item) => {
      const serviceName = typeof item?.service_name === "string" && item.service_name.trim().length > 0
        ? item.service_name
        : item?.service_id;
      return typeof serviceName === "string" && serviceName.toLowerCase().includes(keyword);
    });
    if (!matched) {
      return null;
    }
  }

  // Unified Profile에서 이름/닉네임 추출
  const cardProfile = wallet.profile || {};
  const nickname = String(cardProfile.nickname?.value || "").trim();
  const name = String(cardProfile.name?.value || "").trim();
  const displayName = nickname || name || "나";

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
  addressEl.title = wallet.did;

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

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "settings-btn";
  settingsBtn.innerHTML = "⚙️";
  settingsBtn.title = "프로필 설정";
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    openProfileModal(wallet.did);
  };
  stats.appendChild(settingsBtn);

  const expandIcon = document.createElement("span");
  expandIcon.className = "did-expand-icon";
  expandIcon.textContent = "▼";
  stats.appendChild(expandIcon);

  header.appendChild(info);
  header.appendChild(stats);
  wrapper.appendChild(header);

  // 프로필 프리뷰
  const filledFields = Object.entries(cardProfile).filter(([key, data]) => {
    const val = String(data?.value || "").trim();
    return val.length > 0 && key !== "hidden_basic_fields";
  });

  if (filledFields.length > 0) {
    const preview = document.createElement("div");
    preview.className = "profile-preview";

    filledFields.slice(0, 3).forEach(([key, data]) => {
      const tag = document.createElement("span");
      tag.className = "profile-tag";
      tag.textContent = `${data.label || key}: ${data.value}`;
      preview.appendChild(tag);
    });

    if (filledFields.length > 3) {
      const more = document.createElement("span");
      more.className = "profile-tag";
      more.textContent = `+${filledFields.length - 3}`;
      preview.appendChild(more);
    }
    wrapper.appendChild(preview);
  }

  // 활성 서비스 목록
  const activeServicesPanel = document.createElement("div");
  activeServicesPanel.className = "did-services";

  if (didApproved.length > 0) {
    const approvedGroup = document.createElement("div");
    approvedGroup.className = "service-group";
    const approvedTitle = document.createElement("div");
    approvedTitle.className = "service-group-title";
    approvedTitle.innerHTML = "✅ 승인 완료 (서비스 교환 대기)";
    approvedGroup.appendChild(approvedTitle);
    didApproved.forEach((item) => approvedGroup.appendChild(createApprovedCard(item)));
    activeServicesPanel.appendChild(approvedGroup);
  }

  if (didActiveServices.length > 0) {
    const activeGroup = document.createElement("div");
    activeGroup.className = "service-group";
    const activeTitle = document.createElement("div");
    activeTitle.className = "service-group-title";
    activeTitle.innerHTML = "✅ 연결된 서비스";
    activeGroup.appendChild(activeTitle);
    didActiveServices.forEach((activeService) => activeGroup.appendChild(createActiveServiceCard(activeService)));
    activeServicesPanel.appendChild(activeGroup);
  }

  if (didApproved.length === 0 && didActiveServices.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "empty-state";
    emptyMsg.style.padding = "20px";
    emptyMsg.innerHTML = `
      <div class="empty-state-text">아직 연결된 서비스가 없어요</div>
      <div class="empty-state-hint">새로운 요청이 오면 여기에 표시됩니다</div>
    `;
    activeServicesPanel.appendChild(emptyMsg);
  }

  wrapper.appendChild(activeServicesPanel);

  header.addEventListener("click", () => {
    if (expandedDids.has(wallet.did)) expandedDids.delete(wallet.did);
    else expandedDids.add(wallet.did);
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
  let renderedCount = 0;
  wallets.forEach((wallet) => {
    try {
      const card = createDidCard(wallet);
      if (!card) {
        return;
      }
      didsEl.appendChild(card);
      renderedCount += 1;
    } catch (err) {
      console.error("Failed to render DID card", wallet.did, err);
    }
  });
  if (renderedCount === 0 && identityServiceKeyword) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-state-icon">🔎</div>
      <div class="empty-state-text">검색 결과가 없어요</div>
      <div class="empty-state-hint">서비스 이름으로 다시 검색해보세요</div>
    `;
    didsEl.appendChild(empty);
  }
}

// ==================== 인증 요청 ====================

async function getChallengeDraft(challenge) {
  const current = challengeDrafts.get(challenge.challenge_id);
  if (current) return current;

  const availableDids = Array.isArray(challenge.available_dids) ? challenge.available_dids : [];
  const selectedDid = challenge.did_hint || availableDids[0] || wallets[0]?.did || null;
  const requestedClaims = Array.isArray(challenge.requested_claims) ? challenge.requested_claims : [];

  const wallet = wallets.find(w => w.did === selectedDid);
  const policyClaims = selectedDid ? await getPolicy(selectedDid, challenge.service_id) : [];

  const selectedClaims = policyClaims.length > 0
    ? requestedClaims.filter((claim) => policyClaims.includes(claim))
    : requestedClaims.filter((claim) => !!getWalletClaimValue(wallet, claim));

  const draft = { did: selectedDid, claims: selectedClaims };
  challengeDrafts.set(challenge.challenge_id, draft);
  return draft;
}

async function createChallengeCard(challenge) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const header = document.createElement("div");
  header.className = "card-header";

  const title = createServiceNameNode(challenge.service_name, challenge.service_id);
  header.appendChild(title);
  wrapper.appendChild(header);

  const requestedClaims = Array.isArray(challenge.requested_claims) ? challenge.requested_claims : [];
  const availableDids = Array.isArray(challenge.available_dids) ? challenge.available_dids : [];
  const draft = await getChallengeDraft(challenge);

  // 기존 활성 서비스의 승인된 claims 조회 (새 claims 감지용)
  const existingApprovedClaims = await getExistingApprovedClaims(challenge.service_id, draft.did);
  const newClaims = requestedClaims.filter((c) => !existingApprovedClaims.includes(c));

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
    const wallet = wallets.find(w => w.did === did);
    const profile = wallet?.profile || {};
    option.textContent = profile.nickname?.value || profile.name?.value || shortenDid(did);
    option.title = did;
    if (did === draft.did) option.selected = true;
    didSelect.appendChild(option);
  });
  if (challenge.did_hint || availableDids.length <= 1) didSelect.disabled = true;
  wrapper.appendChild(didSelect);

  // Claims 선택
  const claimLabel = document.createElement("div");
  claimLabel.className = "claims-label";
  claimLabel.style.marginTop = "12px";
  if (newClaims.length > 0 && existingApprovedClaims.length > 0) {
    claimLabel.innerHTML = `공유할 정보 <span class="new-claims-badge">+${newClaims.length} 새 항목</span>`;
  } else {
    claimLabel.textContent = "공유할 정보";
  }
  wrapper.appendChild(claimLabel);

  const claimList = document.createElement("div");
  claimList.className = "checkbox-list";

  const applyClaims = (claims) => {
    Array.from(claimList.querySelectorAll("input[type=checkbox]")).forEach((input) => {
      input.checked = claims.includes(input.value);
    });
  };

  requestedClaims.forEach((claim) => {
    const labelText = getClaimLabel(claim);
    const isNew = newClaims.includes(claim);

    const row = document.createElement("label");
    row.className = isNew ? "claim-row new-claim" : "claim-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = claim;
    // 새 claim은 기본 체크 해제, 기존 claim은 draft에 따라
    checkbox.checked = isNew ? false : draft.claims.includes(claim);
    checkbox.addEventListener("change", () => {
      const selected = Array.from(claimList.querySelectorAll("input:checked")).map((el) => el.value);
      challengeDrafts.set(challenge.challenge_id, { did: didSelect.value, claims: selected });
    });

    const text = document.createElement("span");
    if (isNew) {
      text.innerHTML = `<span class="new-badge">NEW</span> ${labelText} <span class="field-key">${claim}</span>`;
    } else {
      text.innerHTML = `${labelText} <span class="field-key">${claim}</span>`;
    }

    row.appendChild(checkbox);
    row.appendChild(text);
    claimList.appendChild(row);
  });
  wrapper.appendChild(claimList);

  didSelect.addEventListener("change", async () => {
    const nextDid = didSelect.value;
    const wallet = wallets.find(w => w.did === nextDid);
    const policyClaims = await getPolicy(nextDid, challenge.service_id);
    const selectedClaims = policyClaims.length > 0
      ? requestedClaims.filter((claim) => policyClaims.includes(claim))
      : requestedClaims.filter((claim) => !!getWalletClaimValue(wallet, claim));
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
      await loadActiveServicesData();
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
      if (!activeIds.has(challengeId)) challengeDrafts.delete(challengeId);
    });

    pendingCountEl.textContent = challenges.length || 0;
    pendingCountEl.classList.toggle("hidden", challenges.length === 0);
    pendingSectionEl.classList.toggle("hidden", challenges.length === 0);

    listEl.innerHTML = "";
    if (challenges.length === 0) {
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
    await loadActiveServicesData();
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
  await loadProfileFields();
  await loadWalletsData();
  await loadActiveServicesData();
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

// ESC 키로 모달 닫기
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeProfileModal();
    closeDeleteModal();
  }
});

// 모달 외부 클릭으로 닫기
profileModal.addEventListener("click", (e) => {
  if (e.target === profileModal) closeProfileModal();
});

deleteModal.addEventListener("click", (e) => {
  if (e.target === deleteModal) closeDeleteModal();
});

addDidBtn.addEventListener("click", addDid);
identityServiceSearchEl.addEventListener("input", (e) => {
  identityServiceKeyword = String(e.target.value || "").trim();
  renderDids();
});
boot();
