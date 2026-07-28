"use strict";

const documentView = document.querySelector("#document");
const fileName = document.querySelector("#file-name");

function displayDocument(markdownDocument) {
	if (!markdownDocument) {
		return;
	}

	documentView.innerHTML = window.markdown.renderMarkdown(markdownDocument.content);
	window.scrollTo(0, 0);
	documentView.focus({ preventScroll: true });
	fileName.textContent = markdownDocument.path;
	fileName.title = markdownDocument.path;
	document.title = `${markdownDocument.name} — Minimal Markdown Viewer`;
}

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

// The path is handed to the main process, which opens the file through the
// same route as File → Open: the document comes back over document-opened,
// and errors surface in main's dialog. Nothing here awaits the outcome.
document.addEventListener("drop", (event) => {
	event.preventDefault();
	dragDepth = 0;
	document.body.classList.remove("dragging");

	const [file] = event.dataTransfer.files;
	if (file) {
		window.viewer.openDroppedFile(file);
	}
});

documentView.addEventListener("click", (event) => {
	const link = event.target.closest("a[data-href]");
	if (!link) {
		return;
	}

	event.preventDefault();
	window.viewer.openLink(link.dataset.href);
});

window.viewer.onDocumentOpened(displayDocument);
window.viewer.getInitialDocument().then(displayDocument).catch((error) => {
	fileName.textContent = `Could not open file: ${error.message}`;
});
