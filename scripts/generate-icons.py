"""Regenerate the checked-in app icons; optional developer tool requiring Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
scale = 4
size = 512 * scale


def xy(x: float, y: float) -> tuple[float, float]:
    return (x * scale, y * scale)


def lerp(start: tuple[int, ...], end: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(round(start[i] + (end[i] - start[i]) * t) for i in range(len(start)))


def clip_to(layer: Image.Image, mask: Image.Image) -> Image.Image:
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", layer.size, 0), mask))
    return layer


image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
pad = 32 * scale
side = size - pad * 2
tile = Image.new("RGBA", (side, side))
tile_draw = ImageDraw.Draw(tile)
top = (36, 150, 142, 255)  # #24968E
bottom = (14, 76, 70, 255)  # #0E4C46
for y in range(side):
    tile_draw.line([(0, y), (side - 1, y)], fill=lerp(top, bottom, y / (side - 1)))

tile_mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle(
    (pad, pad, pad + side - 1, pad + side - 1),
    radius=108 * scale,
    fill=255,
)
placed = Image.new("RGBA", (size, size), (0, 0, 0, 0))
placed.paste(tile, (pad, pad))
image = Image.composite(placed, image, tile_mask)

gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
ImageDraw.Draw(gloss).ellipse(xy(-20, -80) + xy(532, 250), fill=(255, 255, 255, 38))
image = Image.alpha_composite(image, clip_to(gloss, tile_mask))

flask = Image.new("L", (size, size), 0)
flask_draw = ImageDraw.Draw(flask)
flask_draw.rounded_rectangle((*xy(214, 118), *xy(298, 156)), radius=12 * scale, fill=255)
flask_draw.polygon(
    [
        xy(x, y)
        for x, y in (
            (228, 142),
            (228, 214),
            (158, 352),
            (174, 396),
            (338, 396),
            (354, 352),
            (284, 214),
            (284, 142),
        )
    ],
    fill=255,
)
flask_draw.rectangle((*xy(228, 142), *xy(284, 220)), fill=255)

glass = Image.new("RGBA", (size, size), (255, 255, 255, 0))
glass.putalpha(flask)
image = Image.alpha_composite(image, glass)

liquid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
liquid_draw = ImageDraw.Draw(liquid)
liquid_draw.rectangle((*xy(150, 332), *xy(362, 400)), fill=(232, 163, 23, 255))
liquid_draw.chord((*xy(176, 314), *xy(336, 348)), 0, 180, fill=(246, 196, 83, 255))
image = Image.alpha_composite(image, clip_to(liquid, flask))

image = image.resize((512, 512), Image.Resampling.LANCZOS)
(root / "assets").mkdir(exist_ok=True)
image.save(root / "public" / "icon.png")
image.save(
    root / "assets" / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
