# App icon

The monitor identifies a desktop app, the red rectangular data bricks suggest
data work, and the prompt identifies a code workspace. The colors match the
app's Databricks-inspired navy, warm white and lava palette. The artwork is
original and does not use the Databricks logo.

Edit `appicon.icon/Assets/workspace.svg` for the foreground and
`appicon.icon/icon.json` for the native macOS background and material.
`appicon.svg` and the PNG, ICO, ICNS and CAR files are generated assets.

Regenerate from the repository root on a Mac with Xcode 26 or later:

```sh
swift build/render-icon.swift
wails3 task common:generate:icons
cp build/darwin/icons.icns build/darwin/dmg-file-icon.icns
```

Windows and Linux builds use the checked-in PNG. macOS builds also compile the
Icon Composer document for the native icon, including dark and tinted variants.
The existing development or release app bundle gets the new icon when rebuilt.
