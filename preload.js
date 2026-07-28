"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("viewer", {
	onDocumentOpened: (callback) => {
		ipcRenderer.on("viewer:document-opened", (_event, document) => callback(document));
	},
	openDroppedFile: (file) => {
		const filePath = webUtils.getPathForFile(file);
		ipcRenderer.send("viewer:open-dropped-file", filePath);
	},
	openLink: (target) => ipcRenderer.invoke("viewer:open-link", target),
});
