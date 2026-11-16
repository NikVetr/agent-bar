"""The VS Code bridge: build it as a VSIX from the package's copy, and hand a request to the window on a folder."""
import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from zipfile import ZipFile

from .state import ROOT, atomic_json

SOURCE = Path(__file__).with_name('data') / 'vscode-bridge'
ID = 'agent-bar.agent-bar-bridge'
FOLDER_WAIT = 45  # Seconds for a window on the folder, open or opened, to take a request.


def build(out=None):
    package = json.loads((SOURCE / 'package.json').read_text())
    out = Path(out or Path.home() / '.cache/agent-bar/bridge.vsix')
    out.parent.mkdir(parents=True, exist_ok=True)
    manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata><Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}"/>
 <DisplayName>{package['displayName']}</DisplayName><Description xml:space="preserve">{package['description']}</Description>
 <Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
 <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
    with ZipFile(out, 'w') as archive:
        archive.writestr('extension.vsixmanifest', manifest)
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/>'
                         '<Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
        for name in ['package.json', 'extension.js']:
            archive.write(SOURCE / name, f'extension/{name}')
    return out


def in_folder(folder, request, feature, what, root=ROOT):
    """Have the VS Code window on `folder` carry out `request` (reopen a chat, or start one with a prompt): `code`
    focuses the window open there, or opens one, and the first bridge on the folder takes the request. A window open
    since before its bridge had `feature` must be reloaded first."""
    if not Path(folder).is_dir(): raise ValueError(f'Its folder no longer exists: {folder}')
    live = []
    for path in (Path(root) / 'windows').glob('*.json'):
        try: window = json.loads(path.read_text())
        except (OSError, ValueError): continue
        if folder in window.get('roots', []) and time.time() - window.get('updated', 0) < 15: live.append(window)
    if live and not any(window.get(feature) for window in live):
        raise ValueError(f'The VS Code window on {Path(folder).name} started before it could {what}; '
                         'run Developer: Reload Window in it, then retry')
    code = shutil.which('code')
    if not code: raise ValueError('The VS Code `code` command is not on PATH')
    action = str(uuid.uuid4())
    (Path(root) / 'resume').mkdir(mode=0o700, exist_ok=True)
    pending = Path(root) / 'resume' / f'{action}.json'
    response = Path(root) / 'responses' / f'{action}.json'
    atomic_json(pending, {**request, 'id': action, 'folder': folder, 'expires': time.time() + FOLDER_WAIT})
    subprocess.Popen([code, folder], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        for _ in range(FOLDER_WAIT * 4):
            time.sleep(.25)
            if response.exists():
                result = json.loads(response.read_text())
                response.unlink()
                if not result['ok']: raise ValueError(result.get('error', f'VS Code could not {what}'))
                return {'ok': True}
        raise ValueError(f'No VS Code window on {folder} took the request within {FOLDER_WAIT} s')
    finally:
        pending.unlink(missing_ok=True)
