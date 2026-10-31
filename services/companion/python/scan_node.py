# SPDX-License-Identifier: MIT
"""Run the trusted Node CLI under scan_job.py's descendant supervisor."""
import os
import sys
os.execv(sys.argv[1],sys.argv[1:])
