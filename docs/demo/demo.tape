# The README demo: the example agent's test replays from its recording, a
# system prompt edit is reported as a change at step 1. Render from the
# repository root:
#
#   vhs docs/demo/demo.tape
#
# Needs vhs, ttyd and ffmpeg. No API key and no network: CI=true puts
# agent-retrace in replay mode. The demo runs in a fresh clone of the
# committed HEAD at /tmp/agent-retrace (sharing this checkout's
# node_modules), so the working tree is clean and Vitest's banner shows a
# short path instead of your home directory.

Output docs/demo/demo.gif

Require npx
Require git

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 840
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Framerate 24

Hide
Type `rm -rf /tmp/agent-retrace && git clone -q . /tmp/agent-retrace && ln -s "$PWD/node_modules" /tmp/agent-retrace/node_modules && cd /tmp/agent-retrace && npm run -s build && export CI=true PS1='$ ' && clear`
Enter
Sleep 8s
Show

# 1. The test passes from the committed recording.
Type "npx vitest run examples/support-agent -t refund"
Sleep 300ms
Enter
Sleep 3s

# 2. Change the agent: one new line in its system prompt.
Type "clear"
Enter
Type `sed -i '/short and friendly/a\  "Always offer a discount code.",' examples/support-agent/agent.ts`
Sleep 300ms
Enter
Type "git --no-pager diff -U1"
Enter
Sleep 2500ms

# 3. Run again: agent-retrace reports where the agent changed, and how.
Type "clear"
Enter
Type "npx vitest run examples/support-agent -t refund"
Sleep 300ms
Enter
Sleep 7s

Hide
Type "cd - >/dev/null && rm -rf /tmp/agent-retrace && clear"
Enter
