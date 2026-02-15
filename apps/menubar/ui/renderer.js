const listEl = document.getElementById("list");
const approvedEl = document.getElementById("approved");
const sessionsEl = document.getElementById("sessions");
const statusEl = document.getElementById("status");
const didEl = document.getElementById("didLabel");

function setStatus(text) {
  statusEl.textContent = text;
}

function card(challenge) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${challenge.service_id}</strong>`;
  wrapper.appendChild(title);

  const scopes = document.createElement("div");
  scopes.className = "meta";
  scopes.textContent = `Scopes: ${challenge.scopes.join(", ")}`;
  wrapper.appendChild(scopes);

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
    setStatus(`Approving ${challenge.challenge_id}...`);
    try {
      const result = await window.miid.approve(challenge.challenge_id);
      setStatus(`Approved. auth_code=${result.authorization_code}`);
      await loadChallenges();
    } catch (err) {
      setStatus(`Approve failed: ${err.message}`);
    }
  };

  const denyBtn = document.createElement("button");
  denyBtn.className = "deny";
  denyBtn.textContent = "Deny";
  denyBtn.onclick = async () => {
    setStatus(`Denying ${challenge.challenge_id}...`);
    try {
      await window.miid.deny(challenge.challenge_id);
      setStatus("Denied.");
      await loadChallenges();
    } catch (err) {
      setStatus(`Deny failed: ${err.message}`);
    }
  };

  action.appendChild(approveBtn);
  action.appendChild(denyBtn);
  wrapper.appendChild(action);
  return wrapper;
}

function sessionCard(session) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${session.service_id}</strong>`;
  wrapper.appendChild(title);

  const scope = document.createElement("div");
  scope.className = "meta";
  scope.textContent = `Scope: ${session.scope}`;
  wrapper.appendChild(scope);

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
    setStatus(`Revoking session ${session.session_id}...`);
    try {
      await window.miid.revokeSession(session.session_id);
      setStatus("Session revoked.");
      await loadSessions();
    } catch (err) {
      setStatus(`Revoke failed: ${err.message}`);
    }
  };
  actions.appendChild(revokeBtn);
  wrapper.appendChild(actions);
  return wrapper;
}

function approvedCard(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";
  const title = document.createElement("div");
  title.innerHTML = `<strong>${item.service_id}</strong>`;
  wrapper.appendChild(title);

  const meta1 = document.createElement("div");
  meta1.className = "meta";
  meta1.textContent = `Scopes: ${item.scopes.join(", ")}`;
  wrapper.appendChild(meta1);

  const meta2 = document.createElement("div");
  meta2.className = "meta";
  meta2.textContent = `Waiting for token exchange`;
  wrapper.appendChild(meta2);

  const meta3 = document.createElement("div");
  meta3.className = "meta";
  meta3.textContent = `Expires: ${item.expires_at}`;
  wrapper.appendChild(meta3);

  const actions = document.createElement("div");
  actions.className = "actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = async () => {
    setStatus(`Cancelling approval ${item.authorization_code}...`);
    try {
      await window.miid.cancelApproved(item.authorization_code);
      setStatus("Moved back to pending.");
      await loadChallenges();
      await loadApproved();
    } catch (err) {
      setStatus(`Cancel failed: ${err.message}`);
    }
  };
  actions.appendChild(cancelBtn);
  wrapper.appendChild(actions);
  return wrapper;
}

async function loadChallenges() {
  try {
    const data = await window.miid.listChallenges();
    listEl.innerHTML = "";
    if (!data.challenges || data.challenges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No pending approval requests.";
      listEl.appendChild(empty);
      setStatus("Idle");
      return;
    }
    data.challenges.forEach((c) => listEl.appendChild(card(c)));
    setStatus(`${data.challenges.length} request(s) pending`);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
}

async function loadSessions() {
  try {
    const data = await window.miid.listSessions();
    sessionsEl.innerHTML = "";
    if (!data.sessions || data.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No active sessions.";
      sessionsEl.appendChild(empty);
      return;
    }
    data.sessions.forEach((s) => sessionsEl.appendChild(sessionCard(s)));
  } catch (err) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `Session load failed: ${err.message}`;
    sessionsEl.innerHTML = "";
    sessionsEl.appendChild(empty);
  }
}

async function loadApproved() {
  try {
    const data = await window.miid.listApproved();
    approvedEl.innerHTML = "";
    if (!data.approved || data.approved.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No approved pending exchanges.";
      approvedEl.appendChild(empty);
      return;
    }
    data.approved.forEach((x) => approvedEl.appendChild(approvedCard(x)));
  } catch (err) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `Approved load failed: ${err.message}`;
    approvedEl.innerHTML = "";
    approvedEl.appendChild(empty);
  }
}

async function boot() {
  let ctx = await window.miid.getContext();
  didEl.textContent = ctx.did ? `DID: ${ctx.did}` : "DID not found. Create wallet first.";
  await loadChallenges();
  await loadApproved();
  await loadSessions();
  window.miid.onChallengeEvent(async (event) => {
    if (event && event.type === "did_changed") {
      ctx = await window.miid.getContext();
      didEl.textContent = ctx.did ? `DID: ${ctx.did}` : "DID not found. Create wallet first.";
    }
    await loadChallenges();
    await loadApproved();
    await loadSessions();
  });
  setInterval(loadApproved, 4000);
  setInterval(loadChallenges, 4000);
  setInterval(loadSessions, 10000);
}

boot();
