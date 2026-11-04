#!/usr/bin/env python3
"""AT-SPI helper for the actual Linux native app. No WebDriver or injected JS.
Run in its desktop session: DISPLAY=:93 DBUS_SESSION_BUS_ADDRESS=... python3 native-ui.py tree
`click NAME [WITHIN]` invokes one visible accessible control, optionally within a named parent;
`text NAME VALUE` edits an accessible text field.
Never use this to print without explicit task authorization. Tree omits text-field values.
"""
import sys
import pyatspi

def find(node, name):
    if node.name == name:
        return node
    for child in node:
        match = find(child, name)
        if match is not None:
            return match

def tree(node, depth=0):
    if depth > 24:
        return
    if node.name:
        print('  ' * depth + node.getRoleName() + ': ' + node.name)
    for child in node:
        tree(child, depth + 1)

root = pyatspi.Registry.getDesktop(0)
app = find(root, 'counterpart')
if app is None:
    raise SystemExit('Counterpart is not visible in this desktop session.')
action = sys.argv[1] if len(sys.argv) > 1 else 'tree'
if action == 'tree':
    tree(app)
elif action in ('click', 'text'):
    scope = find(app, sys.argv[3]) if action == 'click' and len(sys.argv) > 3 else app
    if scope is None:
        raise SystemExit('Parent is not visible: ' + sys.argv[3])
    node = find(scope, sys.argv[2])
    if node is None:
        raise SystemExit('Control is not visible: ' + sys.argv[2])
    if action == 'click':
        if not node.queryAction().doAction(0):
            raise SystemExit('The native control refused its action.')
    else:
        node.queryEditableText().setTextContents(sys.argv[3])
else:
    raise SystemExit('Use tree, click NAME, or text NAME VALUE.')
