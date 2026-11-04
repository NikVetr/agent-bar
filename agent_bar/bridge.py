"""Build the dependency-free VS Code bridge as a VSIX from the package's copy of it."""
import json
from pathlib import Path
from zipfile import ZipFile

SOURCE = Path(__file__).with_name('data') / 'vscode-bridge'
ID = 'agent-bar.agent-bar-bridge'


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
