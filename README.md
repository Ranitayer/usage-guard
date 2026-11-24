# usage-guard

A Claude Code plugin that shows your Claude usage in a band above the prompt and splits your 5-hour limit between your PCs.

- **Ring:** how much of the 5-hour window *this PC* used, filling toward what it may use. Small ring: the account's weekly usage.
- **Left before stop:** what this PC can still use, with a forecast at its last 15 minutes' pace.
- **Other PC:** **● working** (running a Claude turn right now), **● online** (Claude open, idle), or **offline** (with when it was last seen), plus how much of its share it used.
- **Account:** the whole account's 5-hour %, and this session's cost.
- **Graph:** this PC's usage over the 5-hour window, with the line it stops at.
- **Limit − 70% +:** this PC's part of the 5-hour window. Change it on either PC and the other gets the rest (70 here = 30 there). Also `/usage-share 70`; `/usage-share` alone shows where both PCs stand.
- **History** (button under Limit, or `/usage-history`): a side pane with this PC's usage per project in the current 5-hour window, both PCs' usage per day for the last 14 days, and this PC's usage by hour of day.

**Rules**
- Each PC stops at its own share. When stopped, **Let 1 through** and **Snooze 15m** appear.
- The other PC lends you its share right away when Claude is closed there (offline), or after 30 minutes without a turn when Claude is open but idle: this PC may then use everything the other one hasn't.
- A pop-up warns at 80% of what this PC may use.
- Each GitHub call is retried 3 times, and the other PC's last known state is kept for 10 minutes. Past that, the band says **not synced** and each PC simply keeps to its own limit.

**How the PCs talk:** through a private GitHub repo, `<your account>/usage-guard-sync` (it must exist; create it once, private, with a README). Each PC keeps a small clone in the plugin's data folder and pushes one file there (its usage, whether it's working, its share, its daily totals); no code, keys or messages. Git uses only the GitHub CLI's (`gh`) sign-in, and never asks for a password in a window.

Only works in Claude Code (the Code tab of the desktop app, or the `claude` CLI), not the regular Chat tab.

## Install (instructions for Claude)

You are installing this plugin on the user's computer. Do these steps in order, and tell the user what you did.

1. **Git and the GitHub CLI.** Check `git --version` and `gh --version`. If either is missing, install it (Windows: `winget install --id Git.Git -e` and `winget install --id GitHub.cli -e`; macOS: `brew install git gh`) or ask the user to, then open a new terminal so they're on PATH.

2. **Sign in to GitHub.** Run `gh auth status`. If it is not signed in, the user runs `gh auth login` themselves: GitHub.com, HTTPS, "Authenticate Git with your GitHub credentials" yes, then either a web browser login or a pasted token, on the same GitHub account as their other PC. A pasted token needs access to the private `usage-guard-sync` repo: a fine-grained token limited to that repo with **Contents: Read and write**, or a classic token with the `repo` scope. Wait until `gh auth status` shows them signed in, then check access with `git ls-remote https://github.com/<owner>/usage-guard-sync.git` (owner = the owner of this plugin's repo).

3. **Clone the repository.** The plugin must end up at `<home>/.claude/plugin-src/usage-guard`, where `<home>` is the user's home folder (`%USERPROFILE%` on Windows, `~` on macOS/Linux). It must be a git clone: that is how it updates itself. If that folder exists and is not a git clone (an older copy), move it aside to `usage-guard.old` first.
   - Windows PowerShell:
     ```powershell
     New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\plugin-src" | Out-Null
     git clone https://github.com/Ranitayer/usage-guard.git "$env:USERPROFILE\.claude\plugin-src\usage-guard"
     ```
   - macOS/Linux: `mkdir -p ~/.claude/plugin-src && git clone https://github.com/Ranitayer/usage-guard.git ~/.claude/plugin-src/usage-guard`
   - If it is already a clone, run `git -C <that folder> pull --ff-only` instead.

4. **Register it in the user's settings.** Edit `<home>/.claude/settings.json` (create it as `{}` if missing). Read it first and keep every existing key. Inside the top-level `"env"` object (create it if missing) add:

   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/plugin-src/usage-guard"
   ```

   If `CLAUDE_CODE_PLUGIN_DIRS` already lists this folder, leave it. If it lists others, append this one, separated by `;` on Windows or `:` on macOS/Linux. Make sure the file is still valid JSON.

5. **Optional: hide the ponytail band.** Only if the user has the ponytail plugin and wants its band replaced, write the text `off` to `<home>/.claude/.ponytail-band`.

6. **Tell the user to restart the Claude app completely** (on Windows also quit it from the system tray), then send one message in the Code tab. The band appears after Claude's first reply; "Other PC" fills in within a minute once both PCs have run it.

## Updates

Each time a Claude Code session starts, the plugin runs `git pull --ff-only` on its own folder, so pushes to this repository reach every PC the next time Claude opens there (a "usage-guard updated" pop-up says so). If the folder has conflicting local edits, the pull is skipped; `git -C <home>/.claude/plugin-src/usage-guard status` shows why.

## Uninstall

Remove this folder from `CLAUDE_CODE_PLUGIN_DIRS` in `<home>/.claude/settings.json`, delete `<home>/.claude/plugin-src/usage-guard`, and restart the app. Delete the private `usage-guard-sync` repo on GitHub if you no longer want it.
