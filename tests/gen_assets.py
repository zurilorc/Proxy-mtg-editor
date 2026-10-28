# Génère des cartes synthétiques (cadre + art + texte) et leurs art_crop pour tester l'app hors ligne.
import random, math, json, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
out = sys.argv[1]
import os
os.makedirs(out, exist_ok=True)
random.seed(4)

def painting(w, h, seed):
    rnd = random.Random(seed)
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    c1 = (rnd.randint(20,120), rnd.randint(20,120), rnd.randint(60,200))
    c2 = (rnd.randint(150,255), rnd.randint(80,200), rnd.randint(20,120))
    for y in range(h):
        t = y / h
        d.line([(0,y),(w,y)], fill=tuple(int(c1[i]*(1-t)+c2[i]*t) for i in range(3)))
    for _ in range(40):
        x, y = rnd.randint(0,w), rnd.randint(0,h); r = rnd.randint(10, w//4)
        col = (rnd.randint(0,255), rnd.randint(0,255), rnd.randint(0,255))
        d.ellipse([x-r,y-r,x+r,y+r], fill=col)
    img = img.filter(ImageFilter.GaussianBlur(3))
    d = ImageDraw.Draw(img)
    for _ in range(25):
        x, y = rnd.randint(0,w), rnd.randint(0,h)
        d.line([(x,y),(x+rnd.randint(-80,80), y+rnd.randint(-80,80))], fill=(rnd.randint(0,255),)*3, width=rnd.randint(1,5))
    return img

def card(rect, art, frame_color, border=(12,12,12), W=745, H=1040):
    img = Image.new('RGBA', (W, H), (0,0,0,0))
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0,0,W-1,H-1], radius=36, fill=255)
    base = Image.new('RGBA', (W, H), border + (255,))
    d = ImageDraw.Draw(base)
    d.rounded_rectangle([26,26,W-27,H-60], radius=14, fill=frame_color)
    # barre de titre
    d.rounded_rectangle([40,42,W-41,100], radius=10, fill=(230,225,210))
    d.text((60,58), "Synthetic Card", fill=(0,0,0))
    x,y,w,h = rect
    base.paste(art.resize((w,h)), (x,y))
    d.rectangle([x-1,y-1,x+w,y+h], outline=(0,0,0), width=1)
    # ligne de type + boîte de texte
    d.rounded_rectangle([40,y+h+8,W-41,y+h+60], radius=10, fill=(230,225,210))
    d.rectangle([52,y+h+70,W-53,H-110], fill=(240,235,222))
    for i in range(6):
        d.line([(70, y+h+95+i*32),(W-90-random.randint(0,200), y+h+95+i*32)], fill=(40,40,40), width=3)
    d.text((40,H-50), "123/280 R  SYN • EN  Artist Name", fill=(220,220,220))
    img.paste(base, (0,0), mask)
    return img

specs = {
  # id: (rect, frame color, art seed, art_crop scale)
  'm15':   ((59,118,627,459), (150,110,70,255), 1, 1.0),
  'm15fr': ((59,118,627,459), (150,110,70,255), 1, 1.0),
  'old':   ((86,102,573,450), (80,120,160,255), 2, 1.37),
  'bless': ((0,0,745,700), (0,0,0,255), 3, 1.0),
}
meta = {}
for cid, (rect, fc, seed, scale) in specs.items():
    art = painting(rect[2], rect[3], seed)
    c = card(rect, art, fc)
    c.save(f'{out}/{cid}.png')
    c.convert('RGB').save(f'{out}/{cid}.jpg', quality=88)
    # art_crop : léger rognage de 3 px comme Scryfall, éventuellement à une autre échelle
    x,y,w,h = rect
    crop = c.convert('RGB').crop((x+3, y+3, x+w-3, y+h-3))
    crop = crop.resize((round(crop.width*scale), round(crop.height*scale)))
    crop.save(f'{out}/{cid}_art.jpg', quality=85)
    meta[cid] = {'rect': [x+3, y+3, w-6, h-6]}

# photo utilisateur 3000x2000 : grand cercle rouge sur fond bleu + damier
p = Image.new('RGB', (3000, 2000), (30, 80, 200))
d = ImageDraw.Draw(p)
for i in range(0, 3000, 200):
    for j in range(0, 2000, 200):
        if (i//200 + j//200) % 2 == 0: d.rectangle([i,j,i+199,j+199], fill=(40,100,220))
d.ellipse([1000,500,2000,1500], fill=(220,30,30))
d.text((1300,950), "PHOTO", fill=(255,255,255))
p.save(f'{out}/photo.jpg', quality=90)
# "résultat IA" : dégradé vert/jaune avec étoile
g = Image.new('RGB', (1184, 864), (20,140,60))
d = ImageDraw.Draw(g)
for k in range(0, 864, 4): d.line([(0,k),(1184,k)], fill=(20+k//6, 140, 60+k//10))
d.polygon([(592,100),(700,400),(1000,420),(760,600),(840,820),(592,690),(344,820),(424,600),(184,420),(484,400)], fill=(250,220,40))
g.save(f'{out}/ai.png')
json.dump(meta, open(f'{out}/meta.json','w'))
print(meta)
