#!/bin/sh
set -eu
umask 077
# Xvfb provides a software display to Blender's render stage on headless hosts.
exec xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' "$@"
