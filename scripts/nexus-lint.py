#!/usr/bin/env python3
"""Read-only Nexus health scan. Only --report writes the generated report."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import sys

DOMAINS = {'engineering', 'physical', 'intellect', 'university', 'identity'}
ADMISSIONS = {'admissions', 'college-admissions', 'college', 'counseling-doc', 'college-prep'}

def frontmatter(text):
    match = re.match(r'^---\n(.*?)\n---(?:\n|$)', text, re.S)
    if not match:
        return {}, set()
    block = match[1]
    fields = dict(re.findall(r'^(\w+):[ \t]*(.*)$', block, re.M))
    match_tags = re.search(r'^tags:[ \t]*\[([^\]]*)\]', block, re.M)
    tags = set(t.strip().strip("\"'") for t in match_tags[1].split(',')) if match_tags else set()
    if not match_tags:
        block_tags = re.search(r'^tags:[ \t]*\n((?:[ \t]*- .*(?:\n|$))+)', block, re.M)
        if block_tags:
            tags = set(re.findall(r'- (\S+)', block_tags[1]))
    return {k: v.strip("\"'") for k, v in fields.items()}, tags

def prose(text):
    text = re.sub(r'^---\n.*?\n---', '', text, count=1, flags=re.S)
    text = re.sub(r'^(`{3,}|~{3,})[^\n]*\n.*?^\1[ \t]*$', '', text, flags=re.M | re.S)
    return re.sub(r'`[^`\n]*`', '', text)

def scan(root, today=None):
    root = Path(root).resolve()
    today = today or dt.date.today()
    targets = set()
    names = {}
    for file in root.rglob('*'):
        if any(p.startswith('.') for p in file.relative_to(root).parts) or file.is_symlink() or not file.is_file():
            continue
        rel = file.relative_to(root).as_posix()
        targets.update({rel, rel[:-3] if rel.endswith('.md') else rel})
        names.setdefault(file.name, set()).add(rel)
        names.setdefault(file.stem, set()).add(rel)
    findings = []
    def add(kind, path, detail):
        findings.append({'kind': kind, 'path': path, 'detail': detail})
    pages = list((root / 'nexus').rglob('*.md'))
    for file in sorted(pages):
        rel = file.relative_to(root).as_posix()
        if file.is_symlink() or file.name == 'nexus-health-report.md':
            continue
        text = file.read_text(encoding='utf-8')
        fields, tags = frontmatter(text)
        if not fields:
            add('frontmatter', rel, 'Missing frontmatter')
        archived = fields.get('status') in {'done', 'archived'} or rel.startswith('nexus/log/')
        if rel.split('/')[1] in {'notes', 'projects', 'sources', 'personal'} and not (tags & (DOMAINS | ADMISSIONS)):
            add('domain', rel, 'No domain tag (check admissions freeze before changing)')
        if fields.get('status') == 'active':
            try:
                age = (today - dt.date.fromisoformat(fields.get('updated', ''))).days
                if age > 30:
                    add('stale-active', rel, f'Updated {age} days ago; age alone does not mean done')
            except ValueError:
                add('date', rel, 'Missing/invalid updated date')
        words = len(text.split())
        budget = 1500 if file.name == 'AGENTS.md' else 3000
        if words > budget and not rel.startswith('nexus/log/'):
            add('size', rel, f'{words} words > {budget} (review only; do not split automatically)')
        if archived:
            continue
        for target in set(re.findall(r'\[\[([^\]|]+)(?:\|[^\]]*)?\]\]', prose(text))):
            target = target.split('#', 1)[0].strip()
            if not target or '://' in target:
                continue
            try:
                local = (file.parent / target).resolve().relative_to(root).as_posix()
            except ValueError:
                local = ''
            choices = {target, 'nexus/' + target, local}
            if choices & targets:
                continue
            if '/' not in target:
                candidates = names.get(target, set())
                if len(candidates) == 1:
                    continue
                if len(candidates) > 1:
                    add('ambiguous-link', rel, target)
                    continue
            add('broken-link', rel, target)
    agents = root / 'AGENTS.md'
    if agents.exists() and len(agents.read_text().split()) > 1500:
        add('size', 'AGENTS.md', 'Over 1500 words')
    for filename, limit, measure in [('log.md', 51200, 'bytes'), ('index.md', 300, 'lines')]:
        file = root / 'nexus' / filename
        if file.exists():
            value = file.stat().st_size if measure == 'bytes' else len(file.read_text().splitlines())
            if value > limit:
                add('size', 'nexus/' + filename, f'{value} {measure} > {limit}')
    counts = {kind: sum(f['kind'] == kind for f in findings) for kind in sorted({f['kind'] for f in findings})}
    return {'date': today.isoformat(), 'pages': len(pages), 'counts': counts, 'findings': findings}

def render(result):
    day = result['date']
    lines = ['---', 'tags: [engineering, maintenance]', 'created: ' + day, 'updated: ' + day,
             'description: "Generated Nexus health findings; review before fixing."', 'sources: ["[[schema]]"]', '---', '',
             '# Nexus Health Report', '', f"Generated {day}; {result['pages']} pages scanned. Script-owned; regenerated daily.",
             'Thresholds are review triggers, not permission to archive, split, or change admissions content.', '']
    for kind, count in result['counts'].items():
        lines.extend([f'## {kind} ({count})', ''])
        rows = [f for f in result['findings'] if f['kind'] == kind]
        for row in rows[:40]:
            lines.append(f"- `{row['path']}`: {row['detail']}")
        if len(rows) > 40:
            lines.append(f'- {len(rows) - 40} more; run with --json for the full list.')
        lines.append('')
    if not result['findings']:
        lines.append('No findings.')
    return '\n'.join(lines) + '\n'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--report', action='store_true')
    args = parser.parse_args()
    result = scan(args.root)
    if args.report:
        report = args.root / 'nexus/notes/nexus-health-report.md'
        if report.is_symlink():
            raise ValueError('Refusing symlink report destination')
        content = render(result)
        if report.exists():
            old = report.read_text()
            created = re.search(r'^created: (\d{4}-\d{2}-\d{2})$', old, re.M)
            if created:
                content = content.replace('created: ' + result['date'], 'created: ' + created[1], 1)
        report.write_text(content)
    print(json.dumps(result, ensure_ascii=False) if args.json else render(result))

if __name__ == '__main__':
    main()
