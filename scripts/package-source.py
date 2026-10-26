#!/usr/bin/env python3
"""Build a review candidate from an explicit source allowlist, never the developer tree."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT_FILES = {'.gitignore', '.gitattributes', 'LICENSE', 'NOTICE.md', 'README.md',
              'DEPLOYMENT.md', 'CONTRIBUTING.md', 'SECURITY.md',
              'package.json', 'package-lock.json', 'main.mjs'}
SOURCE_DIRS = {'config', 'gateway', 'integrations', 'models', 'public', 'scripts',
               'secrets', 'shared', 'tests', 'tools', '.github'}
EXTENSIONS = {'.mjs', '.js', '.cjs', '.ts', '.css', '.html', '.md', '.txt', '.py', '.sh', '.yml', '.yaml'}
# One-off developer probes bound to the author's own console/host; not part of the
# distributable project and not safe to advertise to new users.
EXCLUDE_FILES = {
    'tests/prod-verify.mjs', 'tests/prod-ui-taski.mjs', 'tests/features-real.mjs',
    'tests/debug-ui.mjs', 'tests/probe-subtitle.mjs', 'tests/repro-qr.mjs',
}
BLOCK_DIRS = {'node_modules', '.git', '.tmp', '.workbuddy', 'data', 'legacy', 'private',
              '__pycache__', '.venv', 'dist', 'outputs', 'coverage', 'sensevoice'}
BLOCK_NAMES = re.compile(r'(?:^id_(?:rsa|ed25519)|cookie|storage.?state|credential(?!.*\.example\.json$)|session.*\.json$)', re.I)


def build(root, output):
    root, output = root.resolve(), output.resolve()
    if output == root or root in output.parents:
        raise SystemExit('Output must be outside source root')
    if output.exists():
        raise SystemExit('Output directory already exists; choose a new candidate path')
    if not output.parent.is_dir():
        raise SystemExit('Output parent must already exist')
    files, excluded = [], {'directories': 0, 'files': 0}

    def walk(current):
        for item in sorted(current.iterdir()):
            rel = item.relative_to(root)
            if item.is_symlink():
                raise SystemExit('Symlink encountered; package stopped')
            if item.is_dir():
                if item.name in BLOCK_DIRS or item.name.startswith('.venv') or (current == root and item.name not in SOURCE_DIRS):
                    excluded['directories'] += 1
                    continue
                walk(item)
                continue
            allowed = (len(rel.parts) == 1 and item.name in ROOT_FILES) or (
                len(rel.parts) > 1 and rel.parts[0] in SOURCE_DIRS and (
                    item.suffix in EXTENSIONS or item.name.endswith('.example.json') or rel.as_posix() == 'secrets/.env.template'))
            if not allowed or BLOCK_NAMES.search(item.name) or rel.as_posix() in EXCLUDE_FILES:
                excluded['files'] += 1
                continue
            payload = item.read_bytes()
            if b'\0' in payload or len(payload) > 4 * 1024 * 1024:
                raise SystemExit('Binary or oversized allowed source encountered; package stopped')
            files.append((rel.as_posix(), payload))

    walk(root)
    if not ROOT_FILES.issubset({name for name, _ in files}):
        raise SystemExit('Required release files missing')
    output.mkdir(mode=0o700)
    source = output / 'standalone-v2'
    source.mkdir()
    manifest = []
    for name, payload in files:
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        manifest.append({'path': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
    archive = output / 'standalone-v2-source-candidate.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, payload in files:
            info = zipfile.ZipInfo('standalone-v2/' + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, payload)
    report = {'kind': 'review-candidate-not-approved-release', 'fileCount': len(files),
              'excluded': excluded, 'archive': archive.name,
              'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': manifest}
    (output / 'source-manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'fileCount': len(files), 'excluded': excluded, 'archive': archive.name,
                      'archiveSha256': report['archiveSha256']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.root, args.output)
