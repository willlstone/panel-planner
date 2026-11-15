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
- Baseboard and crown profiles, paint colours and sheens
- Scanned wood floors, tinted to match your real floor
- Soft daylight, direct sun or evening lighting
- A cut list of box sizes and moulding lengths

Lengths are in inches. Click the number beside any slider to type an exact measurement.

## Design files

**Export design** (bottom of the side panel) saves the whole room and design as a `.json` file. **Import design** loads one, on this or any other computer. `designs/dining-room.json` is the starting room.

## Credits

Floor textures are from [Poly Haven](https://polyhaven.com) (CC0). Rendering uses [three.js](https://threejs.org) and [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer).
