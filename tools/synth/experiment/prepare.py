#!/usr/bin/env python3
"""Sets up the experiment: do synthetic images from procedural-sanjuan help a detector on real drone frames?

Everything is judged on REAL frames only. Your real frames are split once, by flight (so near-identical frames of
one flight never sit on both sides), into train / val / test. Each condition trains on a share of the real training
frames plus some number of synthetic frames per real one, picks its weights on real val, and is scored on real test:

    real_frac   share of the real training frames used (0.1, 0.25, 0.5, 1): synthetic data matter most when real
                labels are few, so the curve over this is the result
    synth       synthetic frames per real training frame (0 = the baseline), or "only" (no real frames at all:
                how far the synthetic images get by themselves)
    seed        each condition several times; the spread says how much of a difference is noise

Real data: YOLO format, <real>/images/**/<name>.jpg|png with <real>/labels/**/<name>.txt (class cx cy w h,
normalised), and the names of its classes in index order (--real-names). Synthetic data: one or more exports of
tools/synth/export.mjs (classes building, blue_tarp, debris, vehicle). The classes compared are those in both
(--classes to choose); labels are rewritten to that list in <exp>/pool, images linked, nothing copied twice.

    python prepare.py --real ~/drone/labelled --real-names building,blue_tarp --synth data/synth/sj \\
        --group '^([^_]+)_' --out runs/exp1

Then: python run.py --exp runs/exp1 (needs ultralytics; see README.md).
"""
import argparse
import json
import os
import random
import re
import sys
from collections import defaultdict

SYNTH_NAMES = ['building', 'blue_tarp', 'debris', 'vehicle']
IMG = ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp')


def find_pairs(root):
    """(image path, label path or None) for every image under root/images, matched by name under root/labels."""
    labels = {}
    for d, _, files in os.walk(os.path.join(root, 'labels')):
        for f in files:
            if f.endswith('.txt'):
                labels.setdefault(os.path.splitext(f)[0], os.path.join(d, f))
    out = []
    for d, _, files in os.walk(os.path.join(root, 'images')):
        for f in sorted(files):
            if f.lower().endswith(IMG):
                out.append((os.path.abspath(os.path.join(d, f)), labels.get(os.path.splitext(f)[0])))
    return sorted(out)


def remap(src, names_from, keep, dst):
    """Rewrites a YOLO label file to the class list `keep`; returns the number of boxes kept."""
    n = 0
    lines = []
    if src and os.path.exists(src):
        for line in open(src):
            p = line.split()
            if len(p) < 5:
                continue
            c = int(float(p[0]))
            if c < 0 or c >= len(names_from) or names_from[c] not in keep:
                continue
            lines.append(' '.join([str(keep.index(names_from[c]))] + p[1:]))
            n += 1
    with open(dst, 'w') as f:
        f.write('\n'.join(lines) + ('\n' if lines else ''))
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--real', required=True)
    ap.add_argument('--real-names', required=True, help='class names of the real labels, in index order, comma-separated')
    ap.add_argument('--synth', required=True, nargs='+', help='export directories of tools/synth/export.mjs')
    ap.add_argument('--classes', default=None, help='classes to train and score (default: those in both)')
    ap.add_argument('--group', default=None, help='regular expression whose first group is a frame\'s flight id (split by flight)')
    ap.add_argument('--split', default='0.6,0.2,0.2', help='real train,val,test shares (of flights)')
    ap.add_argument('--real-fracs', default='0.1,0.25,0.5,1')
    ap.add_argument('--synth-ratios', default='0,1,4,only', help='synthetic frames per real training frame; "only" = synthetic alone')
    ap.add_argument('--seeds', default='0,1,2')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    real_names = [s.strip() for s in a.real_names.split(',')]
    keep = [s.strip() for s in a.classes.split(',')] if a.classes else [n for n in real_names if n in SYNTH_NAMES]
    if not keep:
        sys.exit(f'no class in common: real {real_names}, synthetic {SYNTH_NAMES}; pass --classes and name the real ones to match')
    out = os.path.abspath(a.out)
    pool_i, pool_l = os.path.join(out, 'pool', 'images'), os.path.join(out, 'pool', 'labels')
    os.makedirs(pool_i, exist_ok=True); os.makedirs(pool_l, exist_ok=True)
    os.makedirs(os.path.join(out, 'lists'), exist_ok=True)

    def add(prefix, img, lab, names_from):
        name = f'{prefix}__{os.path.splitext(os.path.basename(img))[0]}'
        ext = os.path.splitext(img)[1].lower()
        link = os.path.join(pool_i, name + ext)
        if not os.path.lexists(link):
            os.symlink(img, link)
        n = remap(lab, names_from, keep, os.path.join(pool_l, name + '.txt'))
        return link, n

    # real frames, split by flight
    real = find_pairs(a.real)
    if not real:
        sys.exit(f'no images under {a.real}/images')
    rx = re.compile(a.group) if a.group else None
    groups = defaultdict(list)
    boxes_real = 0
    for img, lab in real:
        g = os.path.basename(img)
        if rx:
            m = rx.search(g)
            g = m.group(1) if m else g
        link, n = add('real', img, lab, real_names)
        boxes_real += n
        groups[g].append(link)
    if not rx:
        print('note: no --group: frames are split one by one; frames of one flight can land in train and test, which flatters every condition', file=sys.stderr)
    names = sorted(groups)
    random.Random(12345).shuffle(names)
    fr = [float(x) for x in a.split.split(',')]
    n1, n2 = round(len(names) * fr[0] / sum(fr)), round(len(names) * (fr[0] + fr[1]) / sum(fr))
    if len(names) >= 3:  # (at least one flight each for val and test)
        n1 = max(1, min(n1, len(names) - 2))
        n2 = max(n1 + 1, min(n2, len(names) - 1))
    split = {'train': names[:n1], 'val': names[n1:n2], 'test': names[n2:]}
    lists = {k: sorted(p for g in v for p in groups[g]) for k, v in split.items()}
    for k in ('val', 'test'):
        if not lists[k]:
            sys.exit(f'real {k} is empty: more flights (or frames, without --group) are needed')
        open(os.path.join(out, 'lists', f'real_{k}.txt'), 'w').write('\n'.join(lists[k]) + '\n')

    # synthetic frames (train and val of each export alike: only real frames are ever used to judge)
    synth = []
    boxes_synth = 0
    for k, d in enumerate(a.synth):
        for img, lab in find_pairs(d):
            link, n = add(f'syn{k}', img, lab, SYNTH_NAMES)
            boxes_synth += n
            synth.append(link)
    if not synth:
        sys.exit('no synthetic images found')

    def yaml(name, train_list):
        p = os.path.join(out, 'data', f'{name}.yaml')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write(f'# {name}\npath: {out}\ntrain: {train_list}\nval: {os.path.join(out, "lists", "real_val.txt")}\ntest: {os.path.join(out, "lists", "real_test.txt")}\nnames:\n')
            f.writelines(f'  {i}: {n}\n' for i, n in enumerate(keep))
        return p

    conds = []
    seeds = [int(s) for s in a.seeds.split(',')]
    for seed in seeds:
        r = random.Random(seed)
        tr = lists['train'][:]
        r.shuffle(tr)
        syn = synth[:]
        r.shuffle(syn)
        for ratio in a.synth_ratios.split(','):
            fracs = [0.0] if ratio == 'only' else [float(x) for x in a.real_fracs.split(',')]
            for frac in fracs:
                nr = max(1, round(len(tr) * frac)) if frac > 0 else 0
                ns = len(syn) if ratio == 'only' else min(len(syn), round(nr * float(ratio)))
                if ratio != 'only' and float(ratio) > 0 and ns < round(nr * float(ratio)):
                    print(f'note: real_frac {frac} synth {ratio}: only {ns} synthetic frames for {round(nr * float(ratio))} wanted', file=sys.stderr)
                name = f'real{frac:g}_synth{ratio}_seed{seed}'
                lst = os.path.join(out, 'lists', f'{name}.txt')
                open(lst, 'w').write('\n'.join(tr[:nr] + syn[:ns]) + '\n')
                conds.append({'name': name, 'real_frac': frac, 'synth': ratio, 'seed': seed, 'real_train': nr, 'synth_train': ns, 'data': yaml(name, lst)})
    def count(paths):
        n = [0] * len(keep)
        for p in paths:
            lab = os.path.join(pool_l, os.path.splitext(os.path.basename(p))[0] + '.txt')
            for line in open(lab):
                if line.strip():
                    n[int(line.split()[0])] += 1
        return dict(zip(keep, n))
    meta = {'instances_per_class': {**{f'real_{k}': count(v) for k, v in lists.items()}, 'synthetic': count(synth)},
            'classes': keep, 'real_names': real_names, 'real': os.path.abspath(a.real), 'synth': [os.path.abspath(d) for d in a.synth],
            'group': a.group, 'flights': {k: len(v) for k, v in split.items()}, 'frames': {k: len(v) for k, v in lists.items()},
            'boxes': {'real': boxes_real, 'synth': boxes_synth}, 'synth_frames': len(synth), 'conditions': conds}
    json.dump(meta, open(os.path.join(out, 'experiment.json'), 'w'), indent=1)
    print(f'{len(conds)} conditions; real frames train/val/test {len(lists["train"])}/{len(lists["val"])}/{len(lists["test"])} '
          f'({len(names)} flights); synthetic frames {len(synth)}; classes {keep} -> {out}/experiment.json')


if __name__ == '__main__':
    main()
