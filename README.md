# usage-guard

A Claude Code plugin that shows your Claude usage in a band above the prompt and stops you at a limit you set.

- **Band:** 5-hour usage ring, weekly ring, how much is left before you're stopped (with a pace forecast), usage and tokens in the last 15 minutes, this PC's usage, session cost, and a graph of the 5-hour window.
- **Limit:** `Limit − 70% +` on the band, or `/usage-limit 45` for any number. Prompts are blocked once you reach it; **Let 1 through** and **Snooze 15m** buttons appear when you're stopped.
- **Two PCs:** the limit is shared automatically. If the other PC (or Chat / claude.ai) is idle, this PC can use the whole limit; if both are busy, it's split by who's doing more work (20/80 to 80/20). Set the same limit on both PCs. `/usage-split off` turns this off.
- **Warning:** a pop-up at 80% of what this PC may use.

Only works in Claude Code (the Code tab of the desktop app, or the `claude` CLI), not the regular Chat tab.

## Install (instructions for Claude)

You are installing this plugin on the user's computer. Do these steps in order, and tell the user what you did.

1. **Clone the repository.** The plugin must end up at `<home>/.claude/plugin-src/usage-guard`, where `<home>` is the user's home folder (`%USERPROFILE%` on Windows, `~` on macOS/Linux). It must be a git clone: that is how it updates itself.
   - It needs `git`. If `git --version` fails, tell the user to install Git (on Windows: Git for Windows, https://git-scm.com/download/win, or `winget install --id Git.Git -e`) and stop until they have.
   - If that folder already exists and is not a git clone (for example an older copy from a zip), move it aside to `usage-guard.old` first.
   - Windows PowerShell:
     ```powershell
     New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\plugin-src" | Out-Null
     git clone https://github.com/Ranitayer/usage-guard.git "$env:USERPROFILE\.claude\plugin-src\usage-guard"
     ```
   - macOS/Linux: `mkdir -p ~/.claude/plugin-src && git clone https://github.com/Ranitayer/usage-guard.git ~/.claude/plugin-src/usage-guard`
   - Check that `<home>/.claude/plugin-src/usage-guard/.claude-plugin/plugin.json` exists.

2. **Register it in the user's settings.** Edit `<home>/.claude/settings.json` (create it as `{}` if missing). Read it first and keep every existing key. Add, inside the top-level `"env"` object (create `"env"` if missing):

   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/plugin-src/usage-guard"
   ```

   If `CLAUDE_CODE_PLUGIN_DIRS` already exists, append this folder to it instead of replacing it, separated by `;` on Windows or `:` on macOS/Linux. Make sure the file is still valid JSON afterwards.

3. **Optional: hide the ponytail band.** Only if the user has the ponytail plugin and wants its band replaced by this one, write the text `off` to `<home>/.claude/.ponytail-band`.

4. **Check it (if the `claude` CLI is available):** `claude plugin list` should show `usage-guard@inline` with status loaded.

5. **Tell the user to restart the Claude app completely** (on Windows also quit it from the system tray), then send one message in the Code tab. The band appears after Claude's first reply. Remind them to set the same limit on every PC.

## Updates

Each time a Claude Code session starts, the plugin runs `git pull --ff-only` on its own folder, so pushes to this repository reach every PC the next time Claude opens there (a small "usage-guard updated" pop-up says so). Nothing to do by hand. If the folder has local edits that conflict, the pull is skipped; `git -C <home>/.claude/plugin-src/usage-guard status` shows why.

## Uninstall

Remove the `CLAUDE_CODE_PLUGIN_DIRS` entry for this folder from `<home>/.claude/settings.json`, delete `<home>/.claude/plugin-src/usage-guard`, and restart the app.
