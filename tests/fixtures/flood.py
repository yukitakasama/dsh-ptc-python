"""Test fixture: a bootstrap that floods its frame pipe past any sane budget.

It never sends a frame, so the host's inbound byte guard fires before
``readline`` would materialize a line. Used to prove a hostile peer cannot grow
the host's memory without bound.
"""

import os

# One long run of bytes with no newline at all: the host must stop on
# accumulated bytes, not on line completion.
while True:
    os.write(1, b"x" * 65_536)
