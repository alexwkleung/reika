# Records docs/demo.gif. Install VHS (`brew install vhs`), start your model server, then run
# from the repo root:
#   vhs docs/demo.tape
# Each run copies docs/demo/project to a fresh temp dir, so every take starts from the same state
# and the model's edits never touch this repo. The fixture is a git repo there so reika's edit
# diffs have a baseline.

Output docs/demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 20
Set TypingSpeed 45ms

Hide
Type "rm -rf /tmp/reika-demo && cp -R docs/demo/project /tmp/reika-demo && cd /tmp/reika-demo"
Enter
Type "git init -q && git add -A && git commit -qm init && clear && reika"
Enter
Wait+Screen@60s /ctrl-c to exit/
Show

Sleep 1s
Type "withRetry in src/fetch.js never backs off, make it exponential and add a test for the delays"
Sleep 500ms
Enter
Sleep 3s

# The status bar reads "ctrl-c to abort" while busy and "ctrl-c to exit" once idle again.
# Long enough for a small local model to read, edit, and run the tests. Trim dead time afterwards.
Wait+Screen@10m /ctrl-c to exit/
Sleep 4s
