"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
// One extension list for every route a path arrives by unasked — command line
// and drop — so a file that opens one way opens the other. The Open dialog is
// the user choosing deliberately, so it may offer anything.
const OPENABLE_EXTENSION = /\.(?:md|mdown|markdown|txt)$/i;
const LINK_SCHEME = /^(?:https?|mailto):/i;
const CONTROL_CHARACTER = new RegExp("[\\u0000-\\u001f\\u007f]");

let mainWindow;
let queuedOpenRequest = null;
let latestOpenRequestId = 0;

function beginOpenRequest(filePath) {
	return {
		filePath,
		id: ++latestOpenRequestId,
	};
}

function isLatestOpenRequest(request) {
	return request.id === latestOpenRequestId;
}

function findCommandLineFile() {
	const args = process.argv.slice(app.isPackaged ? 1 : 2);
	return args.find((argument) => !argument.startsWith("-") && OPENABLE_EXTENSION.test(argument));
}

async function readDocument(filePath) {
	const absolutePath = path.resolve(filePath);

	// A UNC path names a host as well as a file, and merely reading it opens a
	// network connection that can offer that host the user's credentials, so
	// paths that name a host are refused. The check is textual: a mapped drive
	// letter or a planted symlink still reaches a network host, but either takes
	// local access to set up, and a document can never supply a path at all.
	// Device paths (\\.\ and \\?\) share the leading double separator and are
	// no more welcome.
	if (/^[\\/]{2}/.test(absolutePath)) {
		throw new Error("Network paths are not supported.");
	}

	const stats = await fs.stat(absolutePath);

	if (!stats.isFile()) {
		throw new Error("That path is not a file.");
	}

	if (stats.size > MAX_FILE_SIZE) {
		throw new Error("Markdown files must be smaller than 10 MB.");
	}

	// Node keeps a leading UTF-8 BOM, and an invisible character in front of
	// a "#" would stop the parser recognising the first heading.
	const content = (await fs.readFile(absolutePath, "utf8")).replace(/^\uFEFF/, "");

	return {
		content,
		name: path.basename(absolutePath),
		path: absolutePath,
	};
}

async function readOpenRequest(request) {
	if (!isLatestOpenRequest(request)) {
		return null;
	}

	try {
		const document = await readDocument(request.filePath);
		return isLatestOpenRequest(request) ? document : null;
	} catch (error) {
		// A failure from an older request is no more relevant than its successful
		// result. Suppress it instead of replacing the current file name with an
		// error or opening a dialog over the document chosen afterwards.
		if (!isLatestOpenRequest(request)) {
			return null;
		}
		throw error;
	}
}

async function showOpenDialog() {
	const result = await dialog.showOpenDialog(mainWindow, {
		properties: ["openFile"],
		filters: [
			{ name: "Markdown", extensions: ["md", "mdown", "markdown"] },
			{ name: "Text", extensions: ["txt"] },
			{ name: "All files", extensions: ["*"] },
		],
	});

	if (result.canceled) {
		return null;
	}

	return result.filePaths[0];
}

function sendDocument(document) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("viewer:document-opened", document);
	}
}

async function openDocument(filePath) {
	const request = beginOpenRequest(filePath);
	try {
		const document = await readOpenRequest(request);
		if (document) {
			sendDocument(document);
		}
	} catch (error) {
		if (!isLatestOpenRequest(request)) {
			return;
		}
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
					label: "Open...",
					accelerator: "CommandOrControl+O",
					click: async () => {
						try {
							const filePath = await showOpenDialog();
							if (filePath) {
								await openDocument(filePath);
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
			// The viewer has no editable text, so copying is the whole menu — but the
			// menu must exist: on macOS the clipboard shortcuts only reach the page
			// through menu roles, so without it Cmd+C and Cmd+A do nothing.
			label: "Edit",
			submenu: [
				{ role: "copy" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
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
	// The window only ever shows renderer.html; links are opened via IPC, so any
	// navigation elsewhere (e.g. a dragged link) is something to block. Same-URL
	// navigation stays allowed because reload arrives through this event too.
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (url !== mainWindow.webContents.getURL()) {
			event.preventDefault();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

app.on("open-file", (event, filePath) => {
	event.preventDefault();
	if (mainWindow) {
		openDocument(filePath);
	} else {
		queuedOpenRequest = beginOpenRequest(filePath);
	}
});

app.whenReady().then(() => {
	if (!queuedOpenRequest) {
		const commandLineFile = findCommandLineFile();
		if (commandLineFile) {
			queuedOpenRequest = beginOpenRequest(commandLineFile);
		}
	}
	createWindow();
	Menu.setApplicationMenu(buildMenu());
});

// Quitting on every platform — contrary to the macOS convention — means the app
// can never run windowless, a state in which File → Open read documents and
// silently dropped them because there was no renderer to send them to.
app.on("window-all-closed", () => {
	app.quit();
});

ipcMain.handle("viewer:get-initial-document", async () => {
	if (!queuedOpenRequest) {
		return null;
	}

	const request = queuedOpenRequest;
	queuedOpenRequest = null;
	return readOpenRequest(request);
});

// A drop is the one case where the renderer names a file, and the main process
// cannot tell a genuine drop from any other call on this channel. Holding the
// path to the file types the viewer is for — and, in readDocument, to this
// machine — means even a compromised renderer can read nothing more sensitive
// than the documents the app already shows, and can name no host of its own.
ipcMain.handle("viewer:open-dropped-file", (_event, filePath) => {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new Error("The dropped item does not have a valid file path.");
	}
	if (!OPENABLE_EXTENSION.test(filePath)) {
		throw new Error("Only Markdown and plain text files can be dropped here.");
	}
	return readOpenRequest(beginOpenRequest(filePath));
});

// The renderer only marks up http(s) and mailto targets, but it is the untrusted
// side of this boundary, so the same rule decides again here. No link resolves to a
// path any more: a document cannot name a local file, so it can neither make the
// viewer read one nor hand one to the shell.
ipcMain.handle("viewer:open-link", async (_event, target) => {
	if (typeof target !== "string" || target.length > 2048) {
		return;
	}

	const trimmed = target.trim();
	if (CONTROL_CHARACTER.test(trimmed) || !LINK_SCHEME.test(trimmed)) {
		return;
	}

	await shell.openExternal(trimmed);
});
