# Minimal Markdown Viewer

A small desktop Markdown viewer built by Sol 5.6, Opus 5 and Fable 5 for Electron with no other dependencies.

It supports:

- headings
- paragraphs and hard line breaks
- bold and italic text
- inline and fenced code
- blockquotes and horizontal rules
- ordered, unordered, and nested lists
- web and email links
- images, shown as links to the image rather than loaded

Raw HTML is displayed as text rather than executed. Only `http`, `https`, and `mailto` links are live, and they open in your browser or mail client rather than in the viewer. Every other target — a relative path, an absolute one, another scheme, a `#fragment` — is shown as plain text, so a document has no way to name a local file, let alone make the viewer read one or the system open one.

## Run it

If Electron is installed globally on Windows, double-click `start.bat` or run:

```sh
electron .
```

Open a file by dropping it on the window or pressing **Ctrl/Command + O**. You can also pass a file at startup:

```sh
npm start -- README.md
```

## Test it

```sh
npm test
```
