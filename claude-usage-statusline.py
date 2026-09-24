#!/usr/bin/env python3
# Claude Code statusLine: shows plan usage, and caches it to ~/.claude/usage-cache.json
# so a Claude Code session running the official Discord plugin can answer !usage by reading the file.
import json
import os
import sys
import time

CACHE = os.path.expanduser('~/.claude/usage-cache.json')

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}

limits = data.get('rate_limits') or {}
if limits:
    try:
        tmp = CACHE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'updated_at': int(time.time()), 'rate_limits': limits}, f)
        os.replace(tmp, CACHE)
    except Exception:
        pass

parts = []
model = (data.get('model') or {}).get('display_name')
if model:
    parts.append(model)
for key, label in (('five_hour', '5h'), ('seven_day', 'week')):
    pct = (limits.get(key) or {}).get('used_percentage')
    if pct is not None:
        parts.append(f'{label} {round(pct)}% used')
print(' · '.join(parts))
