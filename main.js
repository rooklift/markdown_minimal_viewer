"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require("electron");

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
let rendererReady = false;

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

	// A paste request already carries its document; there is nothing to read.
	if (request.document) {
		return request.document;
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

async function deliverOpenRequest(request) {
	try {
		const document = await readOpenRequest(request);
		if (document) {
			// A reload or an initial page load may have begun while the file was
			// being read. Keep the request for did-finish-load instead of sending
			// an IPC message before the new renderer has installed its listener.
			if (!rendererReady) {
				queuedOpenRequest = request;
				return;
			}
			sendDocument(document);
		}
	} catch (error) {
		if (!isLatestOpenRequest(request)) {
			return;
		}
		await dialog.showMessageBox(mainWindow, {
			type: "error",
			title: "Error",
			message: "Could not open that file.",
			detail: error.message,
		});
	}
}

async function openDocument(filePath) {
	const request = beginOpenRequest(filePath);
	if (!rendererReady) {
		queuedOpenRequest = request;
		return;
	}
	await deliverOpenRequest(request);
}

// The clipboard is read here in the main process, and only when the user picks
// the menu item or its accelerator: the renderer is given no way to ask for a
// read, so a compromised renderer can snoop nothing it could not already see.
// Only the text flavour is taken, and it flows through the renderer's own
// Markdown pipeline exactly as a file's content does — never as HTML.
async function pasteClipboard() {
	const content = clipboard.readText().replace(/^\uFEFF/, "");

	// An empty read is also all an image-only clipboard yields; either way
	// there is nothing to render, and the open document stays put.
	if (content === "") {
		return;
	}

	// The file-size cap, reused: it exists to bound the renderer's work, and
	// pasted text reaches the renderer just as a file's content does. Length
	// counts UTF-16 units where the file check counts bytes, but both measure
	// the same order of magnitude, which is all the cap is for.
	if (content.length > MAX_FILE_SIZE) {
		await dialog.showMessageBox(mainWindow, {
			type: "error",
			title: "Error",
			message: "Could not paste.",
			detail: "Pasted text must be smaller than 10 MB.",
		});
		return;
	}

	// A paste is an open request whose read has already happened, so it takes
	// an id like any other: a file open still in flight when the user pastes
	// resolves stale and is dropped rather than replacing the pasted text.
	const request = {
		document: {
			content,
			name: "Pasted text",
			path: "Pasted text",
		},
		id: ++latestOpenRequestId,
	};
	if (!rendererReady) {
		queuedOpenRequest = request;
		return;
	}
	await deliverOpenRequest(request);
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
							await dialog.showMessageBox(mainWindow, {
								type: "error",
								title: "Error",
								message: "Could not open that file.",
								detail: error.message,
							});
						}
					},
				},
				{ type: "separator" },
				{ role: process.platform === "darwin" ? "close" : "quit" },
			],
		},
		{
			// The viewer has no editable text: Copy and Select All act on the page,
			// and Paste — with nowhere to insert — renders the clipboard's text as a
			// document instead. The menu must exist: on macOS the clipboard shortcuts
			// only reach the app through menu items, so without it none of them work.
			label: "Edit",
			submenu: [
				{ role: "copy" },
				{
					label: "Paste",
					accelerator: "CommandOrControl+V",
					click: () => pasteClipboard(),
				},
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
	rendererReady = false;
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

	mainWindow.webContents.on("did-start-loading", () => {
		rendererReady = false;
	});
	mainWindow.webContents.on("did-finish-load", () => {
		rendererReady = true;
		if (queuedOpenRequest) {
			const request = queuedOpenRequest;
			queuedOpenRequest = null;
			deliverOpenRequest(request);
		}
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
		rendererReady = false;
		mainWindow = null;
	});
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (input.type.toLowerCase() === "keydown") {
			if ((input.control || input.meta) && input.key.toLowerCase() === "v") {
				if (!input.isAutoRepeat && !input.alt && !input.shift) {
					event.preventDefault();
					pasteClipboard();
				}
			}
		}
	});
}

app.on("open-file", (event, filePath) => {
	event.preventDefault();
	openDocument(filePath);
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

// A drop is the one case where the renderer names a file, and the main process
// cannot tell a genuine drop from any other call on this channel. Holding the
// path to the file types the viewer is for — and, in readDocument, to this
// machine — means even a compromised renderer can read nothing more sensitive
// than the documents the app already shows, and can name no host of its own.
ipcMain.on("viewer:open-dropped-file", async (_event, filePath) => {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return;
	}
	if (!OPENABLE_EXTENSION.test(filePath)) {
		await dialog.showMessageBox(mainWindow, {
			type: "error",
			title: "Error",
			message: "Could not open that file.",
			detail: "Only Markdown and plain text files can be dropped here.",
		});
		return;
	}
	await openDocument(filePath);
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
