"""Tinos (Times New Roman metric clone) + Noto Serif SC (Song) -> one TTF per weight for Android res/font.

Latin/punctuation come from Tinos (first in merge wins the cmap), CJK from Noto Serif SC subset.
usage: python -I build_fonts.py <dl dir> <app src/main dir> <out res/font dir>
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.merge import Merger, Options as MergeOptions
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib import instancer

dl, src, out = map(pathlib.Path, sys.argv[1:4])
out.mkdir(parents=True, exist_ok=True)
tmp = pathlib.Path(__file__).parent / "tmp"
tmp.mkdir(exist_ok=True)


def gb2312() -> set:
    cps = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                cps.add(ord(bytes([hi, lo]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    return cps


def app_chars() -> set:
    cps = set()
    for p in list(src.rglob("*.xml")) + list(src.rglob("*.kt")):
        cps.update(ord(c) for c in p.read_text(encoding="utf-8", errors="ignore") if ord(c) > 0x2E7F)
    return cps


cjk = gb2312() | app_chars()
cjk |= set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFF0)) | set(range(0x2E80, 0x2F00))
cjk = {c for c in cjk if c >= 0x2E80}


def subset_font(font: TTFont, unicodes, hinting: bool) -> TTFont:
    opts = subset.Options()
    opts.hinting = hinting
    opts.layout_features = ["kern", "liga", "clig", "calt", "ccmp", "locl", "mark", "mkmk", "frac", "sups", "subs"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.drop_tables += ["DSIG", "Debg", "BASE", "vhea", "vmtx", "VORG", "STAT", "MVAR", "HVAR", "VVAR", "meta", "gasp"]
    s = subset.Subsetter(opts)
    s.populate(unicodes=unicodes)
    s.subset(font)
    return font


def build(weight: int, tinos_file: str, style: str):
    tinos = TTFont(dl / tinos_file)
    scale_upem(tinos, 1000)
    tinos_cps = set(tinos.getBestCmap())
    subset_font(tinos, tinos_cps, hinting=False)
    tp = tmp / f"tinos-{weight}.ttf"
    tinos.save(tp)

    vf = TTFont(dl / "NotoSerifSC-VF.ttf")
    noto = instancer.instantiateVariableFont(vf, {"wght": weight})
    subset_font(noto, cjk - tinos_cps, hinting=False)
    np_ = tmp / f"noto-{weight}.ttf"
    noto.save(np_)

    merged = Merger(options=MergeOptions(drop_tables=["DSIG"])).merge([str(tp), str(np_)])
    a = max(TTFont(tp)["hhea"].ascent, TTFont(np_)["hhea"].ascent)
    d = min(TTFont(tp)["hhea"].descent, TTFont(np_)["hhea"].descent)
    merged["hhea"].ascent, merged["hhea"].descent, merged["hhea"].lineGap = a, d, 0
    os2 = merged["OS/2"]
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = a, d, 0
    os2.usWinAscent, os2.usWinDescent = a, -d
    os2.usWeightClass = weight
    bold = weight >= 700
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if bold else 0b1000000)
    merged["head"].macStyle = 1 if bold else 0
    name = merged["name"]
    name.names = []
    for nid, val in {
        0: "Copyright 2026 The Tinos Project Authors (https://github.com/googlefonts/tinos). (c) 2017-2024 Adobe (http://www.adobe.com/), Noto Serif SC. SIL OFL 1.1.",
        1: "Tessera Serif", 2: style, 3: f"Tessera Serif {style}", 4: f"Tessera Serif {style}",
        5: "Version 1.0", 6: f"TesseraSerif-{style}",
        13: "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
        14: "https://openfontlicense.org",
    }.items():
        name.setName(val, nid, 3, 1, 0x409)
    path = out / f"tessera_serif_{style.lower()}.ttf"
    merged.save(path)
    print(path.name, path.stat().st_size, "glyphs", len(merged.getGlyphOrder()))


build(400, "tinos-Tinos-Regular.ttf", "Regular")
build(700, "tinos-Tinos-Bold.ttf", "Bold")
