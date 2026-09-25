# Records docs/demo.gif. Install VHS (`brew install vhs`), start your model server, then:
#   vhs docs/demo.tape
# The demo runs in DEMO_DIR, so point it at a small throwaway project, not this repo.

Output docs/demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 20
Set TypingSpeed 45ms

Hide
Type "cd ${DEMO_DIR:-/tmp/reika-demo} && clear && reika"
Enter
Wait+Screen@60s /ctrl-c to exit/
Show

Sleep 1s
Type "the retry helper in src/fetch.ts never backs off, fix it and add a test"
Sleep 500ms
Enter
Sleep 3s

# The status bar reads "ctrl-c to abort" while busy and "ctrl-c to exit" once idle again.
# Long enough for a small local model to read, edit, and run the tests. Trim dead time afterwards.
Wait+Screen@10m /ctrl-c to exit/
Sleep 4s
