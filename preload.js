"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("viewer", {
	getInitialDocument: () => ipcRenderer.invoke("viewer:get-initial-document"),
	onDocumentOpened: (callback) => {
		ipcRenderer.on("viewer:document-opened", (_event, document) => callback(document));
	},
	openDialog: () => ipcRenderer.invoke("viewer:open-dialog"),
	openDroppedFile: (file) => {
		const filePath = webUtils.getPathForFile(file);
		return ipcRenderer.invoke("viewer:open-dropped-file", filePath);
	},
	openLink: (target) => ipcRenderer.invoke("viewer:open-link", target),
});
