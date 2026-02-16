const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miid", {
  getContext: () => ipcRenderer.invoke("context:get"),
  listChallenges: () => ipcRenderer.invoke("challenges:list"),
  listApproved: () => ipcRenderer.invoke("approved:list"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  approve: (challengeId) => ipcRenderer.invoke("challenge:approve", challengeId),
  deny: (challengeId) => ipcRenderer.invoke("challenge:deny", challengeId),
  cancelApproved: (authorizationCode) => ipcRenderer.invoke("approved:cancel", authorizationCode),
  revokeSession: (sessionId) => ipcRenderer.invoke("session:revoke", sessionId),
  onChallengeEvent: (handler) => {
    ipcRenderer.on("challenge:event", (_event, data) => handler(data));
  }
});
