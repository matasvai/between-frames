"""Render simulation data as an animated explainer, not a screenshot of the app.
Requires Pillow; usage: python3 render_preview.py [node-executable]
"""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
node = sys.argv[1] if len(sys.argv) > 1 else "node"
script = "const C=require(" + json.dumps(str(root / "engine.js")) + ");const e=C.runEpisode(C.DEFAULT_CONFIG,C.createStudent());console.log(JSON.stringify({world:C.WORLD,episode:e},(k,v)=>v instanceof Uint8Array?Array.from(v):v));"
data = json.loads(subprocess.check_output([node, "-e", script]))
episode, world = data["episode"], data["world"]
out = root / "dist"
out.mkdir(exist_ok=True)
font_path = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf"
def font(size):
    try:
        return ImageFont.truetype(font_path, size)
    except OSError:
        return ImageFont.load_default(size=size)

def point(p):
    return (40 + p["x"] / world["width"] * 530, 384 - p["y"] / world["height"] * 270)

def path(draw, positions, color, width, dash=0):
    points = [point(p) for p in positions]
    if len(points) > 1:
        if not dash:
            draw.line(points, fill=color, width=width)
        else:
            for i in range(len(points)-1):
                if i % dash == 0:
                    draw.line(points[i:i+2], fill=color, width=width)

def render(t):
    im = Image.new("RGB", (960, 570), "#e8e8e8")
    d = ImageDraw.Draw(im)
    d.text((30, 20), "BETWEEN FRAMES", font=font(31), fill="#1e1e1e")
    d.text((30, 61), "Simulation-data preview · true motion is revealed to the viewer only", font=font(15), fill="#595959")
    d.rectangle((28, 99, 585, 405), fill="#f4f4f4", outline="#a0a0a0")
    for x in (0, .5, 1, 1.5):
        px, _ = point({"x": x, "y": 0})
        d.line((px, 114, px, 384), fill="#dedede")
        d.text((px, 389), str(x), font=font(11), fill="#595959")
    wall_x, _ = point({"x": world["wallX"], "y": 0})
    d.line((wall_x, 113, wall_x, 384), fill="#303030", width=3)
    d.text((wall_x - 45, 118), "wall", font=font(13), fill="#595959")
    if t >= episode["freezeTime"]:
        path(d, episode["forecast"], "#797979", 2, 2)
    if episode["correctionTime"] is not None and t >= episode["correctionTime"]:
        path(d, episode["correctedForecast"], "#595959", 3, 3)
    actual = [p for p in episode["truth"] if p["t"] <= t]
    path(d, actual, "#1e1e1e", 3)
    if actual:
        x,y = point(actual[-1]); r=world["radius"]/world["width"]*530
        d.ellipse((x-r,y-r,x+r,y+r),fill="#1e1e1e")
    d.text((620, 103), "CAMERA INPUT / 96 × 64", font=font(17), fill="#1e1e1e")
    eligible = [f for f in episode["frames"] if f["t"] <= t]
    received = [f for f in eligible if f["pixels"]]
    missing = bool(eligible and eligible[-1]["dropped"])
    if received:
        frame = Image.frombytes("L", (96,64), bytes(received[-1]["pixels"]))
        frame = frame.resize((288,192), Image.Resampling.NEAREST).convert("RGB")
        im.paste(frame,(620,143))
    else:
        d.rectangle((620,143,908,335),fill="#1e1e1e")
    if missing:
        d.rectangle((636,220,891,257),fill="#e8e8e8")
        d.text((656,228),"NO NEW FRAME",font=font(20),fill="#1e1e1e")
    caption = "Impact hidden / previous image held" if missing else "Timestamped pixels only"
    d.text((620,350), caption, font=font(14), fill="#595959")
    d.text((620,378), f"Time {t:.2f}s   Frames {len(received)}/{len(episode['frames'])}", font=font(15), fill="#1e1e1e")
    if t < episode["freezeTime"]:
        message = "Observe the incoming motion."
    elif episode["correctionTime"] is None or t < episode["correctionTime"]:
        message = "Forecast frozen. The edge model has not seen the rebound yet."
    else:
        message = "Rebound observed. Estimate outgoing velocity; update the future path."
    d.text((30,434),message,font=font(19),fill="#1e1e1e")
    d.text((30,475),"Solid: actual motion     Dashed: pre-impact prediction     Dotted: updated prediction",font=font(15),fill="#595959")
    if t >= episode["duration"]:
        d.text((30,518),f"Frozen post-impact RMSE: {episode['metrics']['frozenError']*100:.1f} cm    |    Updated future RMSE: {episode['metrics']['correctedError']*100:.1f} cm",font=font(17),fill="#1e1e1e")
    else:
        d.text((30,518),"Final error stays hidden until the outcome is revealed.",font=font(16),fill="#595959")
    return im

frames = [render(i*episode["duration"]/70) for i in range(71)]
frames[-1].save(out / "between-frames-preview.png")
frames[0].save(out / "between-frames-preview.gif", save_all=True, append_images=frames[1:], duration=[90]*70+[2400], loop=0, optimize=True)
print(out / "between-frames-preview.gif")
