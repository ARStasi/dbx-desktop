package main

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
)

// A small, transparent window glyph stays legible at tray/menu-bar sizes.
func trayIcon(light bool) []byte {
	im := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	ink := color.NRGBA{R: 27, G: 49, B: 57, A: 255}
	if light {
		ink = color.NRGBA{R: 235, G: 241, B: 243, A: 255}
	}
	for _, r := range []image.Rectangle{
		image.Rect(3, 5, 29, 8), image.Rect(3, 24, 29, 27),
		image.Rect(3, 5, 6, 27), image.Rect(26, 5, 29, 27),
		image.Rect(3, 11, 29, 14), image.Rect(9, 17, 17, 20),
	} {
		draw.Draw(im, r, image.NewUniform(ink), image.Point{}, draw.Src)
	}
	var b bytes.Buffer
	_ = png.Encode(&b, im)
	return b.Bytes()
}
