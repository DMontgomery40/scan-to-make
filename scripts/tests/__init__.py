# `python3 -m unittest scripts/tests/test_x.py` imports this package first; make `import lane_isolation`
# resolve there too (discover already puts this folder on sys.path).
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lane_isolation  # noqa: E402,F401  (no test may reach the real build lane)
