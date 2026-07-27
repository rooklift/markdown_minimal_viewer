"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MARKDOWN_EXTENSION = /\.(?:md|mdown|markdown)$/i;

let mainWindow;
let currentFile = null;
let queuedFile = null;

function findCommandLineFile() {
	const args = process.argv.slice(app.isPackaged ? 1 : 2);
	return args.find((argument) => !argument.startsWith("-") && MARKDOWN_EXTENSION.test(argument));
}

async function readDocument(filePath) {
	const absolutePath = path.resolve(filePath);
	const stats = await fs.stat(absolutePath);

	if (!stats.isFile()) {
		throw new Error("That path is not a file.");
	}

	if (stats.size > MAX_FILE_SIZE) {
		throw new Error("Markdown files must be smaller than 10 MB.");
	}

	const content = await fs.readFile(absolutePath, "utf8");
	currentFile = absolutePath;

	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.setTitle(`${path.basename(absolutePath)} — Minimal Markdown Viewer`);
	}

	return {
		content,
		name: path.basename(absolutePath),
		path: absolutePath,
	};
}

async function showOpenDialog() {
	const result = await dialog.showOpenDialog(mainWindow, {
		properties: ["openFile"],
		filters: [
			{ name: "Markdown", extensions: ["md", "markdown"] },
			{ name: "Text", extensions: ["txt"] },
			{ name: "All files", extensions: ["*"] },
		],
	});

	if (result.canceled) {
		return null;
	}

	return readDocument(result.filePaths[0]);
}

function sendDocument(document) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("viewer:document-opened", document);
	}
}

async function openDocument(filePath) {
	try {
		sendDocument(await readDocument(filePath));
	} catch (error) {
		await dialog.showMessageBox(mainWindow, {
			type: "error",
			title: "Could not open file",
			message: "Could not open that Markdown file.",
			detail: error.message,
		});
	}
}

function buildMenu() {
	const template = [
		{
			label: "File",
			submenu: [
				{
					label: "Open…",
					accelerator: "CommandOrControl+O",
					click: async () => {
						try {
							const document = await showOpenDialog();
							if (document) {
								sendDocument(document);
							}
						} catch (error) {
							await dialog.showErrorBox("Could not open file", error.message);
						}
					},
				},
				{ type: "separator" },
				{ role: process.platform === "darwin" ? "close" : "quit" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
	];

	if (process.platform === "darwin") {
		template.unshift({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		});
	}

	return Menu.buildFromTemplate(template);
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 920,
		height: 760,
		minWidth: 420,
		minHeight: 320,
		backgroundColor: "#f7f6f2",
		show: false,
		title: "Minimal Markdown Viewer",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.js"),
			sandbox: true,
		},
	});

	mainWindow.loadFile("renderer.html");
	mainWindow.once("ready-to-show", () => mainWindow.show());
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

app.on("open-file", (event, filePath) => {
	event.preventDefault();
	if (mainWindow) {
		openDocument(filePath);
	} else {
		queuedFile = filePath;
	}
});

app.whenReady().then(() => {
	createWindow();
	Menu.setApplicationMenu(buildMenu());
	queuedFile ||= findCommandLineFile();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

ipcMain.handle("viewer:get-initial-document", async () => {
	if (!queuedFile) {
		return null;
	}

	const filePath = queuedFile;
	queuedFile = null;
	return readDocument(filePath);
});

ipcMain.handle("viewer:open-dialog", () => showOpenDialog());

ipcMain.handle("viewer:open-dropped-file", (_event, filePath) => {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new Error("The dropped item does not have a valid file path.");
	}
	return readDocument(filePath);
});

ipcMain.handle("viewer:open-link", async (_event, target) => {
	if (typeof target !== "string" || target.length > 2048) {
		return;
	}

	const trimmed = target.trim();
	if (/^(https?:|mailto:)/i.test(trimmed)) {
		await shell.openExternal(trimmed);
		return;
	}

	if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
		return;
	}

	const withoutFragment = trimmed.split("#", 1)[0];

	let decodedPath;
	try {
		decodedPath = decodeURIComponent(withoutFragment);
	} catch {
		return;
	}

	const resolvedPath = path.resolve(currentFile ? path.dirname(currentFile) : process.cwd(), decodedPath);

	// Relative links may only ever open Markdown, and only ever inside the viewer.
	// Handing other paths to the shell would let a document execute local files.
	if (MARKDOWN_EXTENSION.test(resolvedPath)) {
		await openDocument(resolvedPath);
	}
});
