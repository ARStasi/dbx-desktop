// Run from the repository root: swift build/render-icon.swift
// AppKit renders the vector without third-party image dependencies.
import AppKit

let build = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let source = build.appendingPathComponent("appicon.icon/Assets/workspace.svg")
let foreground = try String(contentsOf: source, encoding: .utf8)
let artwork = foreground.replacingOccurrences(
    of: "  <!-- A desktop code workspace, with original rectangular data bricks. -->",
    with: """
      <title>dbx-desktop</title>
      <desc>A desktop monitor with red data bricks and a code prompt.</desc>
      <rect x="64" y="64" width="896" height="896" rx="200" fill="#1B3139"/>
    """
)
let vector = build.appendingPathComponent("appicon.svg")
try artwork.write(to: vector, atomically: true, encoding: .utf8)

guard let image = NSImage(contentsOf: vector),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
      ),
      let context = NSGraphicsContext(bitmapImageRep: bitmap)
else { fatalError("Cannot render the app icon") }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
image.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:])
else { fatalError("Cannot encode the app icon") }
try png.write(to: build.appendingPathComponent("appicon.png"))
try png.write(to: build.appendingPathComponent("darwin/dmg-file-icon.png"))
