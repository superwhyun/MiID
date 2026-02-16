const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miid", {
  getContext: () => ipcRenderer.invoke("context:get"),
  listWallets: () => ipcRenderer.invoke("wallets:list"),
  createWallet: (payload) => ipcRenderer.invoke("wallets:create", payload),
  getProfile: (payload) => ipcRenderer.invoke("profile:get", payload),
  updateProfile: (payload) => ipcRenderer.invoke("profile:update", payload),
  listChallenges: () => ipcRenderer.invoke("challenges:list"),
  listApproved: () => ipcRenderer.invoke("approved:list"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  approve: (payload) => ipcRenderer.invoke("challenge:approve", payload),
  deny: (payload) => ipcRenderer.invoke("challenge:deny", payload),
  cancelApproved: (payload) => ipcRenderer.invoke("approved:cancel", payload),
  revokeSession: (payload) => ipcRenderer.invoke("session:revoke", payload),
  setClaimPolicy: (payload) => ipcRenderer.invoke("claim-policy:set", payload),
  getClaimPolicy: (payload) => ipcRenderer.invoke("claim-policy:get", payload),
  deleteWallet: (payload) => ipcRenderer.invoke("wallets:delete", payload),
  getProfileFields: () => ipcRenderer.invoke("profile-fields:get"),
  onChallengeEvent: (handler) => {
    ipcRenderer.on("challenge:event", (_event, data) => handler(data));
  }
});
