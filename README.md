# Minimal Markdown Viewer

A small desktop Markdown viewer built by Sol 5.6 for Electron with no other dependencies.

It supports:

- headings
- paragraphs and hard line breaks
- bold and italic text
- inline and fenced code
- blockquotes and horizontal rules
- ordered, unordered, and nested lists
- web, email, relative-file, and relative-Markdown links

Raw HTML is displayed as text rather than executed.

## Run it

If Electron is installed globally on Windows, double-click `start.bat` or run:

```bat
start.bat
```

Otherwise, install the project's only dependency and start it:

```sh
npm install
npm start
```

Open a file by dropping it on the window, using the button, or pressing **Ctrl/Command + O**. You can also pass a file at startup:

```sh
npm start -- README.md
```

## Test it

```sh
npm test
```
