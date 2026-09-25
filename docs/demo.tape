# Records a raw take of the demo. Install VHS (`brew install vhs`), start your model server, then
# run from the repo root:
#   vhs docs/demo.tape
# The take is real time, so it is written as an MP4 and cut into docs/demo.gif afterwards with
#   scripts/demo-cut.sh <turn-end-seconds>
# which keeps the typed prompt at normal speed, speeds up the turn, and drops the idle tail.
# REIKA_DEMO_MODEL=<id> picks the model for the take without changing your saved profile.
# Each run copies docs/demo/project to a fresh temp dir, so every take starts from the same state
# and the model's edits never touch this repo. The fixture is a git repo there so reika's edit
# diffs have a baseline.

Output "/tmp/reika-demo-raw.mp4"

Set Shell zsh
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 20
Set TypingSpeed 45ms
Set Framerate 12

Hide
Type "rm -rf /tmp/reika-demo && cp -R docs/demo/project /tmp/reika-demo && cd /tmp/reika-demo"
Enter
Type "git init -q && git add -A && git commit -qm init && clear && env ${REIKA_DEMO_MODEL:+REIKA_MODEL=$REIKA_DEMO_MODEL} REIKA_DEFAULT_MODE=agent reika"
Enter
Wait+Screen@60s /ctrl-c to exit/
Show

Sleep 1s
Type "withRetry in src/fetch.js never backs off, make it exponential and add a test for the delays"
Sleep 500ms
Enter
Sleep 3s

# A fixed duration rather than a Wait: once reika's output scrolls past one screen, VHS's Wait stops
# matching the status bar (observed with both Wait+Screen and Wait+Line), and a timed-out Wait
# writes no video at all. Size this to the model; a fast MoE finishes this task in ~10 minutes.
Sleep 14m
