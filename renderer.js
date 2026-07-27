"use strict";

const documentView = document.querySelector("#document");
const fileName = document.querySelector("#file-name");
const openButton = document.querySelector("#open-button");

function displayDocument(markdownDocument) {
	if (!markdownDocument) {
		return;
	}

	documentView.innerHTML = window.markdown.renderMarkdown(markdownDocument.content);
	documentView.scrollTo(0, 0);
	documentView.focus({ preventScroll: true });
	fileName.textContent = markdownDocument.path;
	fileName.title = markdownDocument.path;
	document.title = `${markdownDocument.name} — Minimal Markdown Viewer`;
}

async function chooseDocument() {
	openButton.disabled = true;
	try {
		displayDocument(await window.viewer.openDialog());
	} catch (error) {
		fileName.textContent = `Could not open file: ${error.message}`;
	} finally {
		openButton.disabled = false;
	}
}

openButton.addEventListener("click", chooseDocument);

let dragDepth = 0;

document.addEventListener("dragenter", (event) => {
	event.preventDefault();
	dragDepth += 1;
	document.body.classList.add("dragging");
});

document.addEventListener("dragover", (event) => {
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (event) => {
	event.preventDefault();
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) {
		document.body.classList.remove("dragging");
	}
});

document.addEventListener("drop", async (event) => {
	event.preventDefault();
	dragDepth = 0;
	document.body.classList.remove("dragging");

	const [file] = event.dataTransfer.files;
	if (!file) {
		return;
	}

	try {
		displayDocument(await window.viewer.openDroppedFile(file));
	} catch (error) {
		fileName.textContent = `Could not open file: ${error.message}`;
	}
});

documentView.addEventListener("click", (event) => {
	const link = event.target.closest("a[data-href]");
	if (!link) {
		return;
	}

	event.preventDefault();
	const target = link.dataset.href;
	if (target.startsWith("#")) {
		return;
	}
	window.viewer.openLink(target);
});

window.viewer.onDocumentOpened(displayDocument);
window.viewer.getInitialDocument().then(displayDocument).catch((error) => {
	fileName.textContent = `Could not open file: ${error.message}`;
});
