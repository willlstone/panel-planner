# Panel Planner

Design wall paneling, wainscoting, chair rails and trim in a 3D model of your own room, rendered with a GPU path tracer so the light and shadow on the mouldings look real.

## Run it

The app is static files, but browsers will not load it from `file://`, so it needs a local web server. It also needs an internet connection, because the 3D libraries load from a CDN.

**Windows:** double-click `start.bat` (needs Python).

**Mac / Linux:**

```bash
cd panel-planner
python3 -m http.server 8173
```

Then open http://localhost:8173/index.html.

## What you can set

- Room size, a tray ceiling, and any number of windows, doors and doorless doorways (optionally with angled top corners) on each wall
- Chair rail height and profile; trim boxes above and below it with width, rhythm, spacing and moulding profile; shaker panels or beadboard below the rail
- Wall texture from a scanned painted wall (Poly Haven Beige Wall 001), recoloured to your paint: Smooth, Light or Textured
- Path tracing quality: Standard, High or Max, with time left shown
- Baseboard and crown profiles, paint colours and sheens; box panels, window and door trim, baseboard, crown and chair rail can each be the trim colour, the wall colour or their own colour
- Scanned wood floors, tinted to match your real floor
- Daylight from photographed HDRI skies (overcast or sunny), turned to the way your windows face; evening light from bulbs of a chosen colour temperature; white balance like your eye or uncorrected
- A cut list of box sizes and moulding lengths
- Light switches and outlets, placed on a straight-on view of each wall with live distances to corners, doors, windows, trim and the floor
- A measuring tool: click two points on the walls; measurements are always level or plumb
- Three render modes: Fast preview; Baked, where the light is path-traced once into the room (about 20 seconds) and you can then move the camera instantly (matte, no reflections); and Photoreal (path traced), the most accurate, which re-renders after each move. The app always opens in Fast
- Crown moulding inside a tray ceiling
- Walk mode for composing photos: drag to look, W A S D or arrow keys to move, Q / E to lower or raise the camera

Lengths are in inches. Click the number beside any slider to type an exact measurement.

## Render in Blender

For the most realistic pictures, the Design tab's **Export for Blender…** button (at the bottom of the panel) saves two files: `panel-planner-room.glb` (the room, paint and textures) and `panel-planner-blender.py` (camera, sky photo turned to your windows, window portals, lights, white balance and Cycles render settings). Keep them in the same folder, then:

1. Install Blender 4.2 or newer (3.0 and up works, with less accurate colours) from https://www.blender.org/download/ and open it (File > New > General).
2. Click the **Scripting** tab, then **Open** in the text editor and choose `panel-planner-blender.py`.
3. Click **Run Script** (▶). The first run downloads the sky photo from Poly Haven (about 5 MB).
4. Press **F12** (Render > Render Image). When it finishes, Image > Save As.

On a recent computer with its graphics card switched on (Edit > Preferences > System > Cycles Render Devices) a full-size render takes a few minutes.

## Design files

**Export design** (bottom of the side panel) saves the whole room and design as a `.json` file. **Import design** loads one, on this or any other computer. `designs/dining-room.json` is the starting room.

## Credits

Floor textures are from [Poly Haven](https://polyhaven.com) (CC0). Rendering uses [three.js](https://threejs.org) and [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer).
