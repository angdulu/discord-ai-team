import datetime as dt
import importlib.util
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('lint', Path(__file__).parent / 'scripts/nexus-lint.py')
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)

class LintTest(unittest.TestCase):
    def test_links_freeze_age_and_no_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            notes = root / 'nexus/notes'
            notes.mkdir(parents=True)
            (root / 'raw').mkdir()
            (root / 'raw/source.md').write_text('raw')
            (root / 'AGENTS.md').write_text('rules')
            (notes / 'target.md').write_text('---\ntags: [engineering]\n---\nTarget')
            content = """---
tags:
  - engineering
status: active
updated: 2026-09-01
---
[[target]] [[target\\|Alias]] [[raw/source]] [[AGENTS]] [[missing#section]]
`[[not-a-link]]`
```md
[[example-only]]
```
"""
            (notes / 'live.md').write_text(content)
            (notes / 'admissions.md').write_text('---\ntags: [admissions]\n---\nFrozen')
            (notes / 'retired.md').write_text('---\ntags: [engineering]\nstatus: archived\n---\n[[historical]]')
            result = lint.scan(root, dt.date(2026, 11, 13))
            self.assertEqual([r['detail'] for r in result['findings'] if r['kind'] == 'broken-link'], ['missing'])
            self.assertEqual(result['counts'].get('stale-active'), 1)
            self.assertNotIn('domain', result['counts'])
            self.assertEqual((notes / 'live.md').read_text(), content)
    def test_ambiguous_and_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ['nexus/notes', 'nexus/sources']:
                (root / directory).mkdir(parents=True)
                (root / directory / 'same.md').write_text('---\ntags: [engineering]\n---')
            (root / 'nexus/notes/a.md').write_text('---\ntags: [engineering]\n---\n[[same]]\n' + 'word ' * 3001)
            (root / 'nexus/log.md').write_text('x' * 51201)
            result = lint.scan(root)
            # Relative Obsidian link resolves to a sibling before a basename search.
            self.assertNotIn('ambiguous-link', result['counts'])
            self.assertGreaterEqual(result['counts']['size'], 2)
if __name__ == '__main__':
    unittest.main()
