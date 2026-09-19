"""Test fixture: a bootstrap that starts but never acknowledges boot.

It never reads and never writes, so the host's boot timeout is the only thing
that can settle the run. Used to prove the host bounds a bootstrap that hangs
before the protocol starts.
"""

import time

time.sleep(120)
