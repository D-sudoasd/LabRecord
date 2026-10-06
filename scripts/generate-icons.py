"""Regenerate the checked-in app icons; optional developer tool requiring Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
scale = 4
image = Image.new("RGBA", (512 * scale, 512 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 512 * scale - 1, 512 * scale - 1), 112 * scale, fill="#176b62")
points = [(220, 138), (220, 222), (162, 340), (172, 360), (340, 360), (350, 340), (292, 222), (292, 138)]
draw.line([(x * scale, y * scale) for x, y in points], fill="white", width=18 * scale, joint="curve")
for x1, y1, x2, y2 in [(210, 138, 302, 138), (194, 280, 318, 280)]:
    draw.line((x1 * scale, y1 * scale, x2 * scale, y2 * scale), fill="white", width=18 * scale)
draw.ellipse((324 * scale, 329 * scale, 436 * scale, 441 * scale), fill="#edf6ef")
draw.line([(350 * scale, 385 * scale), (372 * scale, 402 * scale), (410 * scale, 365 * scale)], fill="#176b62", width=13 * scale, joint="curve")
image = image.resize((512, 512), Image.Resampling.LANCZOS)
(root / "assets").mkdir(exist_ok=True)
image.save(root / "public" / "icon.png")
image.save(root / "assets" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
