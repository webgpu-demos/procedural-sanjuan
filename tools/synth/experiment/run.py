#!/usr/bin/env python3
"""Trains and scores every condition prepare.py set up, then tabulates. Resumable: a condition with a result is
skipped, so a run can be stopped and started again.

    python run.py --exp runs/exp1 --model yolo11n.pt --epochs 60 --imgsz 1024 --device 0
    python run.py --exp runs/exp1 --finetune          # also: pretrain on synthetic alone, fine-tune on real

Each condition: train (Ultralytics YOLO, weights picked on REAL val), then score the best weights on REAL test.
results.csv gets one row per condition and summary.md the tables: mAP50-95 and mAP50 by real share x synthetic
ratio (mean and spread over seeds), the same per class, and the gain over the real-only baseline. With --budget,
epochs are set per condition so every condition sees about the same number of images (a condition with fewer
frames otherwise also trains for fewer steps, which is not what is being measured).
"""
import argparse
import csv
import json
import math
import os
import re
import statistics
import sys
import time

FIELDS = ['name', 'real_frac', 'synth', 'seed', 'mode', 'real_train', 'synth_train', 'epochs', 'map50_95', 'map50', 'precision', 'recall', 'per_class_map50_95', 'seconds', 'weights']


def train_and_score(c, a, init, name, mode, epochs):
    from ultralytics import YOLO
    t0 = time.time()
    model = YOLO(init)
    model.train(data=c['data'], epochs=epochs, imgsz=a.imgsz, batch=a.batch, device=a.device, seed=c['seed'], deterministic=True,
                project=os.path.join(a.exp, 'runs'), name=name, exist_ok=True, patience=a.patience, workers=a.workers, plots=False, verbose=False)
    best = os.path.join(a.exp, 'runs', name, 'weights', 'best.pt')
    if not os.path.exists(best):
        best = os.path.join(a.exp, 'runs', name, 'weights', 'last.pt')
    m = YOLO(best).val(data=c['data'], split='test', imgsz=a.imgsz, batch=a.batch, device=a.device, plots=False, verbose=False,
                        project=os.path.join(a.exp, 'runs'), name=name + '_test', exist_ok=True)
    names = json.load(open(os.path.join(a.exp, 'experiment.json')))['classes']
    per = {names[i]: round(float(v), 4) for i, v in enumerate(m.box.maps) if i < len(names)}
    return {'name': name, 'real_frac': c['real_frac'], 'synth': c['synth'], 'seed': c['seed'], 'mode': mode, 'real_train': c['real_train'], 'synth_train': c['synth_train'],
            'epochs': epochs, 'map50_95': round(float(m.box.map), 4), 'map50': round(float(m.box.map50), 4), 'precision': round(float(m.box.mp), 4), 'recall': round(float(m.box.mr), 4),
            'per_class_map50_95': json.dumps(per), 'seconds': round(time.time() - t0), 'weights': best}


def summarise(exp, rows):
    def cell(vals):
        if not vals:
            return ''
        return f'{statistics.mean(vals):.3f}' + (f' ± {statistics.stdev(vals):.3f}' if len(vals) > 1 else '')
    out = ['# Synthetic data experiment', '', f'{len(rows)} runs. Scores on the REAL test frames only (weights picked on real val). ± = standard deviation over seeds.', '']
    meta = json.load(open(os.path.join(exp, 'experiment.json')))
    out += [f'Classes: {", ".join(meta["classes"])}. Real frames train/val/test: {meta["frames"]["train"]}/{meta["frames"]["val"]}/{meta["frames"]["test"]} '
            f'({meta["flights"]["train"]}/{meta["flights"]["val"]}/{meta["flights"]["test"]} flights). Synthetic frames available: {meta["synth_frames"]}.', '']
    rs = [r for r in rows if r['mode'] == 'scratch']
    fracs = sorted({float(r['real_frac']) for r in rs})
    ratios = sorted({r['synth'] for r in rs}, key=lambda s: (s == 'only', float(s) if s != 'only' else 0))
    mixed = [s for s in ratios if s not in ('0', 'only')]
    for metric in ('map50_95', 'map50'):
        out += [f'## {metric}', '', '| real share | ' + ' | '.join('real only' if s == '0' else 'synthetic only' if s == 'only' else f'+ {s} synthetic per real' for s in ratios) + ' |', '|---|' + '---|' * len(ratios)]
        for f in fracs:
            out.append(f'| {f:g} | ' + ' | '.join(cell([float(r[metric]) for r in rs if float(r['real_frac']) == f and r['synth'] == s]) for s in ratios) + ' |')
        out.append('')
    base = {(float(r['real_frac']), r['seed']): float(r['map50_95']) for r in rs if r['synth'] == '0'}
    if mixed and base:
        out += ['## gain in map50_95 over real only (paired by seed)', '', '| real share | ' + ' | '.join(f'+ {s} synthetic per real' for s in mixed) + ' |', '|---|' + '---|' * len(mixed)]
        for f in fracs:
            if f == 0:
                continue
            out.append(f'| {f:g} | ' + ' | '.join(cell([float(r['map50_95']) - base[(f, r['seed'])] for r in rs if float(r['real_frac']) == f and r['synth'] == s and (f, r['seed']) in base]) for s in mixed) + ' |')
        out.append('')
    ft = [r for r in rows if r['mode'] == 'finetune']
    if ft and base:
        out += ['## pretrained on synthetic only, then fine-tuned on the real share (map50_95)', '', '| real share | real only | fine-tuned | gain (paired by seed) |', '|---|---|---|---|']
        for f in sorted({float(r['real_frac']) for r in ft}):
            sel = [r for r in ft if float(r['real_frac']) == f]
            out.append(f'| {f:g} | {cell([base[(f, r["seed"])] for r in sel if (f, r["seed"]) in base])} | {cell([float(r["map50_95"]) for r in sel])} | '
                       f'{cell([float(r["map50_95"]) - base[(f, r["seed"])] for r in sel if (f, r["seed"]) in base])} |')
        out.append('')
    classes = meta['classes']
    out += ['## map50_95 per class', '', '| real share | training | ' + ' | '.join(classes) + ' |', '|---|---|' + '---|' * len(classes)]
    for mode, group in (('scratch', rs), ('finetune', ft)):
        for f in sorted({float(r['real_frac']) for r in group}):
            for s in ratios:
                sel = [json.loads(r['per_class_map50_95']) for r in group if float(r['real_frac']) == f and r['synth'] == s]
                if sel:
                    lab = 'fine-tuned' if mode == 'finetune' else 'real only' if s == '0' else 'synthetic only' if s == 'only' else f'+ {s} synthetic per real'
                    out.append(f'| {f:g} | {lab} | ' + ' | '.join(cell([p.get(c, 0.0) for p in sel]) for c in classes) + ' |')
    n_test = meta.get('instances_per_class', {}).get('real_test', {})
    out += ['', 'Instances in the real test frames: ' + ', '.join(f'{c} {n_test.get(c, "?")}' for c in classes) + '. A class with none there gets the mean of the others '
            '(Ultralytics), so its column says nothing.', '']
    open(os.path.join(exp, 'summary.md'), 'w').write('\n'.join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--exp', required=True)
    ap.add_argument('--model', default='yolo11n.pt', help='starting weights (COCO-pretrained by default)')
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--budget', type=int, default=0, help='images seen per condition: epochs = budget / training frames, within 10..300')
    ap.add_argument('--imgsz', type=int, default=1024)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--device', default='0', help='"0" for the first GPU, "cpu", "mps" on a Mac')
    ap.add_argument('--patience', type=int, default=20)
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--only', default=None, help='regular expression on condition names')
    ap.add_argument('--finetune', action='store_true', help='also: weights from the synthetic-only run of the seed, fine-tuned on the real share')
    a = ap.parse_args()
    a.exp = os.path.abspath(a.exp)
    meta = json.load(open(os.path.join(a.exp, 'experiment.json')))
    res = os.path.join(a.exp, 'results.csv')
    rows = list(csv.DictReader(open(res))) if os.path.exists(res) else []
    done = {(r['name'], r['mode']) for r in rows}
    conds = [c for c in meta['conditions'] if not a.only or re.search(a.only, c['name'])]
    # synthetic-only first: the fine-tuning runs start from it
    conds.sort(key=lambda c: (c['synth'] != 'only', c['seed'], c['real_frac'], c['synth']))
    plan = [(c, 'scratch') for c in conds]
    if a.finetune:
        plan += [(c, 'finetune') for c in conds if c['synth'] == '0' and c['real_frac'] > 0]
    for c, mode in plan:
        name = c['name'] + ('' if mode == 'scratch' else '_ft')
        if (name, mode) in done:
            continue
        n = c['real_train'] + c['synth_train']
        epochs = max(10, min(300, math.ceil(a.budget / max(1, n)))) if a.budget else a.epochs
        init = a.model
        if mode == 'finetune':
            src = next((r for r in rows if r['synth'] == 'only' and int(r['seed']) == c['seed'] and r['mode'] == 'scratch'), None)
            if not src:
                print(f'{name}: no synthetic-only run for seed {c["seed"]} yet; skipped', file=sys.stderr)
                continue
            init = src['weights']
        print(f'== {name} ({mode}): {c["real_train"]} real + {c["synth_train"]} synthetic frames, {epochs} epochs, from {init}', flush=True)
        r = train_and_score(c, a, init, name, mode, epochs)
        print(f'   test mAP50-95 {r["map50_95"]}  mAP50 {r["map50"]}  ({r["seconds"]} s)', flush=True)
        rows.append({k: str(v) for k, v in r.items()})
        with open(res, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            w.writeheader(); w.writerows(rows)
        summarise(a.exp, rows)
    if rows:
        summarise(a.exp, rows)
        print(open(os.path.join(a.exp, 'summary.md')).read())


if __name__ == '__main__':
    main()
