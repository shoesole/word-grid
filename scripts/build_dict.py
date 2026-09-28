"""Build public/words.txt from ENABLE (dictionary) + SCOWL (commonness tiers).

Output: one word per line, prefixed by a tier digit:
  0 = very common (SCOWL <=35), 1 = common (<=50), 2 = known (<=70), 3 = obscure.
"""
import glob, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
SCOWL = glob.glob(os.path.join(DATA, "scowl-*", "final"))[0]

tier_of = {}
for level, tier in [(35, 0), (50, 1), (70, 2)]:
    for path in glob.glob(os.path.join(SCOWL, "english-words.*")) + glob.glob(os.path.join(SCOWL, "american-words.*")):
        if int(path.rsplit(".", 1)[1]) > level:
            continue
        with open(path, encoding="latin-1") as f:
            for w in f:
                w = w.strip()
                if w.islower() and w.isalpha() and w not in tier_of:
                    tier_of[w] = tier

out = []
with open(os.path.join(DATA, "enable1.txt")) as f:
    for w in f:
        w = w.strip().lower()
        if not re.fullmatch(r"[a-z]{3,16}", w):
            continue
        # Words with q not followed by u can't be formed with the Qu die.
        if re.search(r"q(?!u)", w):
            continue
        out.append(f"{tier_of.get(w, 3)}{w}")

with open(os.path.join(HERE, "..", "public", "words.txt"), "w") as f:
    f.write("\n".join(out))

counts = [sum(1 for l in out if l[0] == str(t)) for t in range(4)]
print(len(out), "words; tiers:", counts)
