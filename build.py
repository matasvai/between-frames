"""Bundle the editable local app without adding runtime dependencies."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
html = (ROOT / "index.html").read_text()
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + (ROOT / "style.css").read_text() + '\n</style>')
for script in ("engine.js", "app.js"):
    html = html.replace(f'<script src="{script}"></script>', '<script>\n' + (ROOT / script).read_text() + '\n</script>')
(ROOT / "standalone.html").write_text(html)
output = ROOT / "dist"
output.mkdir(exist_ok=True)
with zipfile.ZipFile(output / "between-frames-collision-lab.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for name in ("README.md", "index.html", "style.css", "app.js", "engine.js", "standalone.html", "engine.test.js", "app.test.js", "evaluate.js", "evidence.json", "build.py", "render_preview.py"):
        archive.write(ROOT / name, arcname="collision-lab/" + name)
print(f"Bundled {len(html.encode()):,} bytes; source archive: {output / 'between-frames-collision-lab.zip'}")
