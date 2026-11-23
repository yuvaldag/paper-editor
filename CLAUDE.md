# Paper Editor — instructions for Claude chats

This folder holds a local markdown & LaTeX editor (web app at http://localhost:4477) that the user edits in,
and Claude chats that act on the user's comments. Everything is exchanged through files:

```
app/                      the web app (server.js, cli.js, public/)
projects/<project>/*.md, *.tex   the documents (markdown or LaTeX) — edit these directly
projects/<project>/.collab/   protocol state — NEVER edit by hand (use the CLI)
```

All commands below are run from this folder. `node app/cli.js` has no dependencies.

## "Watch project X"
Run **in the background** (Bash `run_in_background: true`):

```
node app/cli.js watch "X"
```

It costs no tokens while waiting: it prints nothing, keeps a heartbeat so the app shows
"Watched by Claude", and exits only when the user sends comments/requests from the app.
It also starts the web server if it isn't running. Then tell the user it's being watched
and end your turn. Do NOT poll, sleep, or read its output file while it runs.

When it exits you are woken with its output, which lists each request (id, file, selected
text with context, comment) and the steps:
1. Read the file, then edit the `.md` / `.tex` file(s) directly with the Edit tool. Keep LaTeX files compilable. Keep edits focused
   on what was asked. The app shows your edits to the user as tracked changes to accept/reject.
   Question-only comments: answer in the done-note, no edit needed.
   After editing a `.tex` file run `node app/cli.js compile "X" file.tex` and fix any errors you introduced.
2. `node app/cli.js done "X" <id> "short note of what you changed"` for each request.
3. Relaunch `node app/cli.js watch "X"` in the background. Always do this, so the project stays watched.

If the watcher prints that another watcher took over, stop — another chat is watching.

## Boxes in markdown
To put content in a colored box (definitions, algorithms, theorems, remarks), use a fenced block —
never `>` blockquotes:

```
::: green Algorithm: Gradient Descent
Starting from $x_1$ … (any markdown: math, lists, figures)
:::
```

The first word is the color (blue, green, yellow, orange, red, purple, gray); the rest of the line is an
optional title. Close with a line containing only `:::`. Leave a blank line before and after the box.

## Suggestions and instructions inside files
The user can type in three modes. Their *suggestions* are stored in the file as CriticMarkup:
`{++added text++}` and `{--removed text--}`. Leave these marks exactly as they are unless the user
asks you to apply or reject them; edit around them. Their *instructions* are stored as
`{>>instruction<<}` at the place they apply (once sent: `{>>(sent) instruction<<}`), and arrive as a
`type=instructions` request: carry each one out, then delete the whole `{>>…<<}` note (that deletion is
applied without review). Compiling LaTeX
uses a cleaned copy (suggestions applied, instructions removed), so the markup never breaks the PDF.

## Git
Projects can be git repositories synced with a remote; the app (not you) commits, pulls and pushes,
automatically or when the user clicks Sync. You are only involved when a sync hits a **merge conflict**:
the watcher then wakes you with a `type=merge` request listing the conflicted files.
1. `node app/cli.js conflict "X" <file>` shows the common ancestor, the local version (now in the file)
   and the remote version.
2. Write the merged text into the file with the Edit tool (no conflict markers). Never run git yourself.
3. `node app/cli.js done "X" <id> "how you merged"` and relaunch the watcher. The user reviews your edits
   as tracked changes and approves the merge in the app.

Other git commands: `node app/cli.js git "X" status|sync|init|connect <url>|auto on|off`,
and `node app/cli.js create "X" --git <url>` creates a project by cloning a repository.

## Messaging the user
You may message the user on your own whenever you feel the need: a clarifying question before
a big edit, a heads-up about an inconsistency you noticed, a suggestion. Use judgment, don't spam.

```
node app/cli.js message "X" "your message" [--file main.md] [--quote "exact text from the file"]
```

`--quote` pins the message to a passage (highlighted in the editor; must match the file exactly).
The message appears in the app's side panel with a toast. If the user replies, the watcher wakes
you with the reply (shown together with your original message), so keep the watcher running.

## "Create project X"
```
node app/cli.js create "X"
```
then start watching it as above (and write initial content into `projects/X/main.md` if asked).

## Other
- `node app/cli.js list` — projects, watch status, open requests
- `node app/cli.js requests "X"` — open requests of a project
- `node app/cli.js serve` — start the web server in the background
- `node app/cli.js compile "X" file.tex` — build `projects/X/build/file.pdf` (uses tectonic / latexmk / pdflatex)
- New documents: create `projects/X/<name>.md` or `<name>.tex`; it appears in the app automatically.
