const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const projectRoot = context.packager.projectDir;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(projectRoot, 'icon.ico');
  const version = context.packager.appInfo.version;

  for (const file of [exePath, iconPath]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required packaging file is missing: ${file}`);
    }
  }

  const { rcedit } = await import('rcedit');
  await rcedit(exePath, {
    icon: iconPath,
    'file-version': version,
    'product-version': version,
    'version-string': {
      FileDescription: context.packager.appInfo.productName,
      ProductName: context.packager.appInfo.productName
    }
  });
};
