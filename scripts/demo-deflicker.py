# Replaces torn frames (a text row suddenly much shorter than in both neighbours, which agree
# with each other) with the previous frame. Reads/writes raw rgb24 on stdin/stdout.
import sys, numpy as np
W, H = int(sys.argv[1]), int(sys.argv[2])
size = W * H * 3
BAND = 6          # px rows per band
DROP = 60         # px shorter than both neighbours = torn
AGREE = 40        # neighbours within this of each other
def read():
    b = sys.stdin.buffer.read(size)
    return np.frombuffer(b, np.uint8).reshape(H, W, 3) if len(b) == size else None
def extents(f):
    bg = f[5, 5].astype(int)
    fg = (np.abs(f.astype(int) - bg).max(axis=2) > 40)
    cols = np.where(fg, np.arange(W), -1)
    rows = cols.max(axis=1)
    return rows[: H - H % BAND].reshape(-1, BAND).max(axis=1)
out = sys.stdout.buffer
prev, cur = read(), read()
if prev is None: sys.exit()
out.write(prev.tobytes()); last_good = prev
ep = extents(prev); fixed = 0
while cur is not None:
    nxt = read()
    ec = extents(cur)
    if nxt is not None:
        en = extents(nxt)
        torn = (ec < np.minimum(ep, en) - DROP) & (np.abs(ep - en) < AGREE)
        if torn.any():
            cur, ec = last_good, ep; fixed += 1
    out.write(cur.tobytes()); last_good = cur; ep = ec
    cur = nxt
print(f"replaced {fixed} torn frames", file=sys.stderr)
