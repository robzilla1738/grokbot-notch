const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokbotNotchHost", {
  postMessage(payload) {
    ipcRenderer.send("notch-host", payload);
  },
  dragHold() {
    ipcRenderer.send("notch-drag-start");
  },
  dragEnd() {
    ipcRenderer.send("notch-drag-end");
  }
});
