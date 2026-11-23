# Paper Editor

A local editor for papers written in **markdown or LaTeX** that you can work on together with
[Claude Code](https://claude.com/claude-code) chats. You write in the browser. Claude chats watch your
project folder, act on the comments you leave, and their edits come back as tracked changes for you to
accept or reject.

Everything is plain files on your disk. The app and the chats talk only through files in each project
folder, so no server or account is involved apart from git remotes you choose to connect.

## Features

- **One rendered editor** (CodeMirror 6 + KaTeX): markdown syntax is hidden except where the cursor is,
  and equations are rendered. Click an equation to edit its source with a live preview, then press Enter.
- **LaTeX documents look like the paper**: title block, numbered sections, theorem/proof environments,
  lists, equations numbered across the document, working `\ref` / `\eqref` / `\cite`, footnotes and images.
- **Colored boxes** in markdown: `::: green Optional title` … `:::` (blue, green, yellow, orange, red,
  purple, gray), inserted with the ▢ Box button or by wrapping selected lines.
- **Figures shown inline**: markdown `![caption](fig.png){width=60%}` and LaTeX `\includegraphics` render
  in the editor, including PDF figures (converted with macOS `sips`). Paste or drag an image/PDF into the
  editor to save it in `figures/` and insert the right markdown or `figure` environment.
- **Compile to PDF** with a real LaTeX compiler (Tectonic, latexmk or pdflatex). The PDF can be shown beside
  the editor and recompiles as you type. Errors are listed with clickable line numbers.
- **Comments for Claude**: select text and click *Comment*, or send a general request. A chat that
  watches the project wakes up, edits the file, and replies under your comment.
- **Three editing modes**: *Edit* (direct), *Suggest* (your additions in blue, removals in orange, each
  with accept/reject) and *Instruct* (purple notes in the text that you send to Claude). Select text, or
  click inside a note or suggestion, to change it into plain text, a suggestion or an instruction.
- **Tracked changes**: Claude's insertions and deletions are shown inline with ✓ / ✕ for each change,
  plus Accept all / Reject all. Your own typing is saved directly.
- **Messages from Claude**: a chat can ask you something or flag an issue, optionally pinned to a passage.
- **Git sync** per project: create a local repo, connect a remote or clone one. Sync on click or
  automatically. Merge conflicts are handed to Claude, whose merge you review and approve before it is
  committed and pushed.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. There are no npm dependencies to install for running the app.
- Optional, for PDFs: [Tectonic](https://tectonic-typesetting.github.io) (`brew install tectonic`)
  or a TeX distribution providing `latexmk` / `pdflatex`.
- Optional, for sync: `git`, with SSH keys or a credential helper for your remote.

## Getting started

```bash
node app/server.js
```

Open http://localhost:4477 and create a project with the **+** next to *Projects*.
Projects are stored in `projects/<name>/` (ignored by this repository).

Then open Claude Code in this folder and say **"watch project &lt;name&gt;"**. `CLAUDE.md` explains the
protocol to the chat. It runs `node app/cli.js watch "<name>"` in the background, which uses no tokens
while waiting and wakes the chat only when you send something from the app.

## Command line (used by chats, also handy by hand)

```bash
node app/cli.js list                              # projects, watch status, open requests
node app/cli.js create "<name>" [--git <url>]     # new project, optionally cloned from git
node app/cli.js watch "<name>"                    # block until the app sends requests
node app/cli.js done "<name>" <id> "note"         # mark a request handled
node app/cli.js message "<name>" "text" [--file f.md] [--quote "exact text"]
node app/cli.js compile "<name>" paper.tex        # build projects/<name>/build/paper.pdf
node app/cli.js git "<name>" status|sync|init|connect <url>|auto on|off
node app/cli.js conflict "<name>" <file>          # base / local / remote versions during a merge
```

## How it works

```
projects/<project>/
  *.md, *.tex              the documents (Claude edits these directly)
  build/                   compiled PDFs
  .collab/base/<file>      last accepted text; the diff against it is shown as tracked changes
  .collab/requests/*.json  comments, requests and messages
  .collab/watcher.json     heartbeat of the watching chat
  .collab/git.json         sync settings and merge state
```

`.collab/` and `build/` are kept out of project repositories via `.git/info/exclude`.

## Rebuilding the editor bundle

The browser editor is prebuilt in `app/public/vendor/`. After changing `app/editor-src/editor.js`, run:

```bash
app/editor-src/build.sh
```

This needs npm. Dependencies are installed in a temporary folder.
