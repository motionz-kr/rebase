#!/usr/bin/env python3
"""Finalize Rebase icon v3 (white squircle bg + centered 68% mark) and apply to app.
.icns/favicon = white-bg version; .ico = full-bleed mono mark (legible at 16px)."""
import os, subprocess, math, shutil
import numpy as np
from PIL import Image, ImageDraw

ROOT = "/Users/smlee/projects/product/database"
OUT = f"{ROOT}/design/logo/final3"
TMP = f"{OUT}/_tmp"; os.makedirs(TMP, exist_ok=True)

S=1024; M=100; A=M; Bv=S-M; W=Bv-A; R=round(W*0.2247); cx=cy=S/2
SQRT2=math.sqrt(2); u=(-1/SQRT2,1/SQRT2); p=(1/SQRT2,1/SQRT2)
OFF=118; GAP=42; FRAC=0.68

def f(P): return f'{P[0]:.2f},{P[1]:.2f}'
def sq(x=A,y=A,w=W,h=W,r=R):
    return (f'M{x+r},{y} h{w-2*r} a{r},{r} 0 0 1 {r},{r} v{h-2*r} '
            f'a{r},{r} 0 0 1 -{r},{r} h-{w-2*r} a{r},{r} 0 0 1 -{r},-{r} '
            f'v-{h-2*r} a{r},{r} 0 0 1 {r},-{r} z')
def seam(off=OFF,h=140):
    Ptop=(Bv+120,A-120); Pbot=(A-120,Bv+120)
    J1=(cx-h*u[0],cy-h*u[1]); J2=(cx+h*u[0],cy+h*u[1])
    J1o=(J1[0]+off*p[0],J1[1]+off*p[1]); J2o=(J2[0]+off*p[0],J2[1]+off*p[1])
    Pbo=(Pbot[0]+off*p[0],Pbot[1]+off*p[1])
    return [Ptop,J1,J1o,J2o,Pbo]
SEAM=seam(); DARK_POLY=SEAM+[(Bv+200,Bv+200),(Bv+200,A-200)]
LIGHT_POLY=SEAM+[(A-200,Bv+200),(A-200,A-200)]

DEFS=f'''<defs>
 <linearGradient id="lite" x1="0" y1="0" x2="0.4" y2="1">
  <stop offset="0" stop-color="#93C0FB"/><stop offset="1" stop-color="#5E98F3"/></linearGradient>
 <linearGradient id="dark" x1="0" y1="0" x2="0.4" y2="1">
  <stop offset="0" stop-color="#4C8BEF"/><stop offset="1" stop-color="#2767D8"/></linearGradient>
 <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
  <stop offset="0.4" stop-color="#FFFFFF" stop-opacity="0"/>
  <stop offset="1" stop-color="#0A2A66" stop-opacity="0.10"/></linearGradient>
 <linearGradient id="white" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EEF1F6"/></linearGradient>
 <clipPath id="oclip"><path d="{sq()}"/></clipPath>
 <clipPath id="mclip"><path d="{sq()}"/></clipPath>
 <filter id="fold" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="11" dy="11" stdDeviation="15" flood-color="#102E68" flood-opacity="0.42"/></filter>
 <filter id="seamsh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="3" dy="4" stdDeviation="5" flood-color="#0E2A60" flood-opacity="0.30"/></filter>
 <filter id="marksh" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#243A66" flood-opacity="0.30"/></filter>
 <filter id="outer" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="#9AA6BD" flood-opacity="0.45"/></filter>
</defs>'''

def mark_inner():
    return (f'<g clip-path="url(#mclip)">'
            f'<path d="{sq()}" fill="url(#lite)"/>'
            f'<polygon points="{" ".join(f(P) for P in DARK_POLY)}" fill="url(#dark)"/>'
            f'<polygon points="{" ".join(f(P) for P in LIGHT_POLY)}" fill="url(#lite)" filter="url(#fold)"/>'
            f'<polyline points="{" ".join(f(P) for P in SEAM)}" fill="none" stroke="#FFFFFF" stroke-width="{GAP}" stroke-linejoin="round" stroke-linecap="round" filter="url(#seamsh)"/>'
            f'<polyline points="{" ".join(f(P) for P in SEAM)}" fill="none" stroke="#FFFFFF" stroke-width="{GAP}" stroke-linejoin="round" stroke-linecap="round"/>'
            f'<path d="{sq()}" fill="url(#sheen)"/></g>')

def white_icon(outer=False, bg=None):
    iside=FRAC*W; k=iside/W; ix=(S-iside)/2; iy=(S-iside)/2; tx=ix-A*k; ty=iy-A*k
    rect=f'<rect width="{S}" height="{S}" fill="{bg}"/>' if bg else ''
    wb=(f'<g clip-path="url(#oclip)"><path d="{sq()}" fill="url(#white)"/>'
        f'<path d="{sq()}" fill="none" stroke="#D7DEE8" stroke-width="2" opacity="0.7"/></g>')
    if outer: wb=f'<g filter="url(#outer)">{wb}</g>'
    mark=(f'<g filter="url(#marksh)"><g transform="translate({tx:.2f},{ty:.2f}) scale({k:.5f})">{mark_inner()}</g></g>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">{DEFS}{rect}{wb}{mark}</svg>'

def mono_svg(color):  # full-bleed, cut slash — legible at tiny sizes
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">'
            f'<defs><mask id="cut"><path d="{sq()}" fill="white"/>'
            f'<polyline points="{" ".join(f(P) for P in SEAM)}" fill="none" stroke="black" stroke-width="{GAP}" stroke-linejoin="round" stroke-linecap="round"/></mask></defs>'
            f'<path d="{sq()}" fill="{color}" mask="url(#cut)"/></svg>')

def render_rgba(svg_str):
    def one(bg):
        open(f"{TMP}/_r.svg","w").write(svg_str.replace("</defs>",f"</defs><rect width='{S}' height='{S}' fill='{bg}'/>",1))
        subprocess.run(["qlmanage","-t","-s","1024","-o",TMP,f"{TMP}/_r.svg"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return np.asarray(Image.open(f"{TMP}/_r.svg.png").convert("RGB"),dtype=np.float64)/255
    Wm=one("#FFFFFF"); Bm=one("#000000")
    a=np.clip(1-(Wm-Bm).mean(axis=2),0,1); C=np.zeros_like(Bm); m=a>1e-3
    for c in range(3): C[...,c]=np.where(m,np.clip(Bm[...,c]/np.where(m,a,1),0,1),0)
    return Image.fromarray((np.dstack([C,a])*255).round().astype("uint8"))

# ---- sources ----
SRC={
 "rebase-icon.svg":         white_icon(outer=False),
 "rebase-icon-shadow.svg":  white_icon(outer=True),
 "rebase-icon-onwhite.svg": white_icon(outer=True, bg="#FFFFFF"),
 "rebase-icon-ondark.svg":  white_icon(outer=False, bg="#0E1116"),
 "rebase-mono-blue.svg":    mono_svg("#3F82EE"),
 "rebase-mono-ink.svg":     mono_svg("#1B1F24"),
 "rebase-mono-white.svg":   mono_svg("#FFFFFF"),
}
for n,d in SRC.items(): open(f"{OUT}/{n}","w").write(d)

master=render_rgba(white_icon(outer=False))
print("app-icon corner alpha:", int(np.asarray(master)[4,4,3]))
for s in (1024,512,256,128,64,32,16):
    (master if s==1024 else master.resize((s,s),Image.LANCZOS)).save(f"{OUT}/rebase-{s}.png")

# .icns (white-bg)
iconset=f"{OUT}/rebase.iconset"; shutil.rmtree(iconset,ignore_errors=True); os.makedirs(iconset)
for nm,sz in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),
              ("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),
              ("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)]:
    master.resize((sz,sz),Image.LANCZOS).save(f"{iconset}/{nm}.png")
r=subprocess.run(["iconutil","-c","icns",iconset,"-o",f"{OUT}/rebase.icns"],stderr=subprocess.PIPE)
print("icns:","ok" if r.returncode==0 else r.stderr.decode()[:160])
shutil.rmtree(iconset,ignore_errors=True)

# .ico from full-bleed mono-blue (legible 16/32)
mb=render_rgba(mono_svg("#3F82EE"))
mb.resize((64,64),Image.LANCZOS).save(f"{OUT}/rebase.ico",sizes=[(64,64),(48,48),(32,32),(16,16)])

# preview
def flat(im,bg): b=Image.new("RGB",im.size,bg); b.paste(im,(0,0),im); return b
sw=render_rgba(white_icon(outer=True))
pv=Image.new("RGB",(512*2+40*3,512+40+60),"#EDEFF3"); d=ImageDraw.Draw(pv)
pv.paste(flat(sw.resize((512,512),Image.LANCZOS),"#FFFFFF"),(40,40))
pv.paste(flat(master.resize((512,512),Image.LANCZOS),"#0E1116"),(512+80,40))
d.text((50,512+50),"on light",fill="#222"); d.text((512+90,512+50),"on dark",fill="#bbb")
pv.save(f"{OUT}/preview.png")

# ---- apply to app ----
shutil.copy(f"{OUT}/rebase.icns", f"{ROOT}/apps/desktop/build/icon.icns")
shutil.copy(f"{OUT}/rebase.ico",  f"{ROOT}/apps/desktop/build/icon.ico")
shutil.copy(f"{OUT}/rebase-1024.png", f"{ROOT}/apps/desktop/build/icon.png")
shutil.copy(f"{OUT}/rebase-icon.svg", f"{ROOT}/apps/renderer/public/favicon.svg")
shutil.rmtree(TMP,ignore_errors=True)
print("APPLIED to app build/ + favicon")
print("FILES:",sorted(p for p in os.listdir(OUT) if not p.startswith('_')))
