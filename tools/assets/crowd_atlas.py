# One texture for a Rocketbox avatar in the crowd (tools/assets/crowd.py): its colour maps packed into a 768 x 512
# atlas (the body 512 x 512 on the left; the head 256 x 256 and the cutout maps, hair and lashes, glasses, in the
# column on the right), and where its skin is, in the alpha channel of the opaque parts (1 cloth and hair, 0.75 skin),
# for the client to give the same person another skin tone (src/world/people.js). The cutout maps keep their own
# alpha (coverage).
#   python crowd_atlas.py <Textures dir> <out.webp> [preview.jpg]
import sys, os, glob
import numpy as np
from PIL import Image, ImageFilter

W, H = 768, 512
SKIN, CLOTH = 191, 255  # alpha of skin and of everything else in the opaque parts


def lab(rgb):
    # sRGB 0..255 -> CIE Lab (D65)
    c = rgb.astype(np.float32) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], np.float32)
    xyz = c @ M.T / np.array([0.9505, 1.0, 1.089], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def ycbcr_skin(rgb):
    r, g, b = [rgb[..., i].astype(np.float32) for i in range(3)]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return (cb >= 77) & (cb <= 127) & (cr >= 133) & (cr <= 180) & (y > 35)


def reference_skin(head):
    # the face: the middle of the head map (forehead, cheeks), where the skin rule holds
    h, w = head.shape[:2]
    mid = head[int(h * 0.18):int(h * 0.5), int(w * 0.33):int(w * 0.67)]
    m = ycbcr_skin(mid)
    px = lab(mid[m]) if m.sum() > 200 else lab(mid.reshape(-1, 3))
    return np.median(px, 0)


def hair_reference(others):
    # the hair cards (the cutout maps' opaque texels): their colour, to tell fair hair from skin on the scalp
    px = [np.asarray(im.convert('RGBA').resize((256, 256))) for f, im in others if im.mode == 'RGBA' and 'glasses' not in f]
    px = [p[p[..., 3] > 200][:, :3] for p in px]
    px = np.concatenate(px) if px else np.zeros((0, 3))
    return np.median(lab(px), 0) if len(px) > 200 else None


def skin_mask(rgb, ref, hair=None):
    L = lab(rgb)
    d_ab = np.hypot(L[..., 1] - ref[1], L[..., 2] - ref[2])
    d_l = L[..., 0] - ref[0]
    hue = np.degrees(np.arctan2(L[..., 2], L[..., 1])) - np.degrees(np.arctan2(ref[2], ref[1]))
    # skin in light and shade: its chroma close to the face's (fair hair is yellower), darker allowed more than lighter
    m = (d_ab < 11) & (np.abs(hue) < 13) & (d_l > -38) & (d_l < 16) & ycbcr_skin(rgb)
    if hair is not None:
        w = np.array([0.5, 1, 1], np.float32)
        m &= np.linalg.norm((L - ref) * w, axis=-1) < 0.8 * np.linalg.norm((L - hair) * w, axis=-1)
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))
    # closed (the lips, the brows, the shading of the knuckles are the same person's), then softened
    im = im.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.GaussianBlur(1.2))
    return np.asarray(im).astype(np.float32) / 255.0


def kind(path):
    n = os.path.basename(path).lower()
    return 'body' if '_body_' in n else 'head' if '_head_' in n else 'other'


def pack_others(others, box=256):
    # the cutout and other small maps into the 256 x 256 under the head: shelves, scaled down together until they fit
    for scale in (1 / 8, 1 / 10, 1 / 12, 1 / 16):
        sizes = [(max(16, int(im.width * scale)), max(16, int(im.height * scale))) for _, im in others]
        x = y = shelf = 0; places = []
        ok = True
        for (w, h) in sizes:
            if x + w > box: x = 0; y += shelf; shelf = 0
            if y + h > box or w > box: ok = False; break
            places.append((x, y, w, h)); x += w; shelf = max(shelf, h)
        if ok: return places
    raise RuntimeError('the small maps do not fit')


def build(texdir, out, preview=None):
    files = sorted(glob.glob(os.path.join(texdir, '*_color.tga')))
    body = next(f for f in files if kind(f) == 'body'); head = next(f for f in files if kind(f) == 'head')
    others = [(f, Image.open(f)) for f in files if kind(f) == 'other']
    atlas = np.zeros((H, W, 4), np.uint8)
    rects = {}
    b = np.asarray(Image.open(body).convert('RGB').resize((512, 512), Image.LANCZOS))
    h = np.asarray(Image.open(head).convert('RGB').resize((256, 256), Image.LANCZOS))
    ref = reference_skin(np.asarray(Image.open(head).convert('RGB').resize((512, 512))))
    hair = hair_reference(others)
    for img, (x, y, w) in ((b, (0, 0, 512)), (h, (512, 0, 256))):
        m = skin_mask(img, ref, hair)
        atlas[y:y + w, x:x + w, :3] = img
        atlas[y:y + w, x:x + w, 3] = np.round(CLOTH + (SKIN - CLOTH) * m).astype(np.uint8)
    rects[os.path.basename(body)] = (0, 0, 512, 512); rects[os.path.basename(head)] = (512, 0, 256, 256)
    if others:
        for (f, im), (x, y, w, hh) in zip(others, pack_others(others)):
            rgba = np.asarray(im.convert('RGBA').resize((w, hh), Image.LANCZOS)).copy()
            if im.mode != 'RGBA': rgba[..., 3] = CLOTH  # (an opaque map: a helmet, tools)
            atlas[256 + y:256 + y + hh, 512 + x:512 + x + w] = rgba
            rects[os.path.basename(f)] = (512 + x, 256 + y, w, hh)
    Image.fromarray(atlas, 'RGBA').save(out, 'WEBP', quality=86, alpha_quality=100, method=6)
    if preview:
        # the same person darker: skin times a brown, as the client does
        a = atlas.astype(np.float32)
        skin = np.clip((CLOTH - a[..., 3:4]) / (CLOTH - SKIN), 0, 1)
        skin[256:, 512:] = 0
        tint = np.array([0.62, 0.47, 0.36], np.float32)
        dark = a[..., :3] * (1 - skin + skin * tint)
        Image.fromarray(np.concatenate([atlas[..., :3], dark.astype(np.uint8), (skin[..., 0] * 255).astype(np.uint8)[..., None].repeat(3, -1)], 0)).save(preview, quality=85)
    return rects, ref.tolist()


if __name__ == '__main__':
    rects, ref = build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(rects, [round(v, 1) for v in ref])
