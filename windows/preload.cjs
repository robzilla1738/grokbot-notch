const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokbotNotchHost", {
  postMessage(payload) {
    ipcRenderer.send("notch-host", payload);
  }
});
