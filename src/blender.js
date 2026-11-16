import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Export for Blender: the room as a .glb (geometry, paint, textures) plus a setup script that recreates
// what the .glb can't carry: the camera, the photographed sky turned to your windows, sky portals in the
// windows, the other lights, white balance, exposure and Cycles render settings.
// Coordinates: three.js is Y-up, Blender Z-up. The glTF importer converts the meshes; the script converts the
// camera and lights the same way, (x, y, z) -> (x, -z, y).

const save = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

export async function exportForBlender({ room, camera, lighting, S, canvas }) {
  // Photos and normal maps go in as JPEG (as they were downloaded); PNG would make the file several times larger.
  room.traverse((o) => {
    if (!o.isMesh) return;
    for (const k of ['map', 'normalMap', 'roughnessMap']) { const t = o.material[k]; if (t) t.userData.mimeType = 'image/jpeg'; }
  });
  const glb = await new GLTFExporter().parseAsync(room, { binary: true, onlyVisible: false, maxTextureSize: 2048 });
  const lights = [];
  lighting.shared.updateMatrixWorld(true);
  const hdr = lighting.exportInfo?.hdr;
  lighting.shared.traverse((l) => {
    if (!l.isLight || (hdr && l.userData.fromSky)) return;
    const base = { matrix: l.matrixWorld.toArray(), color: l.color.toArray(), intensity: l.intensity };
    if (l.isRectAreaLight) lights.push({ ...base, type: l.isCircular ? 'disk' : 'rect', width: l.width, height: l.height });
    else if (l.isDirectionalLight) {
      const d = l.target.getWorldPosition(l.position.clone()).sub(l.getWorldPosition(l.position.clone())).normalize();
      lights.push({ ...base, type: 'sun', dir: d.toArray() });
    }
  });
  const portals = (lighting.lastWindows || []).map((w) => ({ center: w.center.toArray(), normal: w.normal.toArray(), tangent: w.tangent.toArray(), w: w.w, h: w.h }));
  camera.updateMatrixWorld(true);
  const data = {
    camera: { matrix: camera.matrixWorld.toArray(), fov: camera.fov, aspect: canvas.clientWidth && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : camera.aspect || 1.5 },
    sky: lighting.exportInfo, lights, portals,
    exposure: S.light.exposure,
    roomHeight: S.room.h * 0.0254,
  };
  save(new Blob([glb], { type: 'model/gltf-binary' }), 'panel-planner-room.glb');
  setTimeout(() => save(new Blob([blenderScript(data)], { type: 'text/x-python' }), 'panel-planner-blender.py'), 600);
}

export function blenderScript(data) {
  return `# Panel Planner -> Blender setup script.
# Keep this file in the same folder as panel-planner-room.glb (normally your Downloads folder).
# In Blender: Scripting workspace > Open this file > Run Script (the play button). Then press F12 to render.
# Works in Blender 3.0 and newer; 4.2 or newer gives the most accurate colours (Khronos PBR Neutral view).
# It needs an internet connection the first time, to download the sky photo.

import bpy, os, math, json, glob, urllib.request
from mathutils import Matrix, Vector

DATA = json.loads(r'''${JSON.stringify(data)}''')

# three.js (Y up) to Blender (Z up): (x, y, z) -> (x, -z, y)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
def mat(a):   # three.js matrices are stored column by column
    return C @ Matrix([[a[c * 4 + r] for c in range(4)] for r in range(4)])
def vec(a):
    return Vector((a[0], -a[2], a[1]))

def here():
    try:
        t = bpy.context.space_data.text
        if t and t.filepath:
            return os.path.dirname(bpy.path.abspath(t.filepath))
    except Exception:
        pass
    f = globals().get('__file__')
    if f and os.path.isfile(f):
        return os.path.dirname(os.path.abspath(f))
    return os.path.join(os.path.expanduser('~'), 'Downloads')

def find(pattern):
    for d in [here(), os.path.join(os.path.expanduser('~'), 'Downloads')]:
        hits = sorted(glob.glob(os.path.join(d, pattern)), key=os.path.getmtime, reverse=True)
        if hits:
            return hits[0]
    return None

# ---- start from an empty scene ----
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.lights, bpy.data.cameras, bpy.data.materials, bpy.data.images):
    for block in list(coll):
        if block.users == 0:
            coll.remove(block)
scene = bpy.context.scene

# ---- the room ----
glb = find('panel-planner-room*.glb')
if not glb:
    raise SystemExit('Could not find panel-planner-room.glb. Put it in the same folder as this script.')
bpy.ops.import_scene.gltf(filepath=glb)
print('Imported', glb)

# ---- camera ----
cd = bpy.data.cameras.new('Panel Planner camera')
cam = bpy.data.objects.new('Panel Planner camera', cd)
scene.collection.objects.link(cam)
cam.matrix_world = mat(DATA['camera']['matrix'])
cd.sensor_fit = 'VERTICAL'
cd.sensor_height = 24
cd.lens = 12 / math.tan(math.radians(DATA['camera']['fov']) / 2)
cd.clip_start = 0.02
scene.camera = cam
aspect = DATA['camera']['aspect']
long_side = 1920
scene.render.resolution_x = long_side if aspect >= 1 else round(long_side * aspect)
scene.render.resolution_y = round(long_side / aspect) if aspect >= 1 else long_side
scene.render.resolution_percentage = 100

# ---- lights (bulbs, the rooms seen through doorways; window light and sun when there is no sky photo) ----
def add_light(L, i):
    c = [L['color'][k] * L['intensity'] for k in range(3)]
    m = max(max(c), 1e-9)
    if L['type'] == 'sun':
        ld = bpy.data.lights.new('Sun %d' % i, 'SUN')
        ld.energy = m                       # irradiance, the same units as the app
        ld.angle = math.radians(0.53)
        ob = bpy.data.objects.new(ld.name, ld)
        d = vec(L['dir'])
        ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    else:
        ld = bpy.data.lights.new('Light %d' % i, 'AREA')
        if L['type'] == 'disk':
            ld.shape = 'DISK'; ld.size = L['width']; area = math.pi * (L['width'] / 2) ** 2
        else:
            ld.shape = 'RECTANGLE'; ld.size = L['width']; ld.size_y = L['height']; area = L['width'] * L['height']
        ld.energy = m * math.pi * area      # radiance -> watts for a one-sided area light
        ob = bpy.data.objects.new(ld.name, ld)
        ob.matrix_world = mat(L['matrix'])
    ld.color = [x / m for x in c]
    scene.collection.objects.link(ob)

for i, L in enumerate(DATA['lights']):
    add_light(L, i)

# ---- sky ----
world = bpy.data.worlds.new('Panel Planner sky')
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
nt = world.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
out = nt.nodes.new('ShaderNodeOutputWorld')
sky = DATA['sky'] or {}
if sky.get('hdr'):
    path = os.path.join(here(), sky['file'])
    if not os.path.isfile(path):
        for url in (sky['url'], 'https://willlstone.github.io/panel-planner/textures/' + sky['file']):
            try:
                print('Downloading sky photo from', url)
                req = urllib.request.Request(url, headers={'User-Agent': 'panel-planner-blender'})
                with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
                    f.write(r.read())
                break
            except Exception as e:
                print('  failed:', e)
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mapping = nt.nodes.new('ShaderNodeMapping')
    mapping.inputs['Rotation'].default_value[2] = -sky['theta']   # turn the sky the way the app did
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(path)
    # white balance, as in the app: multiply the sky colour (a vector multiply works in every Blender version)
    mix = nt.nodes.new('ShaderNodeVectorMath')
    mix.operation = 'MULTIPLY'
    mix.inputs[1].default_value = sky['wb']
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = sky['strength']
    nt.links.new(coord.outputs['Generated'], mapping.inputs['Vector'])
    nt.links.new(mapping.outputs['Vector'], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], mix.inputs[0])
    nt.links.new(mix.outputs[0], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    # Sky portals: tell Cycles where daylight comes in, so it aims rays at the windows.
    for i, p in enumerate(DATA['portals']):
        ld = bpy.data.lights.new('Window portal %d' % i, 'AREA')
        ld.shape = 'RECTANGLE'; ld.size = p['w']; ld.size_y = p['h']
        for owner in (getattr(ld, 'cycles', None), ld):
            if owner is not None and hasattr(owner, 'is_portal'):
                owner.is_portal = True
        ob = bpy.data.objects.new(ld.name, ld)
        n = vec(p['normal']); t = vec(p['tangent'])
        ob.matrix_world = Matrix.LocRotScale(vec(p['center']), Matrix((t, t.cross(n), -n)).transposed().to_quaternion(), None)   # shines along -Z = into the room
        scene.collection.objects.link(ob)
else:
    # no sky photo (evening): a plain sky, dim for lighting, brighter as seen through the windows
    col = (*sky.get('sky', (0.2, 0.2, 0.3)), 1)
    lp = nt.nodes.new('ShaderNodeLightPath')
    b1 = nt.nodes.new('ShaderNodeBackground'); b1.inputs['Color'].default_value = col; b1.inputs['Strength'].default_value = sky.get('lightStrength', 0.2)
    b2 = nt.nodes.new('ShaderNodeBackground'); b2.inputs['Color'].default_value = col; b2.inputs['Strength'].default_value = sky.get('viewStrength', 1)
    mixs = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(lp.outputs['Is Camera Ray'], mixs.inputs['Fac'])
    nt.links.new(b1.outputs['Background'], mixs.inputs[1])
    nt.links.new(b2.outputs['Background'], mixs.inputs[2])
    nt.links.new(mixs.outputs['Shader'], out.inputs['Surface'])

# ---- render settings ----
scene.render.engine = 'CYCLES'
cy = scene.cycles
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'METAL', 'HIP', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = True
                cy.device = 'GPU'
                print('Rendering on the GPU with', kind)
                break
        except Exception:
            pass
except Exception:
    pass
cy.samples = 1024
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.01
cy.use_denoising = True
cy.max_bounces = 12; cy.diffuse_bounces = 6; cy.glossy_bounces = 6; cy.transmission_bounces = 8
cy.sample_clamp_indirect = 10
vs = scene.view_settings
for name in ('Khronos PBR Neutral', 'AgX', 'Filmic'):
    try:
        vs.view_transform = name
        break
    except Exception:
        pass
try:
    vs.look = 'None'
except Exception:
    pass
vs.exposure = math.log2(max(DATA['exposure'], 1e-3))
print('Panel Planner scene ready. Press F12 to render; Image > Save As to keep the picture.')
`;
}
